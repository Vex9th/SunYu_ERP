package update

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanupOnlyCollectsOwnedTerminalWork(t *testing.T) {
	e, _ := New(t.TempDir())
	old := "aaaaaaaaaaaaaaaaaaaaaaaa"
	current := "bbbbbbbbbbbbbbbbbbbbbbbb"
	for _, id := range []string{old, current} {
		p, err := e.createWork(id)
		if err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(p, "download.zip"), []byte("cache"), 0600)
	}
	foreign := filepath.Join(e.Root, ".updates/work/cccccccccccccccccccccccc")
	os.MkdirAll(foreign, 0700)
	os.WriteFile(filepath.Join(foreign, "notes"), []byte("user"), 0600)
	if err := e.cleanupWork(current, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(e.Root, ".updates/work", old)); !os.IsNotExist(err) {
		t.Fatal("old owned cache remains")
	}
	for _, p := range []string{filepath.Join(e.Root, ".updates/work", current), foreign} {
		if _, err := os.Stat(p); err != nil {
			t.Fatal("unrelated/current work deleted", p)
		}
	}
}
func TestPendingCleanupSurvivesFailureAndRetriesLater(t *testing.T) {
	e, _ := New(t.TempDir())
	m := testManifest("2.0.1", "frontend")
	installFixture(t, e.Root, m, map[string]string{"app/web/2.0.1/index.html": "new", "app/web/1.9.0/index.html": "old"})
	if err := e.queueCleanup(map[string]string{"app/web/1.9.0/index.html": digest("old")}); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(e.Root, "app/web/1.9.0")
	outside := filepath.Join(t.TempDir(), "old-web")
	if err := os.Rename(source, outside); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, source); err != nil {
		t.Skip(err)
	}
	if err := e.retryCleanup(); err == nil {
		t.Fatal("unsafe cleanup unexpectedly succeeded")
	}
	var pending map[string]string
	if err := readJSON(filepath.Join(e.Root, ".updates/cleanup.json"), &pending); err != nil || len(pending) != 1 {
		t.Fatal("failed cleanup lost ownership", pending, err)
	}
	os.Remove(source)
	if err := os.Rename(outside, source); err != nil {
		t.Fatal(err)
	}
	if err := e.retryCleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(source, "index.html")); !os.IsNotExist(err) {
		t.Fatal("old file never retried")
	}
	pending = nil
	readJSON(filepath.Join(e.Root, ".updates/cleanup.json"), &pending)
	if len(pending) != 0 {
		t.Fatal(pending)
	}
}
func TestLegacyBackupCleanupRequiresExactManifestAndPreservesUnknownFiles(t *testing.T) {
	e, _ := New(t.TempDir())
	data := filepath.Join(e.Root, "Data")
	for _, id := range []string{"11111111111111111111111111111111", "22222222222222222222222222222222"} {
		dir := filepath.Join(e.Root, ".updates/backups", id)
		os.MkdirAll(filepath.Join(dir, "Data"), 0700)
		os.WriteFile(filepath.Join(dir, "Data/db"), []byte("old backup"), 0600)
		writeJSON(filepath.Join(dir, "backup.json"), map[string]any{"data_dir": data, "files": map[string]string{"Data/db": digest("old backup")}})
		if id[0] == '2' {
			os.WriteFile(filepath.Join(dir, "customer-note.txt"), []byte("keep"), 0600)
		}
	}
	files, err := e.legacyBackupFiles(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("expected first snapshot files only, got %+v", files)
	}
	for p := range files {
		if strings.Contains(p, "222222") {
			t.Fatal("snapshot containing unknown user file was selected")
		}
	}
}
