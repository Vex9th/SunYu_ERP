package api

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeUpdateEngine struct {
	calls   []string
	job     Row
	fail    error
	imports []string
	seen    map[string]bool
}

func (f *fakeUpdateEngine) Status() map[string]any {
	return Row{"installed": Row{"version": "2.0.0", "backend_version": "2.0.0", "frontend_version": "2.0.1"}, "latest": Row{"version": "2.1.0", "frontend_version": "2.1.0", "notes": "test", "packages": Row{"application": Row{"url": "https://github.com/example/app.zip", "sha256": strings.Repeat("a", 64)}}}, "job": f.job}
}
func (f *fakeUpdateEngine) Check(id string) error { f.calls = append(f.calls, "check"); return f.fail }
func (f *fakeUpdateEngine) Install(id string) error {
	f.calls = append(f.calls, "update")
	f.job = Row{"id": "job", "request_id": id, "status": "checking"}
	return f.fail
}
func (f *fakeUpdateEngine) Import(path, id string) error {
	f.calls = append(f.calls, "import")
	if f.seen == nil {
		f.seen = map[string]bool{}
	}
	if f.seen[id] {
		return nil
	}
	f.seen[id] = true
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	f.imports = append(f.imports, string(b))
	return f.fail
}
func updateAPIFixture(t *testing.T) (*Server, *fakeUpdateEngine) {
	s := coreFixture(t)
	e := &fakeUpdateEngine{}
	s.Updates = e
	s.Supervised = true
	RegisterUpdates(s)
	return s, e
}
func updateAPIRequest(s *Server, method, path, body, peer, host, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://"+host+path, strings.NewReader(body))
	r.RemoteAddr = peer
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Update-Request-ID", "12345678-1234-1234-1234-123456789abc")
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	r.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func TestUpdateAPILocalOriginAndPeerAreBothRequired(t *testing.T) {
	cases := []struct {
		peer, host, origin string
		want               int
	}{
		{"127.0.0.1:1234", "127.0.0.1:8765", "http://127.0.0.1:8765", 202},
		{"[::1]:1234", "localhost:8765", "http://localhost:8765", 202},
		{"10.0.0.8:1234", "127.0.0.1:8765", "http://127.0.0.1:8765", 403},
		{"127.0.0.1:1234", "evil.example:8765", "http://evil.example:8765", 403},
		{"127.0.0.1:1234", "127.0.0.1:8765", "http://evil.example:8765", 403},
		{"127.0.0.1:1234", "127.0.0.1:8765", "http://127.0.0.1:8766", 403},
		{"127.0.0.1:1234", "127.0.0.1:8765", "", 403},
	}
	for _, tc := range cases {
		t.Run(tc.peer+tc.host+tc.origin, func(t *testing.T) {
			s, e := updateAPIFixture(t)
			w := updateAPIRequest(s, "POST", "/api/system/updates/update", "", tc.peer, tc.host, tc.origin)
			if w.Code != tc.want {
				t.Fatal(w.Code, w.Body.String())
			}
			if tc.want == 403 && len(e.calls) != 0 {
				t.Fatal("blocked caller reached engine")
			}
		})
	}
}
func TestUpdateRemoteCanReadAndCheckButNotInstall(t *testing.T) {
	s, e := updateAPIFixture(t)
	w := updateAPIRequest(s, "GET", "/api/system/updates", "", "10.0.0.8:1234", "192.168.1.5:8765", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var state Row
	json.Unmarshal(w.Body.Bytes(), &state)
	if state["can_install"] != false || state["install_block_reason"] != "non_loopback_peer" || state["frontend_version"] != "2.0.1" {
		t.Fatal(state)
	}
	w = updateAPIRequest(s, "POST", "/api/system/updates/check", "", "10.0.0.8:1234", "192.168.1.5:8765", "http://192.168.1.5:8765")
	if w.Code != 202 || len(e.calls) != 1 || e.calls[0] != "check" {
		t.Fatal(w.Code, w.Body.String(), e.calls)
	}
}
func TestUpdateRejectsSpoofedForwardHeadersAndUnauthenticatedRequest(t *testing.T) {
	s, e := updateAPIFixture(t)
	for _, auth := range []bool{false, true} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8765/api/system/updates/update", nil)
		r.RemoteAddr = "10.0.0.8:1234"
		r.Header.Set("Origin", "http://127.0.0.1:8765")
		r.Header.Set("X-Forwarded-For", "127.0.0.1")
		r.Header.Set("Forwarded", "for=127.0.0.1;host=localhost")
		if auth {
			r.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		want := 401
		if auth {
			want = 403
		}
		if w.Code != want {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if len(e.calls) != 0 {
		t.Fatal(e.calls)
	}
}
func TestUpdatePreferencesPreserveConfigAndRejectBadTypes(t *testing.T) {
	s, _ := updateAPIFixture(t)
	before, _ := os.ReadFile(s.Config.ConfigPath)
	request := func(body string) *httptest.ResponseRecorder {
		return updateAPIRequest(s, "PATCH", "/api/system/updates/preferences", body, "127.0.0.1:1234", "127.0.0.1:8765", "http://127.0.0.1:8765")
	}
	w := request(`{"auto_check":false,"ignored_version":"2.1.0"}`)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(`{"auto_check":"yes"}`)
	if w.Code != 422 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(`{"ignored_version":null}`)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var state Row
	json.Unmarshal(w.Body.Bytes(), &state)
	p := state["preferences"].(map[string]any)
	if p["auto_check"] != false || p["ignored_version"] != nil {
		t.Fatal(p)
	}
	after, _ := os.ReadFile(s.Config.ConfigPath)
	if !bytes.Equal(before, after) {
		t.Fatal("update preferences modified business config")
	}
}
func TestUpdateUploadReplayLeavesNoSourceFiles(t *testing.T) {
	s, e := updateAPIFixture(t)
	for i := 0; i < 2; i++ {
		var b bytes.Buffer
		writer := multipart.NewWriter(&b)
		file, _ := writer.CreateFormFile("file", "official.zip")
		io.WriteString(file, "official archive")
		writer.Close()
		r := httptest.NewRequest("POST", "http://127.0.0.1:8765/api/system/updates/import", &b)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Origin", "http://127.0.0.1:8765")
		r.Header.Set("Content-Type", writer.FormDataContentType())
		r.Header.Set("X-Update-Request-ID", "12345678-1234-1234-1234-123456789abc")
		r.AddCookie(&http.Cookie{Name: "sunyu_session", Value: CreateSession(s.Config.SessionSecret, s.Now())})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 202 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if len(e.imports) != 1 || e.imports[0] != "official archive" {
		t.Fatal(e.imports)
	}
	entries, err := os.ReadDir(filepath.Join(s.Root, ".updates", "imports"))
	if err != nil || len(entries) != 0 {
		t.Fatal("import temp leaked", err)
	}
}
func TestUpdateSymlinkStateCannotEscapeInstallation(t *testing.T) {
	s, _ := updateAPIFixture(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(s.Root, ".updates")); err != nil {
		t.Skip(err)
	}
	w := updateAPIRequest(s, "PATCH", "/api/system/updates/preferences", `{"auto_check":false}`, "127.0.0.1:1234", "127.0.0.1:8765", "http://127.0.0.1:8765")
	if w.Code != 500 {
		t.Fatal(w.Code, w.Body.String())
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("escaped installation", err)
	}
}

func (f *fakeUpdateEngine) RequestStatus(id string) (map[string]any, error) {
	if f.job != nil && f.job["request_id"] == id {
		return f.job, nil
	}
	return nil, os.ErrNotExist
}
