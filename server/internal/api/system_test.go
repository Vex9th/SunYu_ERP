package api

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sunyu.local/erp/internal/config"
	"sync/atomic"
	"testing"
	"time"
)

func businessTestSystem(t *testing.T) (*Server, *System) {
	t.Helper()
	s := businessTestServer(t)
	s.Config = businessBackupSettings(t, s)
	s.Now = time.Now
	system := RegisterSystem(s)
	s.SettingsSnapshot = system.Settings
	if e := system.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { system.Close() })
	return s, system
}
func TestSystemBackupTaskDedupWaitAndPersistence(t *testing.T) {
	s, system := businessTestSystem(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	system.create = func(ctx context.Context, db *sql.DB, settings config.Settings, now time.Time) (string, error) {
		calls.Add(1)
		close(entered)
		<-release
		return backupCreateLocked(ctx, db, settings, now)
	}
	first := businessExpect(t, s, "POST", "/api/system/backup-tasks", Row{}, "", 202)
	<-entered
	second := businessExpect(t, s, "POST", "/api/system/backup-tasks", Row{}, "", 202)
	if first["task_id"] != second["task_id"] || calls.Load() != 1 {
		t.Fatal(first, second, calls.Load())
	}
	taskURL := "/api/system/backup-tasks/" + Str(first["task_id"])
	running := businessExpect(t, s, "GET", taskURL, nil, "", 200)
	if running["status"] != "running" {
		t.Fatal(running)
	}
	closed := make(chan struct{})
	go func() { system.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("Close returned while worker owns database")
	case <-time.After(20 * time.Millisecond):
	}
	businessExpect(t, s, "POST", "/api/system/backup-tasks", Row{}, "", 503)
	close(release)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not finish")
	}
	done := businessExpect(t, s, "GET", taskURL, nil, "", 200)
	if done["status"] != "success" || done["phase"] != "finished" {
		t.Fatal(done)
	}
	if _, e := VerifyBackup(Str(done["path"])); e != nil {
		t.Fatal(e)
	}
}
func TestSystemConfigurationSchedulerAndInterruptedJobs(t *testing.T) {
	s, system := businessTestSystem(t)
	out := businessExpect(t, s, "GET", "/api/system/overview", nil, "", 200)
	if out["backup"].(map[string]any)["enabled"] != false {
		t.Fatal(out)
	}
	directory := filepath.Join(t.TempDir(), "NewBackups")
	updated := businessExpect(t, s, "PUT", "/api/system/backup-settings", Row{"enabled": true, "directory": directory, "interval_hours": 1, "retention_days": 7}, "", 200)
	expectedDirectory, e := backupResolvedPath(directory)
	if e != nil || updated["directory"] != expectedDirectory || system.Settings().BackupIntervalHours != 1 {
		t.Fatal(updated)
	}
	if s.Config.BackupDir == directory {
		t.Fatal("static config was mutated")
	}
	system.RunCycle()
	count, e := One(s.DB, "SELECT COUNT(*) AS n FROM backup_runs WHERE status='success'")
	if e != nil || businessInt(count["n"]) != 1 {
		t.Fatal("due backup was not scheduled exactly once", count, e)
	}
	if system.RunCycle() {
		t.Fatal("backup repeated before due")
	}
	if system.Snapshot()["last_error_code"] != nil {
		t.Fatal("not-due cycle recorded a failure", system.Snapshot())
	}
	businessExpect(t, s, "PUT", "/api/system/backup-settings", Row{"enabled": true, "directory": nil, "interval_hours": 1, "retention_days": 7}, "", 422)
	businessTestExec(t, s, "INSERT INTO backup_tasks(id,status,phase,started_at) VALUES('interrupted','running','creating','2026-10-01T00:00:00Z')")
	businessTestExec(t, s, "INSERT INTO backup_runs(started_at,status,target_path) VALUES('2026-10-01T00:00:00Z','running','owned')")
	if e := RecoverInterruptedBackups(s.DB, s.Now()); e != nil {
		t.Fatal(e)
	}
	r := businessExpect(t, s, "GET", "/api/system/backup-tasks/interrupted", nil, "", 200)
	if r["status"] != "interrupted" || r["error_code"] != "service_restart" {
		t.Fatal(r)
	}
}

func TestSystemCompletedBackupSurvivesTaskStatusWriteFailure(t *testing.T) {
	s, system := businessTestSystem(t)
	system.create = func(ctx context.Context, db *sql.DB, settings config.Settings, now time.Time) (string, error) {
		target, e := backupCreateLocked(ctx, db, settings, now)
		if e == nil {
			_, e = db.Exec("CREATE TRIGGER reject_task_success BEFORE UPDATE OF status ON backup_tasks WHEN NEW.status='success' BEGIN SELECT RAISE(FAIL,'injected task status failure'); END")
		}
		return target, e
	}
	started := businessExpect(t, s, "POST", "/api/system/backup-tasks", Row{}, "", 202)
	system.Close()
	url := "/api/system/backup-tasks/" + Str(started["task_id"])
	done := businessExpect(t, s, "GET", url, nil, "", 200)
	if done["status"] != "success" || done["error_code"] != nil {
		t.Fatal("task bookkeeping reversed a completed backup", done)
	}
	if _, e := VerifyBackup(Str(done["path"])); e != nil {
		t.Fatal(e)
	}
	businessTestExec(t, s, "DROP TRIGGER reject_task_success")
	done = businessExpect(t, s, "GET", url, nil, "", 200)
	stored, e := One(s.DB, "SELECT status,path FROM backup_tasks WHERE id=?", started["task_id"])
	if e != nil || stored["status"] != "success" || stored["path"] != done["path"] {
		t.Fatal("successful task was not reconciled", stored, e)
	}
}

func TestSystemCleanupWarningAndMaintenance(t *testing.T) {
	s, system := businessTestSystem(t)
	system.prune = func(string, int, time.Time) ([]string, error) { return nil, errors.New("private cleanup failure") }
	result := businessExpect(t, s, "POST", "/api/system/backups", Row{}, "", 201)
	if result["warning"] != "Backup created but cleanup failed" {
		t.Fatal(result)
	}
	if _, e := VerifyBackup(Str(result["path"])); e != nil {
		t.Fatal(e)
	}
	system.SetMaintenanceCheck(func() bool { return true })
	businessExpect(t, s, "POST", "/api/system/backups", Row{}, "", 503)
	businessExpect(t, s, "POST", "/api/system/backup-tasks", Row{}, "", 503)
	if system.RunCycle() {
		t.Fatal("maintenance permitted scheduled backup")
	}
}

func TestSystemScheduleFailureUsesCooldownAndCurrentSettings(t *testing.T) {
	s := businessTestServer(t)
	s.Config = businessBackupSettings(t, s)
	s.Config.BackupEnabled = true
	system := RegisterSystem(s)
	s.SettingsSnapshot = system.Settings
	businessTestExec(t, s, "ALTER TABLE backup_runs RENAME TO unavailable_backup_runs")
	if system.RunCycle() || system.Snapshot()["last_error_code"] == nil {
		t.Fatal("schedule query failure was not reported")
	}
	system.mu.Lock()
	retry := system.retryNotBefore
	system.mu.Unlock()
	if !retry.Equal(s.Now().Add(time.Hour)) {
		t.Fatal("schedule failure has no bounded cooldown", retry)
	}
	businessTestExec(t, s, "ALTER TABLE unavailable_backup_runs RENAME TO backup_runs")
	if system.RunCycle() {
		t.Fatal("failed scheduler retried during cooldown")
	}
	system.mu.Lock()
	system.settings.BackupDir = ""
	system.mu.Unlock()
	health, e := businessBackupHealth(&Context{S: s, DB: s.DB})
	if e != nil || health["message"] != "Backup is not configured" {
		t.Fatal("dashboard ignored current backup settings", health, e)
	}
}
