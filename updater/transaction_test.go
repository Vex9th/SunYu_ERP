package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func transactionFixture(t *testing.T) (*Engine, Manifest, string) {
	t.Helper()
	e, err := newEngine(t.TempDir(), "3123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(e.root, "SunYu_ERP.exe"), []byte("old app"), 0700)
	os.WriteFile(filepath.Join(e.root, "update.exe"), []byte("old updater"), 0700)
	os.Mkdir(filepath.Join(e.root, "Data"), 0700)
	os.WriteFile(filepath.Join(e.root, "Data/iapm.sqlite"), []byte("customer database"), 0600)
	os.WriteFile(filepath.Join(e.root, "config.json"), []byte("{\"data_dir\": \"Data\", \"port\":8765}"), 0600)
	e.current = "1.2.4"
	m := manifestFixture()
	stage := filepath.Join(e.work, "stage")
	os.MkdirAll(stage, 0700)
	os.WriteFile(filepath.Join(stage, "SunYu_ERP.exe"), []byte("app"), 0700)
	os.WriteFile(filepath.Join(stage, "update.exe"), []byte("updater"), 0700)
	return e, m, stage
}
func TestFailedMigrationRestoresProgramDatabaseAndConfig(t *testing.T) {
	e, m, stage := transactionFixture(t)
	original, _ := os.ReadFile(filepath.Join(e.root, "config.json"))
	e.services = &fakeServices{running: true, failNew: true, root: e.root}
	if err := e.install(m, stage); err == nil {
		t.Fatal("failed startup reported success")
	}
	for name, want := range map[string]string{"SunYu_ERP.exe": "old app", "update.exe": "old updater", "Data/iapm.sqlite": "customer database", "config.json": string(original)} {
		b, err := os.ReadFile(filepath.Join(e.root, name))
		if err != nil || string(b) != want {
			t.Fatal(name, string(b), err)
		}
	}
}
func TestSuccessfulUpdatePreservesDataAndSelfUpdates(t *testing.T) {
	e, m, stage := transactionFixture(t)
	e.services = &fakeServices{running: true, root: e.root}
	before, _ := os.ReadFile(filepath.Join(e.root, "config.json"))
	if err := e.install(m, stage); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"SunYu_ERP.exe": "app", "update.exe": "updater", "Data/iapm.sqlite": "customer database", "config.json": string(before)} {
		b, err := os.ReadFile(filepath.Join(e.root, name))
		if err != nil || string(b) != want {
			t.Fatal(name, string(b), err)
		}
	}
	var barrier Installer
	if err := readJSON(filepath.Join(e.root, ".updates/install.json"), &barrier); err != nil || barrier.Phase != "verified" {
		t.Fatal(barrier, err)
	}
}
func TestUnsafeDataOverlapNeverStopsApplication(t *testing.T) {
	e, m, stage := transactionFixture(t)
	svc := &fakeServices{running: true}
	e.services = svc
	os.WriteFile(filepath.Join(e.root, "config.json"), []byte(`{"data_dir":".updates"}`), 0600)
	if err := e.install(m, stage); err == nil {
		t.Fatal("unsafe overlap accepted")
	}
	if svc.stops != 0 {
		t.Fatal("unsafe data stopped service")
	}
}
func TestVerifiedRecoveryNeverRevertsNewBusinessWrites(t *testing.T) {
	e, m, stage := transactionFixture(t)
	e.services = &fakeServices{running: true, root: e.root}
	if err := e.install(m, stage); err != nil {
		t.Fatal(err)
	}
	var tx Transaction
	if err := readJSON(filepath.Join(e.root, ".updates/transaction.json"), &tx); err != nil {
		t.Fatal(err)
	}
	tx.State = "verified"
	e.saveTx(&tx)
	os.WriteFile(filepath.Join(e.root, "Data/iapm.sqlite"), []byte("new business"), 0600)
	handled, err := e.recoverPending()
	if !handled || err != nil {
		t.Fatal(handled, err)
	}
	b, _ := os.ReadFile(filepath.Join(e.root, "Data/iapm.sqlite"))
	if string(b) != "new business" {
		t.Fatal("committed data reverted")
	}
}
func TestRestorePreservesDataRootAndExternalSymlink(t *testing.T) {
	e, m, stage := transactionFixture(t)
	external := t.TempDir()
	os.WriteFile(filepath.Join(external, "iapm.sqlite"), []byte("customer database"), 0600)
	link := filepath.Join(e.root, "external")
	if err := os.Symlink(external, link); err != nil {
		t.Skip(err)
	}
	os.WriteFile(filepath.Join(e.root, "config.json"), []byte(`{"data_dir":"external"}`), 0600)
	before, _ := os.Stat(external)
	e.services = &fakeServices{root: e.root, failNew: true}
	if err := e.install(m, stage); err == nil {
		t.Fatal("bad migration accepted")
	}
	after, _ := os.Stat(external)
	if !os.SameFile(before, after) {
		t.Fatal("data root identity changed")
	}
	if _, err := os.Readlink(link); err != nil {
		t.Fatal(err)
	}
}
func TestInterruptedPreparationCompletesTerminalStatus(t *testing.T) {
	e, _, _ := transactionFixture(t)
	e.services = &fakeServices{root: e.root}
	tx := Transaction{JobID: e.status.JobID, State: "rolled_back", OldVersion: "1.2.4", NewVersion: "1.2.5"}
	e.saveTx(&tx)
	e.barrier(&tx, "installing")
	handled, err := e.recoverPending()
	if !handled || err != nil {
		t.Fatal(handled, err)
	}
	if e.status.Busy || e.status.Phase != "failed" {
		t.Fatal(e.status)
	}
}
func TestCleanupRemovesOwnedPartialAndFailedWorkOnly(t *testing.T) {
	e, _, _ := transactionFixture(t)
	old := "6123456789abcdef0123456789abcdef"
	partial := filepath.Join(e.root, ".updates/backup", old+".partial")
	os.MkdirAll(partial, 0700)
	writeJSON(filepath.Join(partial, "owner.json"), map[string]string{"root": e.root, "job_id": old})
	os.WriteFile(filepath.Join(partial, "huge-data"), []byte("old incomplete copy"), 0600)
	unknown := filepath.Join(e.root, ".updates/backup", "customer.partial")
	os.MkdirAll(unknown, 0700)
	if err := e.cleanup(""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatal("owned partial survives", err)
	}
	if _, err := os.Stat(unknown); err != nil {
		t.Fatal("customer folder removed", err)
	}
}

type detectServices struct {
	fakeServices
	detected string
}

func (f *detectServices) detect() (string, error) { f.running = true; return f.detected, nil }
func (f *detectServices) start(v string) error {
	f.running = true
	if v != f.detected {
		os.WriteFile(filepath.Join(f.root, "Data/iapm.sqlite"), []byte("broken migrated DB"), 0600)
		return fmt.Errorf("bad new version %s", v)
	}
	return nil
}
func TestClosedUnknownProgramDetectsActualRollbackVersion(t *testing.T) {
	e, m, stage := transactionFixture(t)
	e.current = ""
	m.Version = "1.2.6"
	m.Archive.URL = strings.ReplaceAll(m.Archive.URL, "1.2.5", "1.2.6")
	e.services = &detectServices{fakeServices: fakeServices{root: e.root}, detected: "1.2.5"}
	if err := e.install(m, stage); err == nil {
		t.Fatal("failed migration accepted")
	}
	var tx Transaction
	readJSON(filepath.Join(e.root, ".updates/transaction.json"), &tx)
	if tx.OldVersion != "1.2.5" || tx.State != "rolled_back" {
		t.Fatal(tx)
	}
	var barrier Installer
	readJSON(filepath.Join(e.root, ".updates/install.json"), &barrier)
	if barrier.Phase != "verified" {
		t.Fatal("old version did not recover", barrier)
	}
	b, _ := os.ReadFile(filepath.Join(e.root, "Data/iapm.sqlite"))
	if string(b) != "customer database" {
		t.Fatal(string(b))
	}
}
