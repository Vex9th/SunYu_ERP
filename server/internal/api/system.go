package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sunyu.local/erp/internal/config"
	"sync"
	"time"
)

// System owns backup workers and the scheduler. Close prevents new submissions
// before waiting for every running backup, so the database remains open until safe.
type System struct {
	s                          *Server
	mu                         sync.Mutex
	settings                   config.Settings
	started, closing, alive    bool
	stop                       chan struct{}
	workers                    sync.WaitGroup
	cycle                      sync.Mutex
	live                       map[string]bool
	completed                  map[string]Row
	lastErrorAt, lastErrorCode any
	retryNotBefore             time.Time
	maintenance                func() bool
	create                     func(context.Context, *sql.DB, config.Settings, time.Time) (string, error)
	prune                      func(string, int, time.Time) ([]string, error)
}
type backupJobResult struct {
	path         string
	warning      any
	cleanupError any
}

func RegisterSystem(s *Server) *System {
	system := &System{s: s, settings: s.Config, stop: make(chan struct{}), live: map[string]bool{}, completed: map[string]Row{}, create: backupCreateLocked, prune: backupPruneLocked}
	system.maintenance = func() bool {
		if s.Root == "" {
			return false
		}
		_, e := os.Stat(filepath.Join(s.Root, ".updates", "maintenance"))
		return e == nil
	}
	s.Handle("GET /api/system/overview", system.overview)
	s.Handle("PUT /api/system/backup-settings", system.updateSettings)
	s.Handle("POST /api/system/backups", system.manualBackup)
	s.Handle("POST /api/system/backup-tasks", system.startTask)
	s.Handle("GET /api/system/backup-tasks/{task_id}", system.getTask)
	return system
}
func (sys *System) Start() error {
	sys.mu.Lock()
	defer sys.mu.Unlock()
	if sys.started || sys.closing {
		return errors.New("backup scheduler has already been started or closed")
	}
	if e := RecoverInterruptedBackups(sys.s.DB, sys.s.Now()); e != nil {
		return e
	}
	sys.started = true
	sys.alive = true
	sys.workers.Add(1)
	go func() {
		defer sys.workers.Done()
		defer func() {
			sys.mu.Lock()
			sys.alive = false
			sys.mu.Unlock()
			if failure := recover(); failure != nil {
				sys.recordError(fmt.Sprintf("scheduler:%T", failure), sys.s.Now())
			}
		}()
		for {
			select {
			case <-sys.stop:
				return
			default:
			}
			sys.RunCycle()
			timer := time.NewTimer(time.Minute)
			select {
			case <-sys.stop:
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	return nil
}
func (sys *System) Close() error {
	sys.mu.Lock()
	if !sys.closing {
		sys.closing = true
		close(sys.stop)
	}
	sys.mu.Unlock()
	sys.workers.Wait()
	return nil
}
func (sys *System) SetMaintenanceCheck(check func() bool) {
	sys.mu.Lock()
	defer sys.mu.Unlock()
	sys.maintenance = check
}
func (sys *System) acceptingLocked() error {
	if sys.closing || (sys.maintenance != nil && sys.maintenance()) {
		return E(503, "维护期间暂停备份。", "")
	}
	return nil
}
func (sys *System) Settings() config.Settings {
	sys.mu.Lock()
	defer sys.mu.Unlock()
	return sys.settings
}
func (sys *System) Snapshot() Row {
	sys.mu.Lock()
	defer sys.mu.Unlock()
	return Row{"alive": sys.alive, "last_error_at": sys.lastErrorAt, "last_error_code": sys.lastErrorCode}
}
func RecoverInterruptedBackups(db DBTX, now time.Time) error {
	if _, e := db.Exec("UPDATE backup_runs SET status='failed',finished_at=?,error_message='Backup interrupted by service restart' WHERE status='running'", backupTime(now)); e != nil {
		return e
	}
	if _, e := db.Exec("CREATE TABLE IF NOT EXISTS backup_tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,phase TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,path TEXT,warning TEXT,error_code TEXT)"); e != nil {
		return e
	}
	_, e := db.Exec("UPDATE backup_tasks SET status='interrupted',phase='interrupted',finished_at=?,error_code='service_restart' WHERE status='running'", backupTime(now))
	return e
}
func systemSettingsResponse(settings config.Settings) Row {
	var dir any
	if settings.BackupDir != "" {
		dir = settings.BackupDir
	}
	return Row{"enabled": settings.BackupEnabled, "directory": dir, "interval_hours": settings.BackupIntervalHours, "retention_days": settings.BackupRetentionDays}
}
func (sys *System) overview(c *Context) (any, error) {
	settings := sys.Settings()
	last, e := One(c.DB, "SELECT status,started_at,finished_at,target_path,error_message FROM backup_runs ORDER BY id DESC LIMIT 1")
	if e != nil {
		return nil, e
	}
	backup := systemSettingsResponse(settings)
	if last == nil {
		backup["last_run"] = nil
	} else {
		backup["last_run"] = last
	}
	return Row{"data_directory": settings.DataDir, "database_path": filepath.Join(settings.DataDir, "iapm.sqlite"), "scheduler": sys.Snapshot(), "backup": backup}, nil
}
func (sys *System) updateSettings(c *Context) (any, error) {
	p, e := c.Body()
	invalid := E(422, "Invalid backup settings", "")
	if e != nil {
		return nil, invalid
	}
	if !businessExact(p, "directory", "interval_hours", "retention_days") && !businessExact(p, "enabled", "directory", "interval_hours", "retention_days") {
		return nil, invalid
	}
	var directory *string
	if p["directory"] != nil {
		s, ok := p["directory"].(string)
		if !ok || strings.TrimSpace(s) == "" {
			return nil, invalid
		}
		directory = &s
	}
	enabled := directory != nil
	if v, ok := p["enabled"]; ok {
		var valid bool
		enabled, valid = v.(bool)
		if !valid {
			return nil, invalid
		}
	}
	if enabled && directory == nil {
		return nil, invalid
	}
	interval, ok := Int(p["interval_hours"])
	if !ok || interval < 1 || interval > 8760 {
		return nil, invalid
	}
	retention, ok := Int(p["retention_days"])
	if !ok || retention < 0 || retention > 3650 {
		return nil, invalid
	}
	sys.mu.Lock()
	defer sys.mu.Unlock()
	updated, e := config.UpdateBackup(sys.settings.ConfigPath, &enabled, directory, int(interval), int(retention))
	if e != nil {
		var pathError *os.PathError
		if errors.As(e, &pathError) {
			return nil, E(503, "Backup settings update failed", "")
		}
		return nil, invalid
	}
	sys.settings = updated
	return systemSettingsResponse(updated), nil
}
func (sys *System) runJob(ctx context.Context, settings config.Settings, now time.Time, onPhase func(string) error) (backupJobResult, error) {
	backupMutex.Lock()
	defer backupMutex.Unlock()
	if settings.BackupDir == "" {
		return backupJobResult{}, errors.New("backup_dir is not configured")
	}
	if onPhase != nil {
		if e := onPhase("creating"); e != nil {
			return backupJobResult{}, e
		}
	}
	target, e := sys.create(ctx, sys.s.DB, settings, now)
	if e != nil {
		return backupJobResult{}, e
	}
	result := backupJobResult{path: target}
	if onPhase != nil {
		e = onPhase("cleaning")
	}
	if e == nil {
		_, e = sys.prune(settings.BackupDir, settings.BackupRetentionDays, now)
	}
	if e != nil {
		log.Printf("backup cleanup failed: %v", e)
		result.warning = "Backup created but cleanup failed"
		result.cleanupError = fmt.Sprintf("cleanup:%T", e)
	}
	return result, nil
}
func (sys *System) manualBackup(c *Context) (any, error) {
	sys.mu.Lock()
	if e := sys.acceptingLocked(); e != nil {
		sys.mu.Unlock()
		return nil, e
	}
	settings := sys.settings
	if settings.BackupDir == "" {
		sys.mu.Unlock()
		return nil, E(409, "Backup directory is not configured", "")
	}
	sys.workers.Add(1)
	sys.mu.Unlock()
	defer sys.workers.Done()
	result, e := sys.runJob(c.R.Context(), settings, sys.s.Now(), nil)
	if e != nil {
		log.Printf("manual backup failed: %v", e)
		return nil, E(503, "Backup operation failed", "")
	}
	run, e := One(c.DB, "SELECT started_at FROM backup_runs WHERE status='success' AND target_path=? ORDER BY id DESC LIMIT 1", result.path)
	if e != nil || run == nil {
		return nil, E(503, "Backup operation failed", "")
	}
	out := Row{"path": result.path, "created_at": run["started_at"]}
	if result.warning != nil {
		out["warning"] = result.warning
	}
	c.Status = 201
	return out, nil
}
func (sys *System) reconcileLocked(db DBTX, id string) (Row, error) {
	if completed := sys.completed[id]; completed != nil {
		_, e := db.Exec("UPDATE backup_tasks SET status='success',phase='finished',finished_at=?,path=?,warning=?,error_code=NULL WHERE id=?", completed["finished_at"], completed["path"], completed["warning"], id)
		if e == nil {
			delete(sys.completed, id)
		} else {
			log.Printf("backup task reconcile: %v", e)
		}
		return completed, nil
	}
	if !sys.live[id] {
		_, e := db.Exec("UPDATE backup_tasks SET status='interrupted',phase='interrupted',finished_at=?,error_code='worker_stopped' WHERE id=? AND status='running'", backupTime(sys.s.Now()), id)
		if e != nil {
			return nil, e
		}
	}
	return nil, nil
}
func (sys *System) startTask(c *Context) (any, error) {
	sys.mu.Lock()
	defer sys.mu.Unlock()
	settings := sys.settings
	if settings.BackupDir == "" {
		return nil, E(409, "Backup directory is not configured", "")
	}
	if e := sys.acceptingLocked(); e != nil {
		return nil, e
	}
	active, e := One(c.DB, "SELECT id FROM backup_tasks WHERE status='running' ORDER BY started_at DESC LIMIT 1")
	if e != nil {
		return nil, e
	}
	c.Status = 202
	if active != nil {
		id := Str(active["id"])
		if sys.live[id] {
			return Row{"task_id": id, "status": "running"}, nil
		}
		completed, e := sys.reconcileLocked(c.DB, id)
		if e != nil {
			return nil, e
		}
		if completed != nil {
			return Row{"task_id": id, "status": "success"}, nil
		}
	}
	if e = sys.s.DB.PingContext(c.R.Context()); e != nil {
		return nil, E(503, "Backup worker connection unavailable", "")
	}
	id := strings.ReplaceAll(uuid.NewString(), "-", "")
	started := backupTime(sys.s.Now())
	if _, e = c.DB.Exec("INSERT INTO backup_tasks(id,status,phase,started_at) VALUES(?,'running','queued',?)", id, started); e != nil {
		return nil, e
	}
	sys.live[id] = true
	sys.workers.Add(1)
	go sys.executeTask(id, started, settings)
	return Row{"task_id": id, "status": "running"}, nil
}
func (sys *System) executeTask(id, started string, settings config.Settings) {
	defer sys.workers.Done()
	defer func() { sys.mu.Lock(); delete(sys.live, id); sys.mu.Unlock() }()
	var result backupJobResult
	var err error
	defer func() {
		if failure := recover(); failure != nil {
			err = fmt.Errorf("backup panic: %v", failure)
		}
		if err == nil {
			return
		}
		log.Printf("backup task %s failed: %v", id, err)
		if result.path != "" {
			completed := Row{"id": id, "status": "success", "phase": "finished", "started_at": started, "finished_at": backupTime(sys.s.Now()), "path": result.path, "warning": result.warning, "error_code": nil}
			sys.mu.Lock()
			sys.completed[id] = completed
			sys.mu.Unlock()
		} else {
			_, recordErr := sys.s.DB.Exec("UPDATE backup_tasks SET status='failed',phase='failed',finished_at=?,error_code=? WHERE id=?", backupTime(sys.s.Now()), fmt.Sprintf("backup:%T", err), id)
			if recordErr != nil {
				log.Printf("backup task %s status failure: %v", id, recordErr)
			}
		}
	}()
	result, err = sys.runJob(context.Background(), settings, sys.s.Now(), func(phase string) error {
		_, e := sys.s.DB.Exec("UPDATE backup_tasks SET phase=? WHERE id=?", phase, id)
		return e
	})
	if err != nil {
		return
	}
	_, err = sys.s.DB.Exec("UPDATE backup_tasks SET status='success',phase='finished',finished_at=?,path=?,warning=?,error_code=NULL WHERE id=?", backupTime(sys.s.Now()), result.path, result.warning, id)
}
func (sys *System) getTask(c *Context) (any, error) {
	sys.mu.Lock()
	defer sys.mu.Unlock()
	id := c.R.PathValue("task_id")
	completed, e := sys.reconcileLocked(c.DB, id)
	if e != nil || completed != nil {
		return completed, e
	}
	row, e := One(c.DB, "SELECT * FROM backup_tasks WHERE id=?", id)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, E(404, "Backup task not found", "")
	}
	return row, nil
}
func (sys *System) recordError(code string, at time.Time) {
	sys.mu.Lock()
	defer sys.mu.Unlock()
	sys.lastErrorAt = backupTime(at)
	sys.lastErrorCode = code
}
func (sys *System) RunCycle() bool {
	sys.cycle.Lock()
	defer sys.cycle.Unlock()
	now := sys.s.Now()
	sys.mu.Lock()
	if sys.acceptingLocked() != nil {
		sys.mu.Unlock()
		return false
	}
	settings := sys.settings
	if !settings.BackupEnabled || settings.BackupDir == "" || now.Before(sys.retryNotBefore) {
		sys.mu.Unlock()
		return false
	}
	sys.workers.Add(1)
	sys.mu.Unlock()
	defer sys.workers.Done()
	due, scheduleError, e := systemBackupDue(sys.s.DB, now, settings.BackupIntervalHours)
	if e != nil {
		sys.mu.Lock()
		sys.retryNotBefore = now.Add(time.Hour)
		sys.lastErrorAt = backupTime(now)
		sys.lastErrorCode = fmt.Sprintf("schedule:%T", e)
		sys.mu.Unlock()
		return false
	}
	if !due {
		sys.mu.Lock()
		sys.retryNotBefore = time.Time{}
		sys.mu.Unlock()
		return false
	}
	result, e := sys.runJob(context.Background(), settings, now, nil)
	sys.mu.Lock()
	defer sys.mu.Unlock()
	if e != nil {
		delay := time.Hour
		if time.Duration(settings.BackupIntervalHours)*time.Hour < delay {
			delay = time.Duration(settings.BackupIntervalHours) * time.Hour
		}
		sys.retryNotBefore = now.Add(delay)
		sys.lastErrorAt = backupTime(now)
		sys.lastErrorCode = fmt.Sprintf("backup:%T", e)
		return false
	}
	sys.retryNotBefore = time.Time{}
	sys.lastErrorAt = nil
	sys.lastErrorCode = nil
	if result.cleanupError != nil {
		sys.lastErrorAt = backupTime(now)
		sys.lastErrorCode = result.cleanupError
	} else if scheduleError != nil {
		sys.lastErrorAt = backupTime(now)
		sys.lastErrorCode = scheduleError
	}
	return true
}
func systemBackupDue(db DBTX, now time.Time, interval int) (bool, any, error) {
	r, e := One(db, "SELECT finished_at FROM backup_runs WHERE status='success' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1")
	if e != nil {
		return false, nil, e
	}
	if r == nil {
		return true, nil, nil
	}
	finished, e := time.Parse(time.RFC3339Nano, Str(r["finished_at"]))
	if e != nil || finished.After(now) {
		return true, "schedule:ValueError", nil
	}
	return !now.Before(finished.Add(time.Duration(interval) * time.Hour)), nil, nil
}
