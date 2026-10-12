package update

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sunyu.local/erp/internal/database"
	"testing"
	"time"
)

func TestNativeExecutableFullAndFrontendUpdate(t *testing.T) {
	bins := os.Getenv("SUNYU_NATIVE_UPDATE_BIN_DIR")
	if bins == "" {
		t.Skip("set SUNYU_NATIVE_UPDATE_BIN_DIR to independently built 2.0.0 and 2.0.1 native binaries")
	}
	e, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	listen, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listen.Addr().(*net.TCPAddr).Port
	listen.Close()
	configBytes, _ := json.Marshal(map[string]any{"host": "127.0.0.1", "port": port, "data_dir": "Data", "session_secret": "native-update-isolated-verification-secret"})
	if err = os.WriteFile(filepath.Join(e.Root, "config.json"), configBytes, 0600); err != nil {
		t.Fatal(err)
	}
	makeManifest := func(root, version string) Manifest {
		t.Helper()
		m := testManifest(version, "application")
		m.BackendVersion, m.LauncherVersion = version, version
		for target, source := range map[string]string{"SunYu_ERP.exe": "launcher-" + version, "app/SunYuService.exe": "service-" + version} {
			if err := copyFile(filepath.Join(bins, source), filepath.Join(root, target)); err != nil {
				t.Fatal(err)
			}
			h, err := hashFile(filepath.Join(root, target))
			if err != nil {
				t.Fatal(err)
			}
			m.Files[target] = h
		}
		web := filepath.Join(root, "app/web", version, "index.html")
		os.MkdirAll(filepath.Dir(web), 0700)
		os.WriteFile(web, []byte("new"), 0600)
		if err := writeJSON(filepath.Join(root, "app/manifest.json"), m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	makeManifest(e.Root, "2.0.0")
	log, err := os.Create(filepath.Join(e.Root, "launcher-test.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	cmd := exec.Command(filepath.Join(e.Root, "SunYu_ERP.exe"), "--headless")
	cmd.Stdout, cmd.Stderr = log, log
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go cmd.Wait()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		release, err := e.stopAndLock(ctx)
		if err != nil {
			t.Error("native processes did not stop", err)
		} else {
			release()
		}
	})
	if err = e.waitHealthy("2.0.0", 20*time.Second); err != nil {
		b, _ := os.ReadFile(filepath.Join(e.Root, ".updates/logs/runtime.log"))
		t.Fatal(err, string(b))
	}
	db, err := database.Open(filepath.Join(e.Root, "Data/iapm.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("CREATE TABLE update_verification(value TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO update_verification VALUES ('customer rows stay intact')"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	os.WriteFile(filepath.Join(e.Root, "Data/customer-attachment.txt"), []byte("preserved attachment"), 0600)
	stage := t.TempDir()
	next := makeManifest(stage, "2.0.1")
	archive := filepath.Join(t.TempDir(), "application.zip")
	writeNativeArchive(t, archive, next, stage)
	setCatalog := func(m Manifest, p string) {
		t.Helper()
		h, err := hashFile(p)
		if err != nil {
			t.Fatal(err)
		}
		catalog := Catalog{Format: 2, Application: Application, Version: m.Version, BackendVersion: m.BackendVersion, FrontendVersion: m.FrontendVersion, LauncherVersion: m.LauncherVersion, APIVersion: 1, Packages: map[string]Archive{m.Component: {URL: "https://github.com/Vex9th/SunYu_ERP/releases/download/v" + m.Version + "/package.zip", SHA256: h}}}
		body, _ := json.Marshal(catalog)
		e.Client = &http.Client{Transport: responseTransport(func(r *http.Request) (*http.Response, error) {
			var reader io.ReadCloser
			if strings.HasSuffix(r.URL.Path, ".json") {
				reader = io.NopCloser(strings.NewReader(string(body)))
			} else {
				file, err := os.Open(p)
				if err != nil {
					return nil, err
				}
				reader = file
			}
			return &http.Response{StatusCode: 200, Body: reader, Header: http.Header{}}, nil
		})}
	}
	wait := func() {
		t.Helper()
		for deadline := time.Now().Add(90 * time.Second); time.Now().Before(deadline); {
			var j Job
			readJSON(filepath.Join(e.Root, ".updates/job.json"), &j)
			if terminal(j.Status) {
				if j.Status != "success" {
					b, _ := os.ReadFile(filepath.Join(e.Root, ".updates/logs/update.log"))
					t.Fatalf("native update failed: %+v\n%s", j, b)
				}
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		b, _ := os.ReadFile(filepath.Join(e.Root, ".updates/logs/update.log"))
		t.Fatalf("native update timeout: %s", b)
	}
	setCatalog(next, archive)
	if err = e.Install("9f74f971-4f58-46c7-adf2-639cd3d9ec9c"); err != nil {
		t.Fatal(err)
	}
	wait()
	if err = e.waitHealthy("2.0.1", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	current, err := ReadManifest(e.Root)
	if err != nil || current.BackendVersion != "2.0.1" {
		t.Fatal(current, err)
	}
	b, _ := os.ReadFile(filepath.Join(e.Root, "config.json"))
	if string(b) != string(configBytes) {
		t.Fatal("config bytes changed")
	}
	db, err = database.Open(filepath.Join(e.Root, "Data/iapm.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	var retained string
	if err = db.QueryRow("SELECT value FROM update_verification").Scan(&retained); err != nil || retained != "customer rows stay intact" {
		t.Fatal(retained, err)
	}
	db.Close()
	b, _ = os.ReadFile(filepath.Join(e.Root, "Data/customer-attachment.txt"))
	if string(b) != "preserved attachment" {
		t.Fatal("attachment lost")
	}
	var fullJob Job
	readJSON(filepath.Join(e.Root, ".updates/job.json"), &fullJob)
	frontend := testManifest("2.0.2", "frontend")
	frontend.BackendVersion, frontend.LauncherVersion = "2.0.1", "2.0.1"
	frontStage := t.TempDir()
	installFixture(t, frontStage, frontend, map[string]string{"app/web/2.0.2/index.html": "new"})
	frontArchive := filepath.Join(t.TempDir(), "frontend.zip")
	writeNativeArchive(t, frontArchive, frontend, frontStage)
	address, _ := healthAddress(e.Root)
	healthPID := func() int {
		resp, err := http.Get(address + "/api/health")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var h struct {
			PID int `json:"pid"`
		}
		json.NewDecoder(resp.Body).Decode(&h)
		return h.PID
	}
	before := healthPID()
	setCatalog(frontend, frontArchive)
	if err = e.Install("6956e953-26a8-4a8c-a967-f4d27c149f24"); err != nil {
		t.Fatal(err)
	}
	wait()
	if after := healthPID(); after != before {
		t.Fatalf("frontend update restarted backend: %d -> %d", before, after)
	}
	for _, p := range []string{"app/web/2.0.2/index.html", "app/web/2.0.1/index.html"} {
		if _, err = os.Stat(filepath.Join(e.Root, p)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = os.Stat(filepath.Join(e.Root, "app/web/2.0.0/index.html")); !os.IsNotExist(err) {
		t.Fatal("oldest frontend retained")
	}
	if _, err = os.Stat(filepath.Join(e.Root, ".updates/work", fullJob.ID, "download.zip")); !os.IsNotExist(err) {
		t.Fatal("full package download was retained")
	}
	// A real faulty service simulates a migration write followed by startup failure.
	badStage := t.TempDir()
	badSource := filepath.Join(t.TempDir(), "main.go")
	badCode := `package main
import("os";"path/filepath")
func main(){root:=os.Args[2];_ = os.WriteFile(filepath.Join(root,"Data","iapm.sqlite"),[]byte("bad migration interrupted"),0600);os.Exit(42)}`
	os.WriteFile(badSource, []byte(badCode), 0600)
	badService := filepath.Join(badStage, "app/SunYuService.exe")
	os.MkdirAll(filepath.Dir(badService), 0700)
	build := exec.Command("go", "build", "-o", badService, badSource)
	if b, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build failure fixture: %v %s", err, b)
	}
	bad := testManifest("2.0.3", "application")
	bad.BackendVersion, bad.LauncherVersion = "2.0.3", "2.0.1"
	if err := copyFile(filepath.Join(e.Root, "SunYu_ERP.exe"), filepath.Join(badStage, "SunYu_ERP.exe")); err != nil {
		t.Fatal(err)
	}
	bad.Files["SunYu_ERP.exe"], _ = hashFile(filepath.Join(badStage, "SunYu_ERP.exe"))
	bad.Files["app/SunYuService.exe"], _ = hashFile(badService)
	os.MkdirAll(filepath.Join(badStage, "app/web/2.0.3"), 0700)
	os.WriteFile(filepath.Join(badStage, "app/web/2.0.3/index.html"), []byte("new"), 0600)
	badArchive := filepath.Join(t.TempDir(), "failed-update.zip")
	writeNativeArchive(t, badArchive, bad, badStage)
	setCatalog(bad, badArchive)
	if err = e.Install("335afc01-652d-4991-8ad9-3d6bd1e90f46"); err != nil {
		t.Fatal(err)
	}
	var failed Job
	for deadline := time.Now().Add(25 * time.Second); time.Now().Before(deadline); {
		readJSON(filepath.Join(e.Root, ".updates/job.json"), &failed)
		if terminal(failed.Status) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if failed.Status != "failed" || !strings.Contains(failed.Message, "已恢复") {
		b, _ := os.ReadFile(filepath.Join(e.Root, ".updates/logs/update.log"))
		t.Fatalf("failed update did not automatically roll back: %+v\n%s", failed, b)
	}
	if err = e.waitHealthy("2.0.1", 10*time.Second); err != nil {
		t.Fatal("old service not recovered", err)
	}
	db, err = database.Open(filepath.Join(e.Root, "Data/iapm.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow("SELECT value FROM update_verification").Scan(&retained); err != nil || retained != "customer rows stay intact" {
		t.Fatal("corrupted migration data was not restored", retained, err)
	}
	db.Close()
	b, _ = os.ReadFile(filepath.Join(e.Root, "config.json"))
	if string(b) != string(configBytes) {
		t.Fatal("rollback changed config bytes")
	}
	current, err = ReadManifest(e.Root)
	if err != nil || current.Version != "2.0.2" {
		t.Fatal("program did not roll back", current, err)
	}
	t.Log("real process full update, frontend hot update, and failed migration automatic rollback passed; SQLite row, attachment and exact config bytes preserved")
}
func writeNativeArchive(t *testing.T, p string, m Manifest, stage string) {
	t.Helper()
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z := zip.NewWriter(f)
	b, _ := json.Marshal(m)
	w, err := z.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	w.Write(b)
	for _, name := range sortedKeys(m.Files) {
		w, err = z.Create("payload/" + name)
		if err != nil {
			t.Fatal(err)
		}
		source, err := os.Open(filepath.Join(stage, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.Copy(w, source)
		source.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if err = z.Close(); err != nil {
		t.Fatal(err)
	}
}
