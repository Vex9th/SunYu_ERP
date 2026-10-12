package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestFrontendSwitchUsesInstalledManifestAndKeepsPreviousAssets(t *testing.T) {
	s := coreFixture(t)
	for version, content := range map[string]string{"2.0.0": "old page", "2.0.1": "new page"} {
		dir := filepath.Join(s.Root, "app", "web", version)
		if e := os.MkdirAll(dir, 0700); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(filepath.Join(dir, "index.html"), []byte(content), 0600); e != nil {
			t.Fatal(e)
		}
	}
	app := Application(s.DB, s.Config, s.Root, "2.0.0")
	get := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Accept", "text/html")
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		return w
	}
	set := func(version string) {
		b, _ := json.Marshal(Row{"frontend_version": version})
		if e := os.WriteFile(filepath.Join(s.Root, "app", "manifest.json"), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	set("2.0.0")
	if r := get("/"); r.Code != 200 || r.Body.String() != "old page" {
		t.Fatal(r.Code, r.Body.String())
	}
	set("2.0.1")
	if r := get("/settings"); r.Code != 200 || r.Body.String() != "new page" || r.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(r.Code, r.Body.String(), r.Header())
	}
	if r := get("/__frontend/2.0.0/index.html"); r.Code != 200 || r.Body.String() != "old page" {
		t.Fatal(r.Code, r.Body.String())
	}
	set("../../../")
	if r := get("/"); r.Code != 404 {
		t.Fatal("unsafe version", r.Code)
	}
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "index.html"), []byte("private"), 0600)
	if e := os.Symlink(outside, filepath.Join(s.Root, "app", "web", "evil")); e == nil {
		set("evil")
		if r := get("/"); r.Code != 404 {
			t.Fatal("followed outside symlink", r.Code, r.Body.String())
		}
	}
}

func TestAllLegacyBusinessRoutesRemainRegistered(t *testing.T) {
	s := coreFixture(t)
	app := Application(s.DB, s.Config, s.Root, "2.0.0")
	b, e := os.ReadFile("../../testdata/legacy-routes.json")
	if e != nil {
		t.Fatal(e)
	}
	var routes []struct {
		Method string `json:"method"`
		Path   string `json:"path"`
	}
	if e = json.Unmarshal(b, &routes); e != nil {
		t.Fatal(e)
	}
	replacement := regexp.MustCompile(`\{[^}]+\}`)
	for _, route := range routes {
		if route.Path == "/api/system/updates/download" || route.Path == "/api/system/updates/install" {
			continue
		} // Replaced by one atomic /update operation.
		path := replacement.ReplaceAllStringFunc(route.Path, func(segment string) string {
			if segment == "{project_code}" {
				return "TEST"
			}
			return "1"
		})
		req := httptest.NewRequest(route.Method, path, nil)
		_, pattern := app.Mux.Handler(req)
		if pattern == "/" || pattern == "" || !strings.HasPrefix(pattern, route.Method+" ") {
			t.Errorf("missing legacy route %s %s; selected %q", route.Method, route.Path, pattern)
		}
	}
}
