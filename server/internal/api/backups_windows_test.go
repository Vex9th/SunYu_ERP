//go:build windows

package api

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"sunyu.local/erp/internal/config"
	"sunyu.local/erp/internal/database"
	"sunyu.local/erp/internal/pathidentity"
)

func TestConfiguredExternalJunctionsSupportDatabaseAndBusinessBackup(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "客户 Data 实际目录")
	backups := filepath.Join(root, "客户 Backups 实际目录")
	dataAlias := filepath.Join(root, "DataAlias")
	backupAlias := filepath.Join(root, "BackupAlias")
	for alias, target := range map[string]string{dataAlias: data, backupAlias: backups} {
		if err := os.Mkdir(target, 0700); err != nil {
			t.Fatal(err)
		}
		if output, err := exec.Command("cmd", "/c", "mklink", "/J", alias, target).CombinedOutput(); err != nil {
			t.Fatalf("create isolated junction: %s: %v", output, err)
		}
	}
	configPath := filepath.Join(root, "config.json")
	original, err := json.Marshal(map[string]any{"data_dir": dataAlias, "backup_dir": backupAlias, "session_secret": "synthetic-alias-regression", "backup_enabled": false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, original, 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	for actual, target := range map[string]string{settings.DataDir: data, settings.BackupDir: backups} {
		physical, err := pathidentity.ResolveExisting(target)
		if err != nil || !strings.EqualFold(actual, physical) || strings.HasPrefix(actual, `\\?\`) {
			t.Fatalf("configuration must resolve to a normal physical path: got=%q want=%q err=%v", actual, physical, err)
		}
	}
	db, err := database.Open(filepath.Join(settings.DataDir, "iapm.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE alias_probe(value TEXT); INSERT INTO alias_probe VALUES('保留数据')"); err != nil {
		t.Fatal(err)
	}
	attachment := filepath.Join(settings.DataDir, "Projects", "别名测试", "资料.txt")
	if err := os.MkdirAll(filepath.Dir(attachment), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(attachment, []byte("附件保持"), 0600); err != nil {
		t.Fatal(err)
	}
	var value string
	if err := db.QueryRow("SELECT value FROM alias_probe").Scan(&value); err != nil || value != "保留数据" {
		t.Fatalf("database through configured alias: %q %v", value, err)
	}
	target, err := CreateBackup(context.Background(), db, settings, time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyBackup(target); err != nil {
		t.Fatal(err)
	}
	if copied, err := os.ReadFile(filepath.Join(target, "Projects", "别名测试", "资料.txt")); err != nil || string(copied) != "附件保持" {
		t.Fatalf("backup lost attachment: %q %v", copied, err)
	}
	if saved, err := os.ReadFile(configPath); err != nil || !bytes.Equal(saved, original) {
		t.Fatalf("loading and backup must preserve original config bytes: %v", err)
	}
	for _, alias := range []string{dataAlias, backupAlias} {
		info, err := os.Lstat(alias)
		if err != nil || !pathidentity.IsLink(info) {
			t.Fatalf("configured junction was changed: %s %v", alias, err)
		}
	}
}
