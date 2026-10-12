package main

import (
	"os"
	"path/filepath"
	"sunyu.local/updater/internal/lifecycle"
	"testing"
)

func TestUpdaterLockExcludesRepeatedClicks(t *testing.T) {
	root := t.TempDir()
	release, err := lifecycle.Acquire(root, "updater.lock")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err = lifecycle.Acquire(root, "updater.lock"); err != lifecycle.ErrBusy {
		t.Fatal("duplicate updater acquired lock", err)
	}
}
func TestWorkerRejectsWrongExecutableAndMissingRequest(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "4123456789abcdef0123456789abcdef")
	if err := runWorker(e, "wrong"); err == nil {
		t.Fatal("unowned worker allowed")
	}
}
func TestBootstrapFailureIsTerminal(t *testing.T) {
	e, _ := newEngine(t.TempDir(), "5123456789abcdef0123456789abcdef")
	os.MkdirAll(e.work, 0700)
	if err := bootstrap(e, "missing-updater-file", false, nil); err == nil {
		t.Fatal("missing executable accepted")
	}
	var s Status
	if err := readJSON(filepath.Join(e.root, ".updates/status.json"), &s); err != nil || s.Busy || s.Phase != "failed" {
		t.Fatal(s, err)
	}
	if err := readJSON(filepath.Join(e.root, ".updates/last-install.json"), &s); err != nil || s.Busy || s.Phase != "failed" {
		t.Fatal(s, err)
	}
}
