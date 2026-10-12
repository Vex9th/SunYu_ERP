package update

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"sunyu.local/erp/internal/lifecycle"
)

type responseTransport func(*http.Request) (*http.Response, error)

func (f responseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func testEngine(t *testing.T, root string) *Engine {
	t.Helper()
	e, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Close)
	return e
}

func TestEngineFixtureWaitsForWorkerFinalizationBeforeRemovingData(t *testing.T) {
	root := t.TempDir()
	var e *Engine
	id := "687afbf8-a5ae-42c2-ad7f-bdd7349bbf51"
	// Registered before the engine's cleanup, so this checks its completed teardown.
	t.Cleanup(func() {
		e.mu.Lock()
		closed, running := e.closed, e.running
		e.mu.Unlock()
		if !closed || running {
			e.Close()
			t.Error("test engine did not finish its background worker before directory cleanup")
		}
		j, err := e.Request(id)
		if err != nil || j.Status != "failed" || !strings.Contains(j.Error, "worker finalized") {
			t.Errorf("final request state was not persisted: %+v %v", j, err)
		}
		release, err := lifecycle.Acquire(e.Root, "installer.lock")
		if err != nil {
			t.Error("engine cleanup did not release the installer lock", err)
		} else {
			release()
		}
	})
	e = testEngine(t, root)
	if err := e.start(id, "checking", func(j *Job) error {
		// Expose a terminal snapshot while the worker still has finalization work.
		j.Status = "success"
		if err := e.saveJob(j); err != nil {
			return err
		}
		<-e.ctx.Done()
		return errors.New("worker finalized after cancellation")
	}); err != nil {
		t.Fatal(err)
	}
	if j := awaitJob(t, e); j.Status != "success" {
		t.Fatal(j)
	}
}
func awaitJob(t *testing.T, e *Engine) Job {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); {
		s := e.Status()
		b, _ := json.Marshal(s["job"])
		var j Job
		json.Unmarshal(b, &j)
		if j.Status == "success" || j.Status == "failed" || j.Status == "manual_recovery" {
			return j
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return Job{}
}
func installFixture(t *testing.T, root string, m Manifest, data map[string]string) {
	t.Helper()
	for p, s := range data {
		os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0700)
		os.WriteFile(filepath.Join(root, p), []byte(s), 0700)
	}
	if e := writeJSON(filepath.Join(root, "app", "manifest.json"), m); e != nil {
		t.Fatal(e)
	}
}
func TestFrontendInstallPreservesDataAndOnePreviousVersion(t *testing.T) {
	root := t.TempDir()
	old := testManifest("2.0.0", "frontend")
	old.Component = ""
	old.Files["app/web/1.9.0/index.html"] = digest("ancient")
	installFixture(t, root, old, map[string]string{"app/web/2.0.0/index.html": "new", "app/web/1.9.0/index.html": "ancient", "Data/notes.txt": "customer", "app/web/user.txt": "personal", "config.json": "{\"data_dir\":\"Data\"}"})
	next := testManifest("2.0.1", "frontend")
	stage := t.TempDir()
	installFixture(t, stage, next, map[string]string{"app/web/2.0.1/index.html": "new"})
	e := testEngine(t, root)
	j := Job{ID: "test", RequestID: "request", Status: "installing"}
	if err := e.installFrontend(&j, next, stage); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"Data/notes.txt", "config.json", "app/web/user.txt", "app/web/2.0.0/index.html", "app/web/2.0.1/index.html"} {
		if _, e := os.Stat(filepath.Join(root, p)); e != nil {
			t.Fatal(p, e)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "app/web/1.9.0/index.html")); !os.IsNotExist(err) {
		t.Fatal("ancient version retained")
	}
	got, _ := ReadManifest(root)
	if got.FrontendVersion != "2.0.1" {
		t.Fatal(got)
	}
}
func TestCheckRequestIsIdempotentAndBusyDoesNotQueue(t *testing.T) {
	e := testEngine(t, t.TempDir())
	gate := make(chan struct{})
	e.Client = &http.Client{Transport: responseTransport(func(r *http.Request) (*http.Response, error) {
		select {
		case <-gate:
			return nil, errors.New("network unavailable")
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
	})}
	id := "28f4417c-e8a9-4bd0-a4d4-773ba6e279fa"
	if err := e.Check(id); err != nil {
		t.Fatal(err)
	}
	if err := e.Check(id); err != nil {
		t.Fatal(err)
	}
	if err := e.Install("329e858f-5cb4-4b0b-855b-799354303326"); !errors.Is(err, ErrBusy) {
		t.Fatal(err)
	}
	close(gate)
	j := awaitJob(t, e)
	if j.RequestID != id || j.Status != "failed" || !strings.Contains(j.Error, "network unavailable") {
		t.Fatal(j)
	}
	if err := e.Check(id); err != nil {
		t.Fatal(err)
	}
	j2 := awaitJob(t, e)
	if j.ID != j2.ID {
		t.Fatal("duplicate triggered a second job")
	}
}
func TestCatalogRejectsUnsafeOriginsAndDowngrades(t *testing.T) {
	e := testEngine(t, t.TempDir())
	m := testManifest("3.0.0", "frontend")
	installFixture(t, e.Root, m, map[string]string{"app/web/3.0.0/index.html": "new"})
	c := Catalog{Format: 2, Application: Application, APIVersion: 1, Version: "2.0.1", BackendVersion: "2.0.0", FrontendVersion: "2.0.1", LauncherVersion: "2.0.0", Packages: map[string]Archive{"frontend": {URL: "https://evil.invalid/x.zip", SHA256: digest("x")}}}
	if err := e.validateCatalog(c); err == nil {
		t.Fatal("external origin accepted")
	}
	c.Packages["frontend"] = Archive{URL: "https://github.com/Vex9th/SunYu_ERP/releases/download/v2.0.1/front.zip", SHA256: digest("x")}
	if available(m, c) {
		t.Fatal("downgrade offered")
	}
}
func TestImportRejectsSelfDeclaredHashWithoutOfficialDigest(t *testing.T) {
	e := testEngine(t, t.TempDir())
	m := testManifest("2.0.1", "frontend")
	p := testArchive(t, m, map[string]string{"app/web/2.0.1/index.html": "new"})
	owned := filepath.Join(e.Root, ".updates/imports/test.zip")
	if err := copyFile(p, owned); err != nil {
		t.Fatal(err)
	}
	p = owned
	e.Client = &http.Client{Transport: responseTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`)), Header: http.Header{}}, nil
	})}
	if err := e.Import(p, "89c8fd59-f836-4f57-bf81-1417151d174e"); err != nil {
		t.Fatal(err)
	}
	j := awaitJob(t, e)
	if j.Status != "failed" {
		t.Fatal(j)
	}
	if _, err := os.Stat(filepath.Join(e.Root, "app/web/2.0.1/index.html")); !os.IsNotExist(err) {
		t.Fatal("untrusted archive installed")
	}
}
func TestHealthVerificationStopsWhenNewLauncherExits(t *testing.T) {
	e := testEngine(t, t.TempDir())
	start := time.Now()
	if err := e.waitHealthyOwned("2.0.1", 30*time.Second, 2147483647); err == nil {
		t.Fatal("nonexistent launcher accepted")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("did not detect exited launcher")
	}
}
func TestSemanticVersionPrereleaseAndUnboundedNumbers(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want int
	}{{"2.0.0-rc.10", "2.0.0-rc.9", 1}, {"2.0.0-alpha.1", "2.0.0-alpha.beta", -1}, {"2.0.0-alpha", "2.0.0-alpha.1", -1}, {"2.0.0", "2.0.0-rc.10", 1}, {"2.0.0+build.10", "2.0.0+build.9", 0}, {"999999999999999999999999.0.0", "999999999999999999999998.0.0", 1}} {
		if got := compareVersion(tc.a, tc.b); got != tc.want {
			t.Fatalf("compare %s %s = %d want %d", tc.a, tc.b, got, tc.want)
		}
	}
}
func TestLegacyCatalogCanBeCheckedWithoutOfferingDowngrade(t *testing.T) {
	e := testEngine(t, t.TempDir())
	m := testManifest("2.0.0", "frontend")
	installFixture(t, e.Root, m, map[string]string{"app/web/2.0.0/index.html": "new"})
	e.Client = &http.Client{Transport: responseTransport(func(r *http.Request) (*http.Response, error) {
		body, code := `{"format":1,"version":"1.3.1","notes":"legacy","components":{"backend":{"version":"1.3.1"},"frontend":{"version":"1.3.1"}}}`, 200
		if strings.Contains(r.URL.Path, "manifest-v2") {
			body, code = "missing", 404
		}
		return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	})}
	if err := e.Check("2e4f379c-efae-4392-8f1e-0f4e06e0c0d3"); err != nil {
		t.Fatal(err)
	}
	j := awaitJob(t, e)
	if j.Status != "success" {
		t.Fatal(j)
	}
	if e.Status()["update_available"] != false {
		t.Fatal("legacy catalog offered downgrade")
	}
}
