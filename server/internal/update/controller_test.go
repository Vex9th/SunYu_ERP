package update

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sunyu.local/erp/internal/lifecycle"
	"testing"
	"time"
)

func TestControllerRejectsChangedUpdaterBeforeStartingTask(t *testing.T) {
	root := t.TempDir()
	applicationFixture(t, root, "2.0.0")
	if err := os.WriteFile(filepath.Join(root, "update.exe"), []byte("changed unknown updater"), 0700); err != nil {
		t.Fatal(err)
	}
	c, err := NewController(root)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err = c.Install("5a3e73ae-b9c5-4f2b-b7a7-37c7a40955b8"); err == nil || !strings.Contains(err.Error(), "清单") {
		t.Fatal("changed updater accepted", err)
	}
	if j := c.currentJob(); j != nil {
		t.Fatal("failed preparation registered executable task", j)
	}
}
func TestControllerIndependentFrontendSurvivesCloseAndReplaysOnce(t *testing.T) {
	root := t.TempDir()
	old := applicationFixture(t, root, "2.0.0")
	bin := filepath.Join(root, "update.exe")
	if err := os.Remove(bin); err != nil {
		t.Fatal(err)
	}
	if prebuilt := os.Getenv("SUNYU_UPDATE_TEST_UPDATER"); prebuilt != "" {
		if err := copyFile(prebuilt, bin); err != nil {
			t.Fatal(err)
		}
	} else {
		build := exec.Command("go", "build", "-o", bin, "./cmd/updater")
		build.Dir = updaterModuleRoot(t)
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build updater: %v %s", err, output)
		}
	}
	old.Files["update.exe"], _ = hashFile(bin)
	if err := writeJSON(filepath.Join(root, "app/manifest.json"), old); err != nil {
		t.Fatal(err)
	}
	c, err := NewController(root)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	next := testManifest("2.0.1", "frontend")
	archive := testArchive(t, next, map[string]string{"app/web/2.0.1/index.html": "new"})
	hash, _ := hashFile(archive)
	catalog := Catalog{Format: 2, Application: Application, Version: "2.0.1", BackendVersion: "2.0.0", FrontendVersion: "2.0.1", LauncherVersion: "2.0.0", APIVersion: 1, Packages: map[string]Archive{"frontend": {URL: "https://github.com/Vex9th/SunYu_ERP/releases/download/v2.0.1/front.zip", SHA256: hash}}}
	if err = writeJSON(filepath.Join(root, ".updates/catalog-v2.json"), catalog); err != nil {
		t.Fatal(err)
	}
	upload := filepath.Join(c.Root, ".updates/imports/request.zip")
	if err = copyFile(archive, upload); err != nil {
		t.Fatal(err)
	}
	id := "6e17b622-1dca-4fbe-9052-a21cc7fda9d7"
	if err = c.Import(upload, id); err != nil {
		t.Fatal(err)
	}
	original, err := c.Request(id)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.Import(upload, id); err != nil {
		t.Fatal("same request did not replay", err)
	}
	if err = c.Install("4edddf89-9572-4d0c-82b7-b0f1ee59f523"); !errors.Is(err, ErrBusy) {
		t.Fatal("second task entered handoff", err)
	}
	started := time.Now()
	c.Close()
	if time.Since(started) > 3*time.Second {
		t.Fatal("controller waited for installation on close")
	}
	got := awaitJob(t, c.Engine)
	if got.Status != "success" || got.ID != original.ID || got.OwnerPID <= 0 || got.OwnerPID == os.Getpid() || got.OwnerExe != filepath.Join(c.Root, ".updates/work", got.ID, "update.exe") {
		t.Fatalf("independent worker did not complete: %+v", got)
	}
	m, err := ReadManifest(root)
	if err != nil || m.FrontendVersion != "2.0.1" {
		t.Fatal(m, err)
	}
	if got.WorkerStartedAt == "" {
		t.Fatal("worker never confirmed acquisition of installer lock")
	}
	if _, err := os.Stat(filepath.Join(c.Root, ".updates/work", got.ID, "request.json")); err != nil {
		t.Fatal("active worker deleted recovery request", err)
	}
	// Wait for the independent executable to release its image before test cleanup.
	for deadline := time.Now().Add(3 * time.Second); processMatches(got.OwnerExe, got.OwnerPID) && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}
	replay, err := NewController(root)
	if err != nil {
		t.Fatal(err)
	}
	defer replay.Close()
	if err = replay.Import(upload, id); err != nil {
		t.Fatal(err)
	}
	final, err := replay.Request(id)
	if err != nil || final.ID != got.ID || final.OwnerPID != got.OwnerPID {
		t.Fatal("replayed request launched second worker", final, err)
	}
	entries, _ := os.ReadDir(filepath.Join(root, ".updates/work"))
	if len(entries) != 1 {
		t.Fatal("duplicate dispatch created extra work directory", len(entries))
	}
}
func TestControllerHandoffReportsChildStartupError(t *testing.T) {
	root := t.TempDir()
	applicationFixture(t, root, "2.0.0")
	c, err := NewController(root)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	id := "464668b9-9b3c-48fa-8d18-4d757a6ebaa2"
	if err = c.Install(id); err != nil {
		t.Fatal(err)
	}
	if err = c.WaitHandoff(id); err == nil {
		t.Fatal("invalid executable spawn was reported successful")
	}
	j, err := c.Request(id)
	if err != nil || j.Status != "failed" {
		t.Fatal(j, err)
	}
}

func TestControllerRejectsExecutableExitingBeforeReady(t *testing.T) {
	root := t.TempDir()
	m := applicationFixture(t, root, "2.0.0")
	source := filepath.Join(t.TempDir(), "early-exit.go")
	if err := os.WriteFile(source, []byte("package main\nimport \"os\"\nfunc main(){os.Exit(42)}"), 0600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "update.exe")
	if err := os.Remove(bin); err != nil {
		t.Fatal(err)
	}
	if prebuilt := os.Getenv("SUNYU_UPDATE_TEST_EARLY_EXIT"); prebuilt != "" {
		if err := copyFile(prebuilt, bin); err != nil {
			t.Fatal(err)
		}
	} else if b, err := exec.Command("go", "build", "-o", bin, source).CombinedOutput(); err != nil {
		t.Fatal(err, string(b))
	}
	m.Files["update.exe"], _ = hashFile(bin)
	if err := writeJSON(filepath.Join(root, "app/manifest.json"), m); err != nil {
		t.Fatal(err)
	}
	c, err := NewController(root)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	id := "3f10ffbd-641a-444b-8ac5-1b11e1d7288f"
	if err = c.Install(id); err != nil {
		t.Fatal(err)
	}
	if err = c.WaitHandoff(id); err == nil {
		t.Fatal("successfully spawned but unready executable was accepted")
	}
	j, err := c.Request(id)
	if err != nil || j.Status != "failed" || j.WorkerStartedAt != "" {
		t.Fatal(j, err)
	}
}
func TestLateWorkerExitCannotOverwriteNewTaskEvenWhenArchiveWriteFails(t *testing.T) {
	for _, blocked := range []bool{false, true} {
		t.Run(map[bool]string{false: "normal", true: "archive_blocked"}[blocked], func(t *testing.T) {
			e := testEngine(t, t.TempDir())
			old := Job{ID: "old", RequestID: "ed119efd-a283-4f22-ae3f-95d7d7e8c739", Status: "checking", OwnerPID: 10}
			if err := e.saveJob(&old); err != nil {
				t.Fatal(err)
			}
			next := Job{ID: "new", RequestID: "674166af-b04f-4a1d-8553-4106974f4323", Status: "downloading", OwnerPID: 20}
			if err := e.saveJob(&next); err != nil {
				t.Fatal(err)
			}
			if blocked {
				if err := os.Remove(e.requestPath(old.RequestID)); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(e.requestPath(old.RequestID), 0700); err != nil {
					t.Fatal(err)
				}
			}
			e.observeExit(old, errors.New("late child exit"))
			got := e.currentJob()
			if got == nil || got.ID != next.ID || got.OwnerPID != 20 {
				t.Fatal("old observer replaced current job", got)
			}
			failed, err := e.Request(old.RequestID)
			if err != nil || failed.Status != "failed" {
				t.Fatal("old request lost exit failure", failed, err)
			}
		})
	}
}
func TestStatePersistenceRecoveryClearsOnlyItsOwnStaleFailure(t *testing.T) {
	e := testEngine(t, t.TempDir())
	j := Job{ID: "recover", RequestID: "3e5c3622-382d-49b8-824d-a8708f60595d", Status: "checking"}
	if err := e.saveJob(&j); err != nil {
		t.Fatal(err)
	}
	blocker := e.requestPath(j.RequestID)
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(blocker, 0700); err != nil {
		t.Fatal(err)
	}
	j.Status = "success"
	if err := e.saveJob(&j); err == nil {
		t.Fatal("write failure hidden")
	}
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	j.Status, j.Phase = "success", "success"
	if err := e.saveJob(&j); err != nil {
		t.Fatal(err)
	}
	got, err := e.Request(j.RequestID)
	if err != nil || got.Status != "success" || got.PersistenceError != "" || got.Error != "" {
		t.Fatal("stale persistence failure survived successful write", got, err)
	}
}

func updaterModuleRoot(t *testing.T) string {
	t.Helper()
	if configured := os.Getenv("SUNYU_UPDATE_TEST_SOURCE_ROOT"); configured != "" {
		return configured
	}
	current, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		for _, candidate := range []string{current, filepath.Join(current, "server")} {
			if _, err := os.Stat(filepath.Join(candidate, "cmd/updater/main.go")); err == nil {
				return candidate
			}
		}
		parent := filepath.Dir(current)
		if parent == current {
			t.Fatal("set SUNYU_UPDATE_TEST_SOURCE_ROOT to the server source directory for standalone test executables")
		}
		current = parent
	}
}

func TestRecoveryBusyUsesPublicError(t *testing.T) {
	e := testEngine(t, t.TempDir())
	release, err := lifecycle.Acquire(e.Root, "installer.lock")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err := LaunchRecovery(e.Root, "065d830f9630ab8e1154fae9"); !errors.Is(err, ErrBusy) {
		t.Fatal("recovery busy would leave root updater paused", err)
	}
}
func TestRootUpdaterRecoveryAcknowledgesNewWorkerAndKeepsRecoveryMetadata(t *testing.T) {
	root := t.TempDir()
	old := applicationFixture(t, root, "2.0.0")
	bin := filepath.Join(root, "update.exe")
	if err := os.Remove(bin); err != nil {
		t.Fatal(err)
	}
	if prebuilt := os.Getenv("SUNYU_UPDATE_TEST_UPDATER"); prebuilt != "" {
		if err := copyFile(prebuilt, bin); err != nil {
			t.Fatal(err)
		}
	} else {
		build := exec.Command("go", "build", "-o", bin, "./cmd/updater")
		build.Dir = updaterModuleRoot(t)
		if b, err := build.CombinedOutput(); err != nil {
			t.Fatal(err, string(b))
		}
	}
	old.Files["update.exe"], _ = hashFile(bin)
	if err := writeJSON(filepath.Join(root, "app/manifest.json"), old); err != nil {
		t.Fatal(err)
	}
	e := testEngine(t, root)
	id := "2810cc8c016b48e947b9f4e6"
	work, err := e.createWork(id)
	if err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(work, "stage")
	next := applicationFixture(t, stage, "2.0.1")
	if err = copyFile(bin, filepath.Join(stage, "update.exe")); err != nil {
		t.Fatal(err)
	}
	next.Files["update.exe"] = old.Files["update.exe"]
	writeJSON(filepath.Join(stage, "app/manifest.json"), next)
	data := filepath.Join(e.Root, "Data")
	os.Mkdir(data, 0700)
	os.WriteFile(filepath.Join(data, "record"), []byte("old"), 0600)
	j := Job{ID: id, RequestID: "3c1c6f24-8af5-4b7e-a068-02df4b0e8247", Status: "manual_recovery", OwnerPID: 2147483647, WorkerStartedAt: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)}
	tx := Transaction{Job: j, Manifest: next, Old: old, Stage: stage, State: "prepared"}
	if err = e.backup(&tx); err != nil {
		t.Fatal(err)
	}
	if err = e.replaceProgram(&tx); err != nil {
		t.Fatal(err)
	}
	tx.State = "verified"
	if err = e.saveTransaction(&tx); err != nil {
		t.Fatal(err)
	}
	if err = e.saveJob(&j); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(data, "record"), []byte("accepted business write"), 0600)
	if err = copyFile(bin, filepath.Join(work, "update.exe")); err != nil {
		t.Fatal(err)
	}
	if err = writeJSON(filepath.Join(work, "request.json"), workerRequest{Job: j, Mode: "import", UpdaterHash: old.Files["update.exe"]}); err != nil {
		t.Fatal(err)
	}
	release, err := lifecycle.Acquire(e.Root, "launcher.lock")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	cmd := exec.Command(bin, "--root", e.Root, "--no-pause")
	output, err := cmd.CombinedOutput()
	if err != nil {
		log, _ := os.ReadFile(filepath.Join(e.Root, ".updates/logs/update.log"))
		t.Fatal("root recovery handoff failed", err, string(output), string(log))
	}
	final := awaitJob(t, e)
	if final.Status != "success" || final.OwnerPID <= 0 || final.OwnerPID == j.OwnerPID || final.WorkerStartedAt == j.WorkerStartedAt {
		t.Fatal("root accepted stale recovery ACK", final)
	}
	var request workerRequest
	if err = readJSON(filepath.Join(work, "request.json"), &request); err != nil || request.ParentPID != cmd.Process.Pid {
		t.Fatal("root parent identity or recovery metadata missing", request.ParentPID, err)
	}
	b, _ := os.ReadFile(filepath.Join(data, "record"))
	if string(b) != "accepted business write" {
		t.Fatal("verified recovery changed data", string(b))
	}
	for deadline := time.Now().Add(3 * time.Second); processMatches(final.OwnerExe, final.OwnerPID) && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}
}
