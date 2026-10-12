package update

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"sunyu.local/erp/internal/lifecycle"
)

func applicationFixture(t *testing.T, root, version string) Manifest {
	m := testManifest(version, "application")
	m.BackendVersion, m.LauncherVersion = version, version
	m.Files["SunYu_ERP.exe"] = digest("launcher" + version)
	m.Files["app/SunYuService.exe"] = digest("service" + version)
	installFixture(t, root, m, map[string]string{"SunYu_ERP.exe": "launcher" + version, "app/SunYuService.exe": "service" + version, "app/web/" + version + "/index.html": "new"})
	return m
}
func TestTransactionRollbackRestoresExactDataConfigAndProgram(t *testing.T) {
	root := t.TempDir()
	old := applicationFixture(t, root, "2.0.0")
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(parent, "custom-data")
	os.MkdirAll(data, 0700)
	os.WriteFile(filepath.Join(data, "iapm.sqlite"), []byte("original database"), 0600)
	config := `{"data_dir":` + quoteJSON(data) + `, "secret_extra_spacing": 1}`
	os.WriteFile(filepath.Join(root, "config.json"), []byte(config), 0600)
	stage := t.TempDir()
	next := applicationFixture(t, stage, "2.0.1")
	e, _ := New(root)
	tx := Transaction{Job: Job{ID: "failure", Status: "installing"}, Manifest: next, Stage: stage, Old: old}
	if err := e.backup(&tx); err != nil {
		t.Fatal(err)
	}
	if err := e.replaceProgram(&tx); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(data, "iapm.sqlite"), []byte("migrated"), 0600)
	os.WriteFile(filepath.Join(data, "new-migration-file"), []byte("new"), 0600)
	if err := e.restore(&tx); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(data, "iapm.sqlite"))
	if string(b) != "original database" {
		t.Fatal(string(b))
	}
	if _, err := os.Stat(filepath.Join(data, "new-migration-file")); !os.IsNotExist(err) {
		t.Fatal("new migration data retained")
	}
	b, _ = os.ReadFile(filepath.Join(root, "config.json"))
	if string(b) != config {
		t.Fatal("config bytes changed")
	}
	b, _ = os.ReadFile(filepath.Join(root, "app/SunYuService.exe"))
	if string(b) != "service2.0.0" {
		t.Fatal("old service not restored")
	}
}
func TestBackupRefusesDataSymlinkAndUnsafeOverlap(t *testing.T) {
	for _, kind := range []string{"symlink", "root", "updates", "app"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			applicationFixture(t, root, "2.0.0")
			data := filepath.Join(root, "Data")
			if err := os.MkdirAll(data, 0700); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "symlink":
				if err := os.Symlink(t.TempDir(), filepath.Join(data, "linked")); err != nil {
					t.Skip(err)
				}
			case "root":
				data = root
			case "updates":
				data = filepath.Join(root, ".updates")
			case "app":
				data = filepath.Join(root, "app")
			}
			if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(`{"data_dir":`+quoteJSON(data)+`}`), 0600); err != nil {
				t.Fatal(err)
			}
			e := testEngine(t, root)
			tx := Transaction{Job: Job{ID: "bad"}, Stage: t.TempDir()}
			if err := e.backup(&tx); err == nil {
				normalized, normalizeErr := filepath.EvalSymlinks(data)
				t.Fatalf("unsafe data backup accepted: original root=%q canonical root=%q configured data=%q resolved data=%q resolve error=%v backup data=%q", root, e.Root, data, normalized, normalizeErr, tx.DataDir)
			}
		})
	}
}

func TestPathComparisonPreservesExternalDataConfiguration(t *testing.T) {
	e := testEngine(t, t.TempDir())
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(parent, "customer", "not-created")
	configuration := []byte(`{"data_dir":` + quoteJSON(data) + `, "original_spacing": 1}`)
	if err := os.WriteFile(filepath.Join(e.Root, "config.json"), configuration, 0600); err != nil {
		t.Fatal(err)
	}
	got, _, err := installationPaths(e.Root)
	if err != nil || got != data {
		t.Fatalf("valid external Data changed or rejected: %q %v", got, err)
	}
	after, err := os.ReadFile(filepath.Join(e.Root, "config.json"))
	if err != nil || string(after) != string(configuration) {
		t.Fatal("config bytes changed")
	}
	if _, err := os.Stat(filepath.Join(parent, "customer")); !os.IsNotExist(err) {
		t.Fatal("path validation created Data directories")
	}
}
func TestRestoreRejectsDamagedBackupBeforeDeletingData(t *testing.T) {
	root := t.TempDir()
	m := applicationFixture(t, root, "2.0.0")
	os.Mkdir(filepath.Join(root, "Data"), 0700)
	os.WriteFile(filepath.Join(root, "Data/iapm.sqlite"), []byte("original"), 0600)
	e, _ := New(root)
	tx := Transaction{Job: Job{ID: "tamper"}, Manifest: m, Old: m, Stage: t.TempDir()}
	if err := e.backup(&tx); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(tx.Backup, "data/iapm.sqlite"), []byte("tampered"), 0600)
	if err := e.restore(&tx); err == nil {
		t.Fatal("damaged backup restored")
	}
	b, _ := os.ReadFile(filepath.Join(root, "Data/iapm.sqlite"))
	if string(b) != "original" {
		t.Fatal("data was removed before backup verification")
	}
}
func TestInterruptedTransactionNeverResumesApplicationWithoutRecovery(t *testing.T) {
	root := t.TempDir()
	e, _ := New(root)
	tx := Transaction{Job: Job{ID: "interrupted", Status: "installing"}}
	writeJSON(filepath.Join(root, ".updates/transaction-v2.json"), tx)
	if err := e.Install("019fa1ef-4ccc-73f7-925e-70a07cd29299"); !errors.Is(err, ErrBusy) {
		t.Fatal(err)
	}
}
func quoteJSON(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestNativeTransactionDoesNotOverwritePythonRecoveryState(t *testing.T) {
	e, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	legacy := []byte(`{"id":"legacy","previous":{"backend":"1.3.1"},"phase":"prepared"}`)
	p := filepath.Join(e.Root, ".updates", "transaction.json")
	if err := os.WriteFile(p, legacy, 0600); err != nil {
		t.Fatal(err)
	}
	tx := Transaction{Job: Job{ID: "1234567890abcdef12345678", Status: "failed"}, State: "rolled_back"}
	if err := e.saveTransaction(&tx); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(p)
	if err != nil || string(got) != string(legacy) {
		t.Fatalf("native rollback corrupted Python recovery state: %q %v", got, err)
	}
	id, pending, err := pendingState(e.Root)
	if err != nil || pending || id != tx.Job.ID {
		t.Fatalf("native state cannot resume independently: %s %v %v", id, pending, err)
	}
}

func TestMigrationRefusesUnfinishedPythonTransaction(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".updates"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "installation.json"), []byte(`{"format":1,"backend":"1.3.1","frontend":"1.3.1","api_version":1,"runtime_version":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".updates", "transaction.json"), []byte(`{"phase":"prepared"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := legacyInventory(root); err == nil {
		t.Fatal("migration ignored unfinished Python recovery transaction")
	}
}

func TestRollbackDoesNotClaimRecoveryWhenPreviousLauncherCannotStart(t *testing.T) {
	e, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	old := applicationFixture(t, e.Root, "2.0.0")
	if err := os.Mkdir(filepath.Join(e.Root, "Data"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.Root, "Data", "db"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	stage := t.TempDir()
	next := applicationFixture(t, stage, "2.0.1")
	tx := Transaction{Job: Job{ID: "1234567890abcdef12345678", Status: "installing"}, Manifest: next, Old: old, Stage: stage}
	if err := e.backup(&tx); err != nil {
		t.Fatal(err)
	}
	if err := e.replaceProgram(&tx); err != nil {
		t.Fatal(err)
	}
	if err := e.mark("maintenance"); err != nil {
		t.Fatal(err)
	}
	if err := e.rollbackFailure(&tx, func() {}, errors.New("new version failed")); err == nil {
		t.Fatal("launcher fixture cannot execute but rollback reported success")
	}
	if tx.Job.Status != "manual_recovery" {
		t.Fatalf("previous service never started yet reported recovered: %+v", tx.Job)
	}
	if _, err := os.Stat(filepath.Join(e.Root, ".updates", "maintenance")); err != nil {
		t.Fatal("failed recovery unblocked business before health confirmation")
	}
	b, err := os.ReadFile(filepath.Join(e.Root, "Data", "db"))
	if err != nil || string(b) != "original" {
		t.Fatalf("original data not restored: %q %v", b, err)
	}
}

func TestVerifiedCleanupFailureAndInterruptedCleanupKeepNewBusinessWrites(t *testing.T) {
	root := t.TempDir()
	e, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	root = e.Root
	old := applicationFixture(t, root, "2.0.0")
	if err := os.Mkdir(filepath.Join(root, "Data"), 0700); err != nil {
		t.Fatal(err)
	}
	database := filepath.Join(root, "Data", "iapm.sqlite")
	if err := os.WriteFile(database, []byte("before update"), 0600); err != nil {
		t.Fatal(err)
	}
	id := "1234567890abcdef12345678"
	stage := filepath.Join(root, ".updates", "work", id, "stage")
	next := applicationFixture(t, stage, "2.0.1")
	tx := Transaction{Job: Job{ID: id, Status: "restarting"}, Old: old, Manifest: next, Stage: stage}
	if err := e.backup(&tx); err != nil {
		t.Fatal(err)
	}
	if err := e.replaceProgram(&tx); err != nil {
		t.Fatal(err)
	}
	tx.State = "verified"
	if err := e.saveTransaction(&tx); err != nil {
		t.Fatal(err)
	}
	if err := e.mark("maintenance"); err != nil {
		t.Fatal(err)
	}
	if err := e.releaseVerifiedMaintenance(&tx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, ".updates", "maintenance")); !os.IsNotExist(err) {
		t.Fatal("business barrier was not lifted after durable verification")
	}
	if err := os.WriteFile(database, []byte("business write after verified"), 0600); err != nil {
		t.Fatal(err)
	}
	// Force an actual cleanup filesystem failure, then emulate helper termination.
	if err := os.WriteFile(filepath.Join(root, ".updates", "backups"), []byte("unrelated file"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := e.cleanup(&tx); err == nil {
		t.Fatal("cleanup failure was not exercised")
	}
	release, err := lifecycle.Acquire(root, "launcher.lock")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	// Recovery must not wait for the running launcher or stop/restore current Data.
	if err := RunHelper(root, id); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(database)
	if err != nil || string(b) != "business write after verified" {
		t.Fatalf("committed data rolled back: %q %v", b, err)
	}
	for _, marker := range []string{"maintenance", "shutdown", "stop"} {
		if _, err := os.Stat(filepath.Join(root, ".updates", marker)); !os.IsNotExist(err) {
			t.Fatalf("cleanup recovery stopped business via %s", marker)
		}
	}
	var after Transaction
	if err := readJSON(filepath.Join(root, ".updates", "transaction-v2.json"), &after); err != nil {
		t.Fatal(err)
	}
	if after.State != "completed" || after.Job.Status != "success" || after.Job.Message == "更新完成" {
		t.Fatalf("cleanup failure missing from final state: %+v", after.Job)
	}
	manifest, err := ReadManifest(root)
	if err != nil || manifest.BackendVersion != "2.0.1" {
		t.Fatal("recovered old program after verified")
	}
}

func TestReleaseMaintenanceRequiresDurableVerification(t *testing.T) {
	e, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	tx := Transaction{Job: Job{ID: "1234567890abcdef12345678", Status: "restarting"}, State: "starting"}
	if err := e.saveTransaction(&tx); err != nil {
		t.Fatal(err)
	}
	if err := e.mark("maintenance"); err != nil {
		t.Fatal(err)
	}
	tx.State = "verified"
	if err := e.releaseVerifiedMaintenance(&tx); err == nil {
		t.Fatal("in-memory verification bypassed durable commit")
	}
	if _, err := os.Stat(filepath.Join(e.Root, ".updates", "maintenance")); err != nil {
		t.Fatal("maintenance removed before durable commit")
	}
}
func TestRestoreResumesEveryDataContentsInterruption(t *testing.T) {
	for _, point := range []string{"before_delete", "after_delete", "partial_copy", "after_data", "after_program"} {
		t.Run(point, func(t *testing.T) {
			e := testEngine(t, t.TempDir())
			old := applicationFixture(t, e.Root, "2.0.0")
			data := filepath.Join(e.Root, "Data")
			if err := os.Mkdir(data, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(data, "iapm.sqlite"), []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			identity, err := os.Stat(data)
			if err != nil {
				t.Fatal(err)
			}
			tx := Transaction{Job: Job{ID: "resume"}, Manifest: old, Old: old}
			if err := e.backup(&tx); err != nil {
				t.Fatal(err)
			}
			tx.State, tx.RestorePhase = "restoring", "data"
			if err := os.WriteFile(filepath.Join(data, "iapm.sqlite"), []byte("migrated"), 0600); err != nil {
				t.Fatal(err)
			}
			if point != "before_delete" {
				if err := os.Remove(filepath.Join(data, "iapm.sqlite")); err != nil {
					t.Fatal(err)
				}
			}
			if point == "partial_copy" {
				if err := os.WriteFile(filepath.Join(data, "iapm.sqlite"), []byte("partial"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if point == "after_data" || point == "after_program" {
				if err := copyTree(filepath.Join(tx.Backup, "data"), data, tx.DataFiles, tx.DataDirs); err != nil {
					t.Fatal(err)
				}
			}
			if point == "after_program" {
				tx.RestorePhase = "program"
			}
			if err := e.saveTransaction(&tx); err != nil {
				t.Fatal(err)
			}
			// Reopen both the engine and durable transaction to model process loss.
			restarted := testEngine(t, e.Root)
			var recovered Transaction
			if err := readJSON(filepath.Join(e.Root, ".updates", "transaction-v2.json"), &recovered); err != nil {
				t.Fatal(err)
			}
			if err := restarted.restore(&recovered); err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(filepath.Join(data, "iapm.sqlite"))
			if err != nil || string(b) != "original" {
				t.Fatal("restored data incorrect", string(b), err)
			}
			after, err := os.Stat(data)
			if err != nil || !os.SameFile(identity, after) {
				t.Fatal("Data root object was replaced")
			}
			if err := restarted.restore(&recovered); err != nil {
				t.Fatal("finished restore is not idempotent", err)
			}
		})
	}
}

func TestRestorePreservesMissingOrReplacedDataRootForManualRecovery(t *testing.T) {
	for _, scenario := range []string{"missing", "replaced", "created_after_backup"} {
		t.Run(scenario, func(t *testing.T) {
			e := testEngine(t, t.TempDir())
			m := applicationFixture(t, e.Root, "2.0.0")
			data := filepath.Join(e.Root, "Data")
			if scenario != "created_after_backup" {
				if err := os.Mkdir(data, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(data, "original"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			tx := Transaction{Job: Job{ID: "identity"}, Manifest: m, Old: m}
			if err := e.backup(&tx); err != nil {
				t.Fatal(err)
			}
			if scenario != "created_after_backup" {
				if err := os.Rename(data, data+"-moved"); err != nil {
					t.Fatal(err)
				}
			}
			if scenario != "missing" {
				if err := os.Mkdir(data, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(data, "unknown"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := e.restore(&tx); err == nil {
				t.Fatal("unverifiable Data root accepted for automatic recovery")
			}
			if scenario != "missing" {
				b, err := os.ReadFile(filepath.Join(data, "unknown"))
				if err != nil || string(b) != "keep" {
					t.Fatal("unknown Data root was modified")
				}
			}
		})
	}
}

func TestBackupResumesOwnedInterruptedPartialCopy(t *testing.T) {
	root := t.TempDir()
	m := applicationFixture(t, root, "2.0.0")
	os.Mkdir(filepath.Join(root, "Data"), 0700)
	os.WriteFile(filepath.Join(root, "Data/db"), []byte("original"), 0600)
	e, _ := New(root)
	tx := Transaction{Job: Job{ID: "backupresume"}, Old: m, Manifest: m, Stage: t.TempDir()}
	partial := filepath.Join(e.Root, ".updates/rollback/backupresume.partial")
	os.MkdirAll(partial, 0700)
	writeJSON(filepath.Join(partial, "owner.json"), map[string]string{"application": Application, "id": tx.Job.ID})
	os.Mkdir(filepath.Join(partial, "data"), 0700)
	os.WriteFile(filepath.Join(partial, "data/db"), []byte("partial"), 0600)
	if err := e.backup(&tx); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(tx.Backup, "data/db"))
	if string(b) != "original" {
		t.Fatal(string(b))
	}
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatal("partial backup retained")
	}
	tx.State = "prepared"
	if err := e.backup(&tx); err != nil {
		t.Fatal("completed snapshot cannot resume after missing transaction checkpoint", err)
	}
}
func TestRestoreRejectsIncompleteTransactionMetadataBeforeChanges(t *testing.T) {
	root := t.TempDir()
	m := applicationFixture(t, root, "2.0.0")
	os.Mkdir(filepath.Join(root, "Data"), 0700)
	os.WriteFile(filepath.Join(root, "Data/db"), []byte("keep"), 0600)
	e, _ := New(root)
	tx := Transaction{Job: Job{ID: "metadata"}, Old: m, Manifest: m}
	if err := e.backup(&tx); err != nil {
		t.Fatal(err)
	}
	tx.ProgramFiles = nil
	tx.DataExisted = false
	if err := e.restore(&tx); err == nil {
		t.Fatal("incomplete restore transaction accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "SunYu_ERP.exe")); err != nil {
		t.Fatal("program removed")
	}
	b, _ := os.ReadFile(filepath.Join(root, "Data/db"))
	if string(b) != "keep" {
		t.Fatal("data changed")
	}
}
