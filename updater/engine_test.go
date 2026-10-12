package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestNoUpdateDoesNotRequestMissingLegacyManifest(t *testing.T) {
	e, err := newEngine(t.TempDir(), "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	e.current = "1.2.4"
	calls := 0
	e.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if !strings.Contains(r.URL.Path, "/repos/") {
			t.Error("requested absent legacy manifest", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v1.2.4","draft":false,"prerelease":false}`))}, nil
	})}
	if err = e.run(false); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || e.status.Phase != "idle" || e.status.UpdateAvailable {
		t.Fatal(e.status, calls)
	}
}
func TestApplyNoUpdateSaysNothingInstalled(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "1123456789abcdef0123456789abcdef")
	e.current = "1.2.5"
	e.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v1.2.4"}`))}, nil
	})}
	if err := e.run(true); err != nil {
		t.Fatal(err)
	}
	if e.status.Phase != "success" || e.status.Message != "当前没有可安装的新版本" {
		t.Fatal(e.status)
	}
}
func TestInvalidDownloadNeverStopsRunningApplication(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "2123456789abcdef0123456789abcdef")
	e.current = "1.2.4"
	svc := &fakeServices{running: true}
	e.services = svc
	m := manifestFixture()
	e.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		var body string
		switch {
		case strings.Contains(r.URL.Path, "/repos/"):
			body = `{"tag_name":"v1.2.5"}`
		case strings.HasSuffix(r.URL.Path, ".json"):
			b, _ := json.Marshal(m)
			body = string(b)
		default:
			if !svc.running {
				t.Error("service stopped during download")
			}
			body = "corrupt archive"
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	if err := e.run(true); err == nil {
		t.Fatal("corrupt download accepted")
	}
	if svc.stops != 0 || !svc.running {
		t.Fatal("invalid download interrupted service")
	}
}

type fakeServices struct {
	running bool
	stops   int
	failNew bool
	root    string
}

func (f *fakeServices) stop() error { f.running = false; f.stops++; return nil }
func (f *fakeServices) start(version string) error {
	f.running = true
	if f.failNew && version == "1.2.5" {
		os.WriteFile(filepath.Join(f.root, "Data/iapm.sqlite"), []byte("corrupt migration"), 0600)
		return errors.New("new version startup failed")
	}
	return nil
}
func TestLocalEndpointValidatesConfigurationBeforeStopping(t *testing.T) {
	root := t.TempDir()
	s := &localServices{root: root}
	for _, config := range []string{`{"port":0}`, `{"port":70000}`, `{"host":"203.0.113.200"}`, `broken`} {
		os.WriteFile(filepath.Join(root, "config.json"), []byte(config), 0600)
		if _, _, err := s.endpoint(); err == nil {
			t.Fatal("invalid endpoint accepted", config)
		}
	}
	for config, want := range map[string]string{`{"host":"0.0.0.0","port":8765}`: "127.0.0.1", `{"host":"::","port":8765}`: "::1", `{"host":"::1","port":8765}`: "::1"} {
		os.WriteFile(filepath.Join(root, "config.json"), []byte(config), 0600)
		host, port, err := s.endpoint()
		if err != nil || host != want || port != 8765 {
			t.Fatal(host, port, err)
		}
	}
}
func TestCheckPreservesLastApplyOutcome(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "8123456789abcdef0123456789abcdef")
	e.current = "1.2.4"
	e.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v1.2.4"}`))}, nil
	})}
	if err := e.run(true); err != nil {
		t.Fatal(err)
	}
	var applied Status
	if err := readJSON(filepath.Join(e.root, ".updates/last-install.json"), &applied); err != nil {
		t.Fatal(err)
	}
	e.status.JobID = "9123456789abcdef0123456789abcdef"
	if err := e.run(false); err != nil {
		t.Fatal(err)
	}
	var after Status
	if err := readJSON(filepath.Join(e.root, ".updates/last-install.json"), &after); err != nil || after.JobID != applied.JobID || after.Phase != "success" {
		t.Fatal(after, err)
	}
}
func TestUnknownProgramIsNotAssumedLegacy(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "SunYu_ERP.exe"), []byte("manually extracted 1.2.5"), 0700)
	e, err := newEngine(root, "a123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	if e.current != "" {
		t.Fatal("unknown application version was guessed", e.current)
	}
}
