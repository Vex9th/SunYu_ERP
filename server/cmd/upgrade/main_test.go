package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStageArchiveRejectsLinkedImportDirectory(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".updates"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, ".updates", "imports")); err != nil {
		t.Skipf("links unavailable: %v", err)
	}
	source := filepath.Join(root, "official.zip")
	if err := os.WriteFile(source, []byte("test archive"), 0600); err != nil {
		t.Fatal(err)
	}
	_, cleanup, err := stageArchive(root, source, "request")
	if cleanup != nil {
		defer cleanup()
	}
	if err == nil {
		t.Fatal("staged an archive through a symbolic link")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("modified unrelated directory: %v %v", entries, err)
	}
}

func TestStageArchiveCleanupPreservesReplacement(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "official.zip")
	if err := os.WriteFile(source, []byte("official test archive"), 0600); err != nil {
		t.Fatal(err)
	}
	p, cleanup, err := stageArchive(root, source, "request")
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(p)
	if err != nil || string(got) != "official test archive" {
		t.Fatalf("archive: %q %v", got, err)
	}
	if err := os.Rename(p, p+".moved"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("unrelated replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	cleanup()
	got, err = os.ReadFile(p)
	if err != nil || string(got) != "unrelated replacement" {
		t.Fatalf("deleted replacement: %q %v", got, err)
	}
}
