package api

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sunyu.local/erp/internal/config"
	"sunyu.local/erp/internal/database"
	"testing"
	"time"
)

// TestDeliveryReferenceServer is an opt-in test-only transport for running the
// previous release's HTTP contract tests against Go. It is absent from builds.
func TestDeliveryReferenceServer(t *testing.T) {
	path := os.Getenv("SUNYU_REFERENCE_DB")
	if path == "" {
		t.Skip("reference-test subprocess only")
	}
	current, err := time.Parse(time.RFC3339Nano, os.Getenv("SUNYU_REFERENCE_NOW"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	settings := config.Settings{DataDir: filepath.Dir(path), ConfigPath: filepath.Join(filepath.Dir(path), "config.json"), Host: "127.0.0.1", Port: 8765, MaxDocumentUploadMB: 20, SessionSecret: "test-session-secret-with-at-least-32-bytes"}
	if raw := os.Getenv("SUNYU_REFERENCE_SETTINGS"); raw != "" {
		if err = json.Unmarshal([]byte(raw), &settings); err != nil {
			t.Fatal(err)
		}
	}
	s := Application(db, settings, filepath.Dir(path), "reference-test")
	s.Now = func() time.Time {
		if path := os.Getenv("SUNYU_REFERENCE_CLOCK_FILE"); path != "" {
			raw, e := os.ReadFile(path)
			if e != nil {
				panic(e)
			}
			now, e := time.Parse(time.RFC3339Nano, strings.TrimSpace(string(raw)))
			if e != nil {
				panic(e)
			}
			return now
		}
		return current
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.NewEncoder(os.Stdout).Encode(Row{"url": "http://" + listener.Addr().String(), "token": CreateSession(settings.SessionSecret, time.Now())}); err != nil {
		t.Fatal(err)
	}
	if err = http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Python reference fixtures freeze only business clocks; authenticate at real wall time.
		if cookie, e := r.Cookie("sunyu_session"); e == nil && ValidSession(settings.SessionSecret, cookie.Value, time.Now()) {
			cookies := r.Cookies()
			r.Header.Del("Cookie")
			for _, item := range cookies {
				if item.Name == "sunyu_session" {
					item.Value = CreateSession(settings.SessionSecret, s.Now())
				}
				r.AddCookie(item)
			}
		}
		s.ServeHTTP(w, r)
	})); err != nil {
		t.Fatal(err)
	}
}
