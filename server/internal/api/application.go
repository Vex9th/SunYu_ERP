package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"sunyu.local/erp/internal/config"
)

// Application registers each business module explicitly, so route coverage can
// be compared against the previous release without depending on init ordering.
func Application(db *sql.DB, settings config.Settings, root, version string) *Server {
	s := New(db, settings)
	s.Root = root
	s.Version = version
	RegisterAuth(s)
	RegisterBusiness(s)
	RegisterProcurement(s)
	RegisterDelivery(s)
	RegisterDocuments(s)
	s.System = RegisterSystem(s)
	s.SettingsSnapshot = s.System.Settings
	RegisterUpdates(s)
	s.Public("GET /api/health", func(c *Context) (any, error) {
		return Row{"status": "ok", "backend_version": s.Version, "pid": os.Getpid()}, nil
	})
	s.Mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"detail":"Not Found"}`))
			return
		}
		manifest := struct {
			Frontend string `json:"frontend_version"`
		}{Frontend: version}
		if data, e := os.ReadFile(filepath.Join(root, "app", "manifest.json")); e == nil {
			_ = json.Unmarshal(data, &manifest)
		}
		selected := manifest.Frontend
		asset := "index.html"
		if strings.HasPrefix(r.URL.Path, "/__frontend/") {
			parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/__frontend/"), "/", 2)
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			selected, asset = parts[0], parts[1]
		} else if r.URL.Path != "/" && r.URL.Path != "/index.html" && !(strings.Contains(r.Header.Get("Accept"), "text/html") && (r.URL.Path == "/companies" || r.URL.Path == "/projects" || r.URL.Path == "/inventory" || r.URL.Path == "/settings" || strings.HasPrefix(r.URL.Path, "/projects/"))) {
			http.NotFound(w, r)
			return
		}
		if selected == "" || strings.ContainsAny(selected, "/\\") || selected == "." || selected == ".." {
			http.NotFound(w, r)
			return
		}
		if asset == "index.html" || strings.HasSuffix(asset, ".html") {
			w.Header().Set("Cache-Control", "no-store")
		}
		installation, err := os.OpenRoot(root)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer installation.Close()
		files, err := installation.OpenRoot(filepath.Join("app", "web", selected))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer files.Close()
		file, err := files.Open(filepath.FromSlash(asset))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	})
	return s
}
