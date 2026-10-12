package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Independent recovery review: damaged durable state must never permit a normal
// launcher to start a potentially half-installed program.
func TestReviewDamagedTransactionBlocksLaunch(t *testing.T) {
	for _, state := range []string{`{"job":`, `{"state":"replacing","job":{"status":"installing"}}`} {
		t.Run(state, func(t *testing.T) {
			e, err := New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(e.Root, ".updates", "transaction-v2.json"), []byte(state), 0600); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(e.Root, ".updates", "maintenance"), []byte("active"), 0600); err != nil {
				t.Fatal(err)
			}
			handedOff, err := PrepareLaunch(e.Root, "")
			if err == nil && !handedOff {
				t.Fatal("damaged update transaction allowed ordinary service startup")
			}
		})
	}
}

func TestReviewLegacyUnknownRuntimeFileIsNotOwned(t *testing.T) {
	e, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	installation := `{"format":1,"backend":"1.3.1","frontend":"1.3.1","api_version":1,"runtime_version":1}`
	if err = os.WriteFile(filepath.Join(e.Root, "installation.json"), []byte(installation), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(e.Root, "runtime", "_internal"), 0700); err != nil {
		t.Fatal(err)
	}
	name := "runtime/_internal/customer-addon.dll"
	if err = os.WriteFile(filepath.Join(e.Root, filepath.FromSlash(name)), []byte("user-added plugin"), 0600); err != nil {
		t.Fatal(err)
	}
	owned, err := legacyInventory(e.Root)
	if err != nil {
		t.Fatal(err)
	}
	if _, present := owned[name]; present {
		t.Fatal("file extension alone made a user-added DLL eligible for deletion")
	}
}

func TestReviewFrontendRechecksStagedContentBeforeSwitch(t *testing.T) {
	e, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := testManifest("2.0.0", "frontend")
	old.Component = ""
	installFixture(t, e.Root, old, map[string]string{"app/web/2.0.0/index.html": "new"})
	next := testManifest("2.0.1", "frontend")
	stage := t.TempDir()
	installFixture(t, stage, next, map[string]string{"app/web/2.0.1/index.html": "tampered after extraction"})
	err = e.installFrontend(&Job{ID: "review", Status: "installing"}, next, stage)
	if err == nil {
		t.Fatal("frontend selected a staged file that differs from its verified manifest")
	}
	installed, err := ReadManifest(e.Root)
	if err != nil || installed.FrontendVersion != old.FrontendVersion {
		t.Fatal("failed verification changed the active frontend", installed, err)
	}
}

func TestReviewLaunchRejectsIncompleteManagedInstallation(t *testing.T) {
	for _, problem := range []string{"missing_frontend", "changed_service"} {
		t.Run(problem, func(t *testing.T) {
			e, err := New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			applicationFixture(t, e.Root, "2.0.0")
			if problem == "missing_frontend" {
				err = os.Remove(filepath.Join(e.Root, "app/web/2.0.0/index.html"))
			} else {
				err = os.WriteFile(filepath.Join(e.Root, "app/SunYuService.exe"), []byte("partial or wrong version"), 0700)
			}
			if err != nil {
				t.Fatal(err)
			}
			handedOff, err := PrepareLaunch(e.Root, "")
			if err == nil && !handedOff {
				t.Fatal("incomplete managed installation was allowed to launch")
			}
		})
	}
}

func TestReviewRestoreRejectsMissingSnapshotMetadata(t *testing.T) {
	e, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := applicationFixture(t, e.Root, "2.0.0")
	if err = os.Mkdir(filepath.Join(e.Root, "Data"), 0700); err != nil {
		t.Fatal(err)
	}
	dataFile := filepath.Join(e.Root, "Data", "iapm.sqlite")
	if err = os.WriteFile(dataFile, []byte("original database"), 0600); err != nil {
		t.Fatal(err)
	}
	tx := Transaction{Job: Job{ID: "aaaaaaaaaaaaaaaaaaaaaaaa", Status: "installing"}, Manifest: old, Old: old, Stage: t.TempDir()}
	if err = e.backup(&tx); err != nil {
		t.Fatal(err)
	}
	// A valid JSON document can still lose a field. The backup's ownership and
	// snapshot metadata must be checked before false/empty defaults are trusted.
	tx.DataExisted = false
	if err = e.restore(&tx); err == nil {
		t.Error("restore accepted transaction metadata that contradicts its durable backup")
	}
	data, err := os.ReadFile(dataFile)
	if err != nil || string(data) != "original database" {
		t.Fatal("damaged transaction metadata removed or changed the original database", err)
	}
}

func TestReviewLegacySnapshotCleanupPreservesRecoveryAndUnknownData(t *testing.T) {
	e, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m := applicationFixture(t, e.Root, "2.0.0")
	dataDir := filepath.Join(e.Root, "Data")
	if err = os.Mkdir(dataDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dataDir, "live-db"), []byte("current business data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = writeJSON(filepath.Join(e.Root, "config.json"), map[string]string{"data_dir": "Data", "backup_dir": "BusinessBackups"}); err != nil {
		t.Fatal(err)
	}
	makeSnapshot := func(base string, id int, data string) string {
		t.Helper()
		dir := filepath.Join(base, fmt.Sprintf("%032x", id))
		if err := os.MkdirAll(filepath.Join(dir, "Data"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "Data", "db"), []byte("snapshot"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := writeJSON(filepath.Join(dir, "backup.json"), map[string]any{"data_dir": data, "files": map[string]string{"Data/db": digest("snapshot")}}); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	base := filepath.Join(e.Root, ".updates", "backups")
	valid := makeSnapshot(base, 1, dataDir)
	changed := makeSnapshot(base, 2, dataDir)
	if err = os.WriteFile(filepath.Join(changed, "Data", "db"), []byte("modified snapshot"), 0600); err != nil {
		t.Fatal(err)
	}
	foreignData := makeSnapshot(base, 3, filepath.Join(e.Root, "OtherData"))
	unknown := makeSnapshot(base, 4, dataDir)
	if err = os.WriteFile(filepath.Join(unknown, "customer-note.txt"), []byte("customer content"), 0600); err != nil {
		t.Fatal(err)
	}
	protected := []string{
		filepath.Join(dataDir, "live-db"),
		filepath.Join(changed, "Data", "db"),
		filepath.Join(foreignData, "Data", "db"),
		filepath.Join(unknown, "Data", "db"),
		filepath.Join(unknown, "customer-note.txt"),
		filepath.Join(makeSnapshot(filepath.Join(e.Root, "BusinessBackups"), 5, dataDir), "Data", "db"),
	}
	linked := makeSnapshot(base, 6, dataDir)
	linkPath := filepath.Join(linked, "Data", "db")
	if err = os.Remove(linkPath); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(filepath.Join(dataDir, "live-db"), linkPath); err == nil {
		protected = append(protected, linkPath, filepath.Join(linked, "backup.json"))
	} else {
		t.Logf("symlink fixture unavailable on this platform: %v", err)
	}
	tx := Transaction{Job: Job{ID: strings.Repeat("a", 24), Status: "cleaning"}, State: "verified", Manifest: m, DataDir: dataDir}
	tx.Backup = filepath.Join(e.Root, ".updates", "rollback", tx.Job.ID)
	if err = os.MkdirAll(tx.Backup, 0700); err != nil {
		t.Fatal(err)
	}
	if err = writeJSON(filepath.Join(tx.Backup, "backup.json"), tx); err != nil {
		t.Fatal(err)
	}
	protected = append(protected, filepath.Join(tx.Backup, "backup.json"))
	if err = e.cleanup(&tx); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(valid); !os.IsNotExist(err) {
		t.Fatal("verified legacy snapshot was not collected", err)
	}
	for _, p := range protected {
		if _, err := os.Lstat(p); err != nil {
			t.Fatal("cleanup touched current recovery, business backup or unknown data", p, err)
		}
	}
}

func TestReviewLegacySnapshotChangedAfterDiscoveryIsPreserved(t *testing.T) {
	e, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	applicationFixture(t, e.Root, "2.0.0")
	dataDir := filepath.Join(e.Root, "Data")
	dir := filepath.Join(e.Root, ".updates", "backups", strings.Repeat("b", 32))
	if err = os.MkdirAll(filepath.Join(dir, "Data"), 0700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "Data", "db")
	if err = os.WriteFile(p, []byte("snapshot"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = writeJSON(filepath.Join(dir, "backup.json"), map[string]any{"data_dir": dataDir, "files": map[string]string{"Data/db": digest("snapshot")}}); err != nil {
		t.Fatal(err)
	}
	files, err := e.legacyBackupFiles(dataDir)
	if err != nil || len(files) != 2 {
		t.Fatal(files, err)
	}
	if err = e.queueCleanup(files); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(p, []byte("later customer change"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = e.retryCleanup(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(p)
	if err != nil || string(content) != "later customer change" {
		t.Fatal("cleanup deleted a snapshot changed after discovery", err)
	}
}
