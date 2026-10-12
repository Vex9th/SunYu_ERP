package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReviewDocumentRejectsDuplicateIdempotencyHeader(t *testing.T) {
	s := coreFixture(t)
	coreSeedProject(t, s)
	RegisterDocuments(s)
	body, contentType := documentMultipart(t, map[string]string{"title": "duplicate header", "category": "other"}, "sample.txt", "content")
	r := httptest.NewRequest("POST", "/api/projects/TEST/documents", bytes.NewReader(body))
	r.Header.Set("Content-Type", contentType)
	r.Header.Add("Idempotency-Key", "12345678-1234-1234-1234-123456789abc")
	r.Header.Add("Idempotency-Key", "22345678-1234-1234-1234-123456789abc")
	r.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 422 {
		t.Fatalf("duplicate headers must be rejected before upload: %d %s", w.Code, w.Body.String())
	}
	var n int
	if err := s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&n); err != nil || n != 0 {
		t.Fatal("ambiguous idempotency key created a document", n, err)
	}
}

func TestReviewDocumentAcceptsLegacyStringRevision(t *testing.T) {
	s := coreFixture(t)
	coreSeedProject(t, s)
	RegisterDocuments(s)
	data, ct := documentMultipart(t, map[string]string{"title": "old", "category": "other"}, "sample.txt", "content")
	created := coreRequest(s, "POST", "/api/projects/TEST/documents", bytes.NewReader(data), ct)
	if created.Code != 201 {
		t.Fatal(created.Code, created.Body.String())
	}
	updated := coreRequest(s, "PUT", "/api/projects/TEST/documents/1", strings.NewReader(`{"title":"new","notes":null,"expected_revision":"1"}`), "application/json")
	if updated.Code != 200 {
		t.Fatalf("legacy documents API accepts decimal revision strings: %d %s", updated.Code, updated.Body.String())
	}
}

func TestReviewDocumentSearchDoesNotPanicOnExpandingCaseFold(t *testing.T) {
	s := coreFixture(t)
	coreSeedProject(t, s)
	RegisterDocuments(s)
	data, ct := documentMultipart(t, map[string]string{"title": "minutes", "category": "other", "notes": strings.Repeat("ß", 100) + "needle"}, "sample.txt", "content")
	created := coreRequest(s, "POST", "/api/projects/TEST/documents", bytes.NewReader(data), ct)
	if created.Code != 201 {
		t.Fatal(created.Code, created.Body.String())
	}
	result := coreRequest(s, "GET", "/api/projects/TEST/documents?search=needle", nil, "")
	if result.Code != 200 {
		t.Fatalf("valid unicode search failed: %d %s", result.Code, result.Body.String())
	}
	var body Row
	if err := json.Unmarshal(result.Body.Bytes(), &body); err != nil || body["total"] != float64(1) {
		t.Fatal(body, err)
	}
}

func TestReviewDocumentDetailReadSnapshotDuringNewVersions(t *testing.T) {
	s := coreFixture(t)
	coreSeedProject(t, s)
	RegisterDocuments(s)
	if _, err := s.DB.Exec(`INSERT INTO documents(id,project_code,category,logical_name,revision,created_at,updated_at) VALUES(1,'TEST','other','versions',1,'2026','2026'); INSERT INTO document_versions(document_id,version_number,original_filename,managed_filename,content_type,stored_relative_path,size_bytes,sha256,created_at) VALUES(1,1,'v1','v1','text/plain','Projects/TEST/other/1/v1',1,printf('%064d',0),'2026')`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		for n := 2; n <= 200; n++ {
			tx, err := s.DB.BeginTx(ctx, nil)
			if err != nil {
				done <- err
				return
			}
			_, err = tx.Exec("INSERT INTO document_versions(document_id,version_number,original_filename,managed_filename,content_type,stored_relative_path,size_bytes,sha256,created_at) VALUES(1,?,?,?,'text/plain',?,1,printf('%064d',0),'2026')", n, fmt.Sprint(n), fmt.Sprint(n), fmt.Sprintf("Projects/TEST/other/1/v%d", n))
			if err == nil {
				_, err = tx.Exec("UPDATE documents SET revision=? WHERE id=1", n)
			}
			if err == nil {
				err = tx.Commit()
			} else {
				_ = tx.Rollback()
			}
			if err != nil {
				done <- err
				return
			}
			time.Sleep(time.Millisecond)
		}
		done <- nil
	}()
	defer func() {
		if err := <-done; err != nil {
			t.Error("concurrent version writer failed", err)
		}
	}()
	latestSeen := 0
	for n := 0; n < 200; n++ {
		result := coreRequest(s, "GET", "/api/projects/TEST/documents/1", nil, "")
		if result.Code != 200 {
			t.Fatal(result.Code, result.Body.String())
		}
		var body struct {
			Revision int   `json:"revision"`
			Latest   int   `json:"latest_version_number"`
			Versions []Row `json:"versions"`
		}
		if err := json.Unmarshal(result.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Revision != len(body.Versions) || body.Latest != len(body.Versions) {
			t.Fatalf("mixed document snapshots: revision=%d latest=%d versions=%d", body.Revision, body.Latest, len(body.Versions))
		}
		latestSeen = body.Latest
	}
	if latestSeen < 2 {
		t.Fatal("test did not observe a concurrently committed document version")
	}
}

func TestReviewUpdateImportFailureCleansOwnedUpload(t *testing.T) {
	for _, problem := range []string{"engine_rejection", "extra_file", "truncated_stream"} {
		t.Run(problem, func(t *testing.T) {
			s, engine := updateAPIFixture(t)
			var data bytes.Buffer
			writer := multipart.NewWriter(&data)
			part, err := writer.CreateFormFile("file", "official.zip")
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.WriteString(part, "synthetic archive")
			if problem == "extra_file" {
				part, err = writer.CreateFormFile("file", "second.zip")
				if err != nil {
					t.Fatal(err)
				}
				_, _ = io.WriteString(part, "second archive")
			}
			if problem != "truncated_stream" {
				if err = writer.Close(); err != nil {
					t.Fatal(err)
				}
			}
			if problem == "engine_rejection" {
				engine.fail = errors.New("synthetic engine rejection")
			}
			r := httptest.NewRequest("POST", "http://127.0.0.1:8765/api/system/updates/import", &data)
			r.RemoteAddr = "127.0.0.1:12345"
			r.Header.Set("Origin", "http://127.0.0.1:8765")
			r.Header.Set("Content-Type", writer.FormDataContentType())
			r.Header.Set("X-Update-Request-ID", "12345678-1234-1234-1234-123456789abc")
			r.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code < 400 {
				t.Fatal("invalid import was accepted", w.Code, w.Body.String())
			}
			entries, err := os.ReadDir(filepath.Join(s.Root, ".updates", "imports"))
			if err != nil || len(entries) != 0 {
				t.Fatal("failed import leaked upload files", entries, err)
			}
		})
	}
}
