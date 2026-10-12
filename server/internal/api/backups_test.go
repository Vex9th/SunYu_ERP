package api

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sunyu.local/erp/internal/config"
	"testing"
	"time"
)

func businessBackupSettings(t *testing.T, s *Server) config.Settings {
	t.Helper()
	settings := s.Config
	settings.ConfigPath = filepath.Join(t.TempDir(), "config.json")
	settings.BackupDir = filepath.Join(t.TempDir(), "Backups")
	settings.BackupEnabled = false
	settings.BackupRetentionDays = 0
	b, _ := json.Marshal(Row{"data_dir": settings.DataDir, "backup_dir": settings.BackupDir, "backup_enabled": false, "session_secret": settings.SessionSecret})
	if e := os.WriteFile(settings.ConfigPath, b, 0600); e != nil {
		t.Fatal(e)
	}
	project := filepath.Join(settings.DataDir, "Projects", "测试项目")
	if e := os.MkdirAll(project, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(project, "附件.txt"), []byte("不可变附件\n"), 0600); e != nil {
		t.Fatal(e)
	}
	return settings
}
func TestBackupSnapshotIntegrityCollisionAndSafePruning(t *testing.T) {
	s := businessTestServer(t)
	settings := businessBackupSettings(t, s)
	businessTestCompany(t, s, "快照公司")
	var backups []string
	for i := 0; i < 4; i++ {
		now := s.Now().Add(time.Duration(i) * 24 * time.Hour)
		target, e := CreateBackup(context.Background(), s.DB, settings, now)
		if e != nil {
			t.Fatal(e)
		}
		backups = append(backups, target)
		manifest, e := VerifyBackup(target)
		if e != nil {
			t.Fatal(e)
		}
		if manifest["product"] != "SunYu ERP" {
			t.Fatal(manifest)
		}
		for _, suffix := range []string{"-wal", "-shm", "-journal"} {
			if _, e = os.Stat(filepath.Join(target, "database", "iapm.sqlite") + suffix); !os.IsNotExist(e) {
				t.Fatalf("SQLite sidecar remains %s", suffix)
			}
		}
		bytes, e := os.ReadFile(filepath.Join(target, "Projects", "测试项目", "附件.txt"))
		if e != nil || string(bytes) != "不可变附件\n" {
			t.Fatal(string(bytes), e)
		}
	}
	if _, e := CreateBackup(context.Background(), s.DB, settings, s.Now()); e == nil {
		t.Fatal("timestamp collision should fail")
	}
	if _, e := VerifyBackup(backups[0]); e != nil {
		t.Fatalf("collision deleted previous backup: %v", e)
	}
	foreign := filepath.Join(settings.BackupDir, "2020-01-01_000000")
	os.Mkdir(foreign, 0700)
	os.WriteFile(filepath.Join(foreign, "mine.txt"), []byte("user-owned"), 0600)
	removed, e := PruneBackups(settings.BackupDir, 0, s.Now().Add(30*24*time.Hour))
	if e != nil || len(removed) != 2 {
		t.Fatalf("removed=%v error=%v", removed, e)
	}
	for _, target := range backups[2:] {
		if _, e := VerifyBackup(target); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := os.Stat(filepath.Join(foreign, "mine.txt")); e != nil {
		t.Fatal("foreign directory removed")
	}
	os.WriteFile(filepath.Join(backups[3], "Projects", "测试项目", "附件.txt"), []byte("tampered"), 0600)
	if _, e := VerifyBackup(backups[3]); e == nil {
		t.Fatal("tampering accepted")
	}
	removed, e = PruneBackups(settings.BackupDir, 0, s.Now().Add(50*24*time.Hour))
	if e != nil || len(removed) != 0 {
		t.Fatalf("must preserve the remaining valid backup: %v %v", removed, e)
	}
}
func TestBackupRejectsSymlinkWithoutDeletingForeignFile(t *testing.T) {
	s := businessTestServer(t)
	settings := businessBackupSettings(t, s)
	foreign := filepath.Join(t.TempDir(), "secret.txt")
	os.WriteFile(foreign, []byte("owned elsewhere"), 0600)
	link := filepath.Join(settings.DataDir, "Projects", "linked.txt")
	if e := os.Symlink(foreign, link); e != nil {
		t.Skipf("symlinks unavailable: %v", e)
	}
	if _, e := CreateBackup(context.Background(), s.DB, settings, s.Now()); e == nil {
		t.Fatal("source symlink accepted")
	}
	data, e := os.ReadFile(foreign)
	if e != nil || string(data) != "owned elsewhere" {
		t.Fatal("foreign source changed")
	}
	rows, e := All(s.DB, "SELECT status FROM backup_runs")
	if e != nil || len(rows) != 1 || rows[0]["status"] != "failed" {
		t.Fatal(rows, e)
	}
	entries, e := os.ReadDir(settings.BackupDir)
	if e != nil || len(entries) != 0 {
		t.Fatal(entries, e)
	}
}
func TestBackupRejectsInsideProjectsAndCancelledCopy(t *testing.T) {
	s := businessTestServer(t)
	settings := businessBackupSettings(t, s)
	bad := settings
	bad.BackupDir = filepath.Join(settings.DataDir, "Projects", "Backups")
	if _, e := CreateBackup(context.Background(), s.DB, bad, s.Now()); e == nil {
		t.Fatal("nested Projects backup accepted")
	}
	if _, e := os.Stat(bad.BackupDir); !os.IsNotExist(e) {
		t.Fatal("invalid backup request created a directory", e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := CreateBackup(ctx, s.DB, settings, s.Now()); e == nil {
		t.Fatal("cancelled backup succeeded")
	}
}

func TestBackupRejectsInvalidManifestAndUndeclaredFiles(t *testing.T) {
	mutations := []struct {
		name   string
		mutate func(Row, string)
	}{
		{"wrong_product", func(r Row, _ string) { r["product"] = "other" }},
		{"boolean_schema", func(r Row, _ string) { r["schema_version"] = true }},
		{"boolean_size", func(r Row, _ string) { r["files"].([]any)[0].(map[string]any)["size"] = true }},
		{"traversal", func(r Row, _ string) { r["files"].([]any)[0].(map[string]any)["path"] = "../secret" }},
		{"duplicate", func(r Row, _ string) { files := r["files"].([]any); r["files"] = append(files, files[0]) }},
		{"wrong_name", func(r Row, _ string) { r["created_at"] = "2001-01-01T00:00:00+08:00" }},
		{"undeclared", func(_ Row, path string) { os.WriteFile(filepath.Join(path, "foreign"), []byte("foreign"), 0600) }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			s := businessTestServer(t)
			settings := businessBackupSettings(t, s)
			target, e := CreateBackup(context.Background(), s.DB, settings, s.Now())
			if e != nil {
				t.Fatal(e)
			}
			manifest, e := VerifyBackup(target)
			if e != nil {
				t.Fatal(e)
			}
			mutation.mutate(manifest, target)
			b, e := json.Marshal(manifest)
			if e != nil {
				t.Fatal(e)
			}
			if e = os.WriteFile(filepath.Join(target, "manifest.json"), b, 0600); e != nil {
				t.Fatal(e)
			}
			if _, e = VerifyBackup(target); e == nil {
				t.Fatal("invalid backup accepted")
			}
			removed, e := PruneBackups(settings.BackupDir, 0, s.Now().AddDate(1, 0, 0))
			if e != nil || len(removed) != 0 {
				t.Fatal("invalid backup should be left untouched", removed, e)
			}
		})
	}
}

func TestBackupSQLiteURIAndUnicodePaths(t *testing.T) {
	if uri := backupDatabaseURI("C:/测试 # path/backup.sqlite"); uri != "file:///C:/%E6%B5%8B%E8%AF%95%20%23%20path/backup.sqlite" {
		t.Fatal("Windows drive was interpreted as URI authority", uri)
	}
	s := businessTestServer(t)
	settings := businessBackupSettings(t, s)
	name := "测试 # space"
	if runtime.GOOS != "windows" {
		name += " ?"
	}
	settings.BackupDir = filepath.Join(t.TempDir(), name)
	target, e := CreateBackup(context.Background(), s.DB, settings, s.Now())
	if e != nil {
		t.Fatal(e)
	}
	if _, e = VerifyBackup(target); e != nil {
		t.Fatal(e)
	}
}
