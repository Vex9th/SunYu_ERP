package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sunyu.local/erp/internal/config"
	"sunyu.local/erp/internal/database"
)

func coreFixture(t *testing.T) *Server {
	t.Helper()
	root := t.TempDir()
	settings, err := config.Load(filepath.Join(root, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(settings.DataDir, 0700); err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(filepath.Join(settings.DataDir, "iapm.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err = database.ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	s := New(db, settings)
	s.Root = root
	return s
}
func coreRequest(s *Server, method, path string, body io.Reader, contentType string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, body)
	r.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
	r.Header.Set("Content-Type", contentType)
	r.Header.Set("Idempotency-Key", "12345678-1234-1234-1234-123456789abc")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func coreSeedProject(t *testing.T, s *Server) {
	t.Helper()
	_, err := s.DB.Exec("INSERT INTO companies(id,name,created_at,updated_at) VALUES(1,'测试','2026','2026'); INSERT INTO projects(id,project_code,project_code_key,company_id,name,created_at,updated_at) VALUES(1,'TEST','test',1,'测试项目','2026','2026')")
	if err != nil {
		t.Fatal(err)
	}
}
func documentMultipart(t *testing.T, fields map[string]string, name, content string) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for k, v := range fields {
		_ = w.WriteField(k, v)
	}
	file, err := w.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(file, content)
	_ = w.Close()
	return body.Bytes(), w.FormDataContentType()
}

func TestDocumentUploadReplayDownloadAndRevision(t *testing.T) {
	s := coreFixture(t)
	coreSeedProject(t, s)
	RegisterDocuments(s)
	data, ct := documentMultipart(t, map[string]string{"title": "测试资料", "category": "other"}, "原文件.txt", "untouched content")
	response := coreRequest(s, "POST", "/api/projects/test/documents", bytes.NewReader(data), ct)
	if response.Code != 201 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	var row Row
	if err := json.Unmarshal(response.Body.Bytes(), &row); err != nil {
		t.Fatal(err)
	}
	again := coreRequest(s, "POST", "/api/projects/test/documents", bytes.NewReader(data), ct)
	if again.Code != 201 || again.Body.String() != response.Body.String() {
		t.Fatalf("replay mismatch %d %s", again.Code, again.Body.String())
	}
	var count int
	_ = s.DB.QueryRow("SELECT count(*) FROM document_versions").Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
	download := coreRequest(s, "GET", "/api/projects/TEST/document-versions/1/download", nil, "")
	if download.Code != 200 || download.Body.String() != "untouched content" {
		t.Fatalf("download: %d %s", download.Code, download.Body.String())
	}
	updated := coreRequest(s, "PUT", "/api/projects/TEST/documents/1", strings.NewReader(`{"title":"修改标题","notes":null,"expected_revision":1}`), "application/json")
	if updated.Code != 200 {
		t.Fatal(updated.Body.String())
	}
	stale := coreRequest(s, "PUT", "/api/projects/TEST/documents/1", strings.NewReader(`{"title":"过期覆盖","notes":null,"expected_revision":1}`), "application/json")
	if stale.Code != 409 {
		t.Fatalf("stale write accepted %d", stale.Code)
	}
	var title string
	_ = s.DB.QueryRow("SELECT logical_name FROM documents WHERE id=1").Scan(&title)
	if title != "修改标题" {
		t.Fatal(title)
	}
}

func TestAttachmentRollbackRemovesOnlyOwnedFiles(t *testing.T) {
	s := coreFixture(t)
	coreSeedProject(t, s)
	if err := os.MkdirAll(filepath.Join(s.Config.DataDir, "Temp"), 0700); err != nil {
		t.Fatal(err)
	}
	attachment, err := stageAttachment(s.Config.DataDir, strings.NewReader("document"), "report.txt", "text/plain", 100)
	if err != nil {
		t.Fatal(err)
	}
	batch := &AttachmentBatch{Attachments: []Attachment{attachment}}
	defer batch.Close()
	r := httptest.NewRequest("POST", "/", nil)
	c := &Context{S: s, R: r, DB: s.DB, W: httptest.NewRecorder()}
	_, err = c.Tx(func(tx *Context) (any, error) {
		_, e := batch.Publish(tx, "TEST", "other", []ManagedDocument{{Title: "临时", ManagedFilename: "owned.txt"}}, nil, tx.Timestamp())
		if e != nil {
			return nil, e
		}
		return nil, E(409, "forced rollback", "TEST")
	})
	if err == nil {
		t.Fatal("rollback expected")
	}
	var count int
	_ = s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count)
	if count != 0 {
		t.Fatal("database persisted")
	}
	_ = filepath.WalkDir(filepath.Join(s.Config.DataDir, "Projects"), func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			t.Errorf("orphan file %s", path)
		}
		return err
	})
}

func TestDownloadRefusesSymlinkAndEscapedDatabasePath(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	_ = os.WriteFile(outside, []byte("private"), 0600)
	dir := filepath.Join(root, "Projects", "TEST", "other", "1")
	_ = os.MkdirAll(dir, 0700)
	if err := os.Symlink(outside, filepath.Join(dir, "bad.txt")); err == nil {
		if f, e := openDocumentFile(root, "TEST", "other", 1, "Projects/TEST/other/1/bad.txt", 7); e == nil {
			f.Close()
			t.Fatal("symlink accepted")
		}
	}
	if f, e := openDocumentFile(root, "TEST", "other", 1, "../secret", 7); e == nil {
		f.Close()
		t.Fatal("escape accepted")
	}
}

func TestDocumentRecoversCrashResidueAndKeepsCommittedFiles(t *testing.T) {
	s := coreFixture(t)
	coreSeedProject(t, s)
	RegisterDocuments(s)
	dir := filepath.Join(s.Config.DataDir, "Projects", "TEST", "other", "1")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"orphan.txt", ".version-000000000002.reserve", ".user-note"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("old"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	data, ct := documentMultipart(t, map[string]string{"title": "恢复资料", "category": "other"}, "first.txt", "version one")
	got := coreRequest(s, "POST", "/api/projects/TEST/documents", bytes.NewReader(data), ct)
	if got.Code != 201 {
		t.Fatal(got.Code, got.Body.String())
	}
	for _, name := range []string{"orphan.txt", ".version-000000000002.reserve"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("residue remains %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, ".user-note")); err != nil {
		t.Fatal("unmanaged hidden file was removed", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "orphan-v2.txt"), []byte("orphan"), 0600); err != nil {
		t.Fatal(err)
	}
	data, ct = documentMultipart(t, map[string]string{"expected_revision": "1"}, "second.txt", "version two")
	got = coreRequest(s, "POST", "/api/projects/TEST/documents/1/versions", bytes.NewReader(data), ct)
	if got.Code != 201 {
		t.Fatal(got.Code, got.Body.String())
	}
	for id, expected := range map[int]string{1: "version one", 2: "version two"} {
		r := coreRequest(s, "GET", fmt.Sprintf("/api/projects/TEST/document-versions/%d/download", id), nil, "")
		if r.Code != 200 || r.Body.String() != expected {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "orphan-v2.txt")); !os.IsNotExist(err) {
		t.Fatal("v2 residue remains", err)
	}
}
func TestStagedAttachmentCleanupUsesBoundDirectory(t *testing.T) {
	root := t.TempDir()
	a, err := stageAttachment(root, strings.NewReader("original"), "source.txt", "text/plain", 100)
	if err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(root, "Temp")
	moved := filepath.Join(root, "moved")
	if err = os.Rename(old, moved); err != nil {
		a.Close()
		t.Skipf("platform does not allow renaming bound directory: %v", err)
	}
	if err = os.Mkdir(old, 0700); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(old, filepath.Base(a.Path))
	if err = os.WriteFile(replacement, []byte("unrelated"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(replacement)
	if err != nil || string(b) != "unrelated" {
		t.Fatal("cleanup touched replacement", err)
	}
	entries, err := os.ReadDir(moved)
	if err != nil || len(entries) != 0 {
		t.Fatal("owned stage was not cleaned", err)
	}
}

func TestOversizeDocumentClosesAndRemovesStagingFile(t *testing.T) {
	s := coreFixture(t)
	s.Config.MaxDocumentUploadMB = 1
	coreSeedProject(t, s)
	RegisterDocuments(s)
	data, ct := documentMultipart(t, map[string]string{"title": "超限", "category": "other"}, "large.txt", strings.Repeat("x", (1<<20)+1))
	response := coreRequest(s, "POST", "/api/projects/TEST/documents", bytes.NewReader(data), ct)
	if response.Code != 413 || !strings.Contains(response.Body.String(), "DOCUMENT_FILE_TOO_LARGE") {
		t.Fatal(response.Code, response.Body.String())
	}
	entries, err := os.ReadDir(filepath.Join(s.Config.DataDir, "Temp"))
	if err != nil || len(entries) != 0 {
		t.Fatal("staging residue after oversize", err)
	}
}
