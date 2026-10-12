package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExistingConfigPreserved(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "config.json")
	original := []byte(`{"data_dir":"客户资料","session_secret":"keep-this-secret","port":18881}`)
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	s, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if s.DataDir != filepath.Join(resolvedRoot, "客户资料") || s.Port != 18881 {
		t.Fatal(s)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(original) {
		t.Fatal("existing config rewritten")
	}
}

func TestConfigRejectsWrongTypes(t *testing.T) {
	for _, raw := range []string{`{"port":true}`, `{"port":0}`, `{"backup_enabled":"yes"}`, `{"data_dir":null}`, `{"unknown":1}`} {
		p := filepath.Join(t.TempDir(), "config.json")
		_ = os.WriteFile(p, []byte(raw), 0600)
		if _, err := Load(p); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestConfigRejectsTrailingJSONWithoutRewriting(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	raw := []byte(`{"port":8765} {"port":9999}`)
	if err := os.WriteFile(p, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err == nil {
		t.Fatal("accepted trailing JSON")
	}
	after, err := os.ReadFile(p)
	if err != nil || string(after) != string(raw) {
		t.Fatalf("invalid configuration changed: %q %v", after, err)
	}
}

func TestConfigSymlinkUsesTargetDirectoryAndPreservesLink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "installation", "config.json")
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(`{"data_dir":"Data"}`), 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "config.json")
	if err := os.Symlink(target, alias); err != nil {
		t.Skip(err)
	}
	s, err := Load(alias)
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(filepath.Dir(target))
	if err != nil {
		t.Fatal(err)
	}
	if s.DataDir != filepath.Join(want, "Data") || s.ConfigPath != filepath.Join(want, "config.json") {
		t.Fatalf("wrong config binding: %#v", s)
	}
	info, err := os.Lstat(alias)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("config alias overwritten: %v", err)
	}
}

func TestBackupSymlinkIntoProjectsRejected(t *testing.T) {
	root := t.TempDir()
	projects := filepath.Join(root, "Data", "Projects")
	if err := os.MkdirAll(projects, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(projects, filepath.Join(root, "backup-alias")); err != nil {
		t.Skip(err)
	}
	p := filepath.Join(root, "config.json")
	if err := os.WriteFile(p, []byte(`{"backup_dir":"backup-alias/not-created-yet","session_secret":"keep"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err == nil {
		t.Fatal("accepted backup inside resolved Projects directory")
	}
}

func TestProjectsSymlinkIsUsedForBackupBoundary(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{filepath.Join(root, "Data"), filepath.Join(root, "external-projects")} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, "external-projects"), filepath.Join(root, "Data", "Projects")); err != nil {
		t.Skip(err)
	}
	p := filepath.Join(root, "config.json")
	if err := os.WriteFile(p, []byte(`{"backup_dir":"external-projects/backup","session_secret":"keep"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err == nil {
		t.Fatal("accepted backup inside Projects symlink target")
	}
}
