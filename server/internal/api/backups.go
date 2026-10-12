package api

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"io"
	"io/fs"
	"modernc.org/sqlite"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sunyu.local/erp/internal/config"
	"sync"
	"time"
)

var backupMutex sync.Mutex
var backupName = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}_\d{6}$`)
var backupDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)

const backupManifestLimit = 16 * 1024 * 1024
const backupEntryLimit = 100000

func backupTime(t time.Time) string {
	layout := "2006-01-02T15:04:05"
	if t.Nanosecond() != 0 {
		layout += ".000000"
	}
	return t.Format(layout + "-07:00")
}
func backupSyncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	f, e := os.Open(dir)
	if e != nil {
		return e
	}
	return errors.Join(f.Sync(), f.Close())
}
func backupRegular(root, name string) (os.FileInfo, error) {
	rootInfo, e := os.Lstat(root)
	if e != nil {
		return nil, e
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("backup root must be a directory without symlink")
	}
	relative, e := filepath.Rel(root, name)
	if e != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("backup path escapes root")
	}
	current := root
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, e := os.Lstat(current)
		if e != nil {
			return nil, e
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("backup contains a symlink")
		}
	}
	info, e := os.Lstat(name)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("backup entry is not regular")
	}
	return info, nil
}
func backupSame(a, b os.FileInfo) bool {
	return os.SameFile(a, b) && a.Mode() == b.Mode() && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}
func backupReadFile(root, name string, writer io.Writer) (int64, string, error) {
	initial, e := backupRegular(root, name)
	if e != nil {
		return 0, "", e
	}
	relative, e := filepath.Rel(root, name)
	if e != nil {
		return 0, "", e
	}
	access, e := os.OpenRoot(root)
	if e != nil {
		return 0, "", e
	}
	defer access.Close()
	f, e := access.Open(relative)
	if e != nil {
		return 0, "", e
	}
	opened, e := f.Stat()
	if e != nil {
		f.Close()
		return 0, "", e
	}
	hash := sha256.New()
	output := io.Writer(hash)
	if writer != nil {
		output = io.MultiWriter(writer, hash)
	}
	n, copyErr := io.CopyBuffer(output, f, make([]byte, 64*1024))
	final, statErr := f.Stat()
	closeErr := f.Close()
	current, currentErr := backupRegular(root, name)
	if e = errors.Join(copyErr, statErr, closeErr, currentErr); e != nil {
		return 0, "", e
	}
	if !backupSame(initial, opened) || !backupSame(initial, final) || !backupSame(initial, current) {
		return 0, "", fmt.Errorf("source changed while being read")
	}
	return n, hex.EncodeToString(hash.Sum(nil)), nil
}
func backupCopyFile(source, target string) error {
	return backupCopyRootFile(filepath.Dir(source), source, target)
}
func backupCopyRootFile(root, source, target string) error {
	if e := os.MkdirAll(filepath.Dir(target), 0700); e != nil {
		return e
	}
	out, e := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, _, copyErr := backupReadFile(root, source, out)
	return errors.Join(copyErr, out.Sync(), out.Close())
}
func backupCopyProjects(data, target string) error {
	source := filepath.Join(data, "Projects")
	if e := os.Mkdir(target, 0700); e != nil {
		return e
	}
	info, e := os.Lstat(source)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Projects must be a directory without symlink")
	}
	return filepath.WalkDir(source, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if name == source {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("source tree contains symlink")
		}
		relative, e := filepath.Rel(source, name)
		if e != nil {
			return e
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.Mkdir(destination, 0700)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("source tree contains non-regular file")
		}
		return backupCopyRootFile(source, name, destination)
	})
}
func backupFiles(root string) ([]string, error) {
	info, e := os.Lstat(root)
	if e != nil {
		return nil, e
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("backup root must be a directory without symlink")
	}
	out := []string{}
	e = filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("backup contains symlink")
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("backup contains non-regular file")
		}
		relative, e := filepath.Rel(root, name)
		if e != nil {
			return e
		}
		relative = filepath.ToSlash(relative)
		if relative == "manifest.json" {
			return nil
		}
		if !backupValidPath(relative) {
			return fmt.Errorf("invalid backup file path")
		}
		out = append(out, relative)
		if len(out) > backupEntryLimit {
			return fmt.Errorf("backup contains too many files")
		}
		return nil
	})
	sort.Strings(out)
	return out, e
}
func backupValidPath(s string) bool {
	if s == "" || s == "manifest.json" || strings.ContainsAny(s, "\\\x00") || path.IsAbs(s) || path.Clean(s) != s || !filepath.IsLocal(filepath.FromSlash(s)) {
		return false
	}
	for _, part := range strings.Split(s, "/") {
		if part == "" || part == "." || part == ".." || strings.Contains(part, ":") {
			return false
		}
	}
	return true
}
func backupManifest(stage string, now time.Time) (Row, error) {
	files, e := backupFiles(stage)
	if e != nil {
		return nil, e
	}
	entries := []Row{}
	for _, relative := range files {
		size, digest, e := backupReadFile(stage, filepath.Join(stage, filepath.FromSlash(relative)), nil)
		if e != nil {
			return nil, e
		}
		entries = append(entries, Row{"path": relative, "size": size, "sha256": digest})
	}
	return Row{"product": "SunYu ERP", "schema_version": 1, "created_at": backupTime(now), "files": entries}, nil
}
func backupWriteManifest(name string, value Row) error {
	b, e := json.MarshalIndent(value, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, writeErr := f.Write(append(b, '\n'))
	return errors.Join(writeErr, f.Sync(), f.Close())
}
func backupValidateManifest(r Row) (map[string]Row, time.Time, error) {
	bad := func() (map[string]Row, time.Time, error) {
		return nil, time.Time{}, fmt.Errorf("invalid backup manifest")
	}
	if !businessExact(r, "product", "schema_version", "created_at", "files") || r["product"] != "SunYu ERP" || businessInt(r["schema_version"]) != 1 {
		return bad()
	}
	created, e := time.Parse(time.RFC3339Nano, Str(r["created_at"]))
	if e != nil {
		return bad()
	}
	files, ok := r["files"].([]any)
	if !ok || len(files) > backupEntryLimit {
		return bad()
	}
	out := map[string]Row{}
	casefold := map[string]bool{}
	for _, v := range files {
		entry, ok := v.(map[string]any)
		if !ok || !businessExact(entry, "path", "size", "sha256") {
			return bad()
		}
		relative := Str(entry["path"])
		size, valid := Int(entry["size"])
		key := strings.ToLower(relative)
		if !backupValidPath(relative) || !valid || size < 0 || !backupDigest.MatchString(Str(entry["sha256"])) || out[relative] != nil || (runtime.GOOS == "windows" && casefold[key]) {
			return bad()
		}
		casefold[key] = true
		out[relative] = entry
	}
	if out["config.json"] == nil || out["database/iapm.sqlite"] == nil {
		return bad()
	}
	return out, created, nil
}

type backupBoundedWriter struct {
	writer    io.Writer
	remaining int
}

func (w *backupBoundedWriter) Write(b []byte) (int, error) {
	if len(b) > w.remaining {
		return 0, fmt.Errorf("backup manifest is too large")
	}
	n, err := w.writer.Write(b)
	w.remaining -= n
	return n, err
}

func backupReadManifest(root string) (Row, time.Time, error) {
	name := filepath.Join(root, "manifest.json")
	info, e := backupRegular(root, name)
	if e != nil {
		return nil, time.Time{}, e
	}
	if info.Size() > backupManifestLimit {
		return nil, time.Time{}, fmt.Errorf("backup manifest is too large")
	}
	var buf strings.Builder
	if _, _, e = backupReadFile(root, name, &backupBoundedWriter{writer: &buf, remaining: backupManifestLimit}); e != nil {
		return nil, time.Time{}, e
	}
	dec := json.NewDecoder(strings.NewReader(buf.String()))
	dec.UseNumber()
	var r Row
	if e = dec.Decode(&r); e != nil {
		return nil, time.Time{}, e
	}
	var extra any
	if e = dec.Decode(&extra); e != io.EOF {
		return nil, time.Time{}, fmt.Errorf("invalid trailing manifest content")
	}
	_, created, e := backupValidateManifest(r)
	return r, created, e
}
func VerifyBackup(root string) (Row, error) {
	root, e := filepath.Abs(root)
	if e != nil {
		return nil, e
	}
	actual, e := backupFiles(root)
	if e != nil {
		return nil, e
	}
	r, created, e := backupReadManifest(root)
	if e != nil {
		return nil, e
	}
	if !strings.HasPrefix(filepath.Base(root), ".incomplete-") && filepath.Base(root) != created.Format("2006-01-02_150405") {
		return nil, fmt.Errorf("backup directory name does not match manifest")
	}
	entries, _, e := backupValidateManifest(r)
	if e != nil {
		return nil, e
	}
	if len(entries) != len(actual) {
		return nil, fmt.Errorf("backup file set mismatch")
	}
	for _, relative := range actual {
		entry := entries[relative]
		if entry == nil {
			return nil, fmt.Errorf("backup contains undeclared file")
		}
		size, digest, e := backupReadFile(root, filepath.Join(root, filepath.FromSlash(relative)), nil)
		if e != nil {
			return nil, e
		}
		if size != businessInt(entry["size"]) || digest != entry["sha256"] {
			return nil, fmt.Errorf("backup integrity check failed: %s", relative)
		}
	}
	return r, nil
}
func backupDatabaseURI(absolute string) string {
	absolute = filepath.ToSlash(absolute)
	if len(absolute) >= 3 && absolute[1] == ':' && absolute[2] == '/' {
		absolute = "/" + absolute
	}
	u := url.URL{Scheme: "file", Path: absolute}
	return u.String()
}
func backupDatabase(ctx context.Context, db *sql.DB, target string, run int64) error {
	if e := os.MkdirAll(filepath.Dir(target), 0700); e != nil {
		return e
	}
	conn, e := db.Conn(ctx)
	if e != nil {
		return e
	}
	rawErr := conn.Raw(func(driver any) error {
		source, ok := driver.(interface {
			NewBackup(string) (*sqlite.Backup, error)
		})
		if !ok {
			return fmt.Errorf("SQLite online backup unavailable")
		}
		job, e := source.NewBackup(backupDatabaseURI(target))
		if e != nil {
			return e
		}
		for {
			if e = ctx.Err(); e != nil {
				break
			}
			more, stepErr := job.Step(256)
			if stepErr != nil {
				var se *sqlite.Error
				if errors.As(stepErr, &se) && (se.Code()&255 == 5 || se.Code()&255 == 6) {
					select {
					case <-ctx.Done():
						e = ctx.Err()
					case <-time.After(50 * time.Millisecond):
					}
					if e == nil {
						continue
					}
				} else {
					e = stepErr
				}
				break
			}
			if !more {
				break
			}
		}
		return errors.Join(e, job.Finish())
	})
	if e = errors.Join(rawErr, conn.Close()); e != nil {
		return e
	}
	if e = os.Chmod(target, 0600); e != nil {
		return e
	}
	snapshot, e := sql.Open("sqlite", backupDatabaseURI(target))
	if e != nil {
		return e
	}
	snapshot.SetMaxOpenConns(1)
	defer snapshot.Close()
	result, e := snapshot.Exec("UPDATE backup_runs SET status='success',finished_at=?,error_message=NULL WHERE id=? AND status='running'", backupTime(time.Now().UTC()), run)
	if e != nil {
		return e
	}
	n, e := result.RowsAffected()
	if e != nil || n != 1 {
		return fmt.Errorf("staged backup run was not normalized")
	}
	if _, e = snapshot.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); e != nil {
		return e
	}
	var mode string
	if e = snapshot.QueryRow("PRAGMA journal_mode=DELETE").Scan(&mode); e != nil || strings.ToLower(mode) != "delete" {
		return fmt.Errorf("staged database did not converge to DELETE mode")
	}
	checks, e := All(snapshot, "PRAGMA quick_check")
	if e != nil || len(checks) != 1 || checks[0]["quick_check"] != "ok" {
		return fmt.Errorf("staged database failed quick_check")
	}
	if e = snapshot.Close(); e != nil {
		return e
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, e = os.Lstat(target + suffix); e == nil {
			return fmt.Errorf("staged database retained sidecar")
		} else if !os.IsNotExist(e) {
			return e
		}
	}
	f, e := os.OpenFile(target, os.O_RDWR, 0)
	if e != nil {
		return e
	}
	return errors.Join(f.Sync(), f.Close())
}
func CreateBackup(ctx context.Context, db *sql.DB, settings config.Settings, now time.Time) (string, error) {
	backupMutex.Lock()
	defer backupMutex.Unlock()
	return backupCreateLocked(ctx, db, settings, now)
}

// Resolve existing parents before creating a destination, including a not-yet
// created backup directory beneath a symlinked parent.
func backupResolvedPath(name string) (string, error) {
	name, e := filepath.Abs(name)
	if e != nil {
		return "", e
	}
	resolved, e := filepath.EvalSymlinks(name)
	if e == nil {
		return resolved, nil
	}
	if !os.IsNotExist(e) || filepath.Dir(name) == name {
		return "", e
	}
	parent, e := backupResolvedPath(filepath.Dir(name))
	if e != nil {
		return "", e
	}
	return filepath.Join(parent, filepath.Base(name)), nil
}
func backupCreateLocked(ctx context.Context, db *sql.DB, settings config.Settings, now time.Time) (target string, err error) {
	if settings.BackupDir == "" {
		return "", fmt.Errorf("backup_dir is not configured")
	}
	if info, e := os.Lstat(settings.BackupDir); e == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return "", fmt.Errorf("backup_dir must be a directory without symlink")
	} else if e != nil && !os.IsNotExist(e) {
		return "", e
	}
	root, e := backupResolvedPath(settings.BackupDir)
	if e != nil {
		return "", e
	}
	projects, e := backupResolvedPath(filepath.Join(settings.DataDir, "Projects"))
	if e != nil {
		return "", e
	}
	rel, e := filepath.Rel(projects, root)
	if e == nil && (rel == "." || filepath.IsLocal(rel)) {
		return "", fmt.Errorf("backup_dir must not be inside Data/Projects")
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	target = filepath.Join(root, now.Format("2006-01-02_150405"))
	run, e := Insert(db, "INSERT INTO backup_runs(started_at,status,target_path) VALUES(?,'running',?)", backupTime(now), target)
	if e != nil {
		return "", e
	}
	stage := ""
	var ownedStage os.FileInfo
	ownedTarget := target
	var published os.FileInfo
	defer func() {
		if err == nil {
			return
		}
		result, recordErr := db.Exec("UPDATE backup_runs SET status='failed',finished_at=?,error_message='GoError: backup operation failed' WHERE id=? AND status='running'", backupTime(time.Now().UTC()), run)
		confirmed := false
		if recordErr == nil {
			n, _ := result.RowsAffected()
			confirmed = n == 1
		}
		if published != nil && confirmed {
			if current, e := os.Lstat(ownedTarget); e == nil && os.SameFile(published, current) {
				err = errors.Join(err, os.RemoveAll(ownedTarget))
			}
		}
		if stage != "" && ownedStage != nil {
			if current, e := os.Lstat(stage); e == nil && os.SameFile(ownedStage, current) {
				err = errors.Join(err, os.RemoveAll(stage))
			}
		}
		err = errors.Join(err, recordErr)
	}()
	if _, e = os.Lstat(target); e == nil {
		return "", fmt.Errorf("backup target already exists")
	} else if !os.IsNotExist(e) {
		return "", e
	}
	stage = filepath.Join(root, ".incomplete-"+uuid.NewString())
	if err = os.Mkdir(stage, 0700); err != nil {
		return "", err
	}
	if ownedStage, err = os.Lstat(stage); err != nil {
		return "", err
	}
	if err = backupDatabase(ctx, db, filepath.Join(stage, "database", "iapm.sqlite"), run); err != nil {
		return "", err
	}
	if err = backupCopyFile(settings.ConfigPath, filepath.Join(stage, "config.json")); err != nil {
		return "", err
	}
	if err = backupCopyProjects(settings.DataDir, filepath.Join(stage, "Projects")); err != nil {
		return "", err
	}
	manifest, e := backupManifest(stage, now)
	if e != nil {
		return "", e
	}
	if err = backupWriteManifest(filepath.Join(stage, "manifest.json"), manifest); err != nil {
		return "", err
	}
	if _, err = VerifyBackup(stage); err != nil {
		return "", err
	}
	if err = backupSyncDir(stage); err != nil {
		return "", err
	}
	if _, e = os.Lstat(target); e == nil {
		return "", fmt.Errorf("backup target already exists")
	} else if !os.IsNotExist(e) {
		return "", e
	}
	published, err = os.Lstat(stage)
	if err != nil {
		return "", err
	}
	if err = os.Rename(stage, target); err != nil {
		published = nil
		return "", err
	}
	stage = ""
	if err = backupSyncDir(root); err != nil {
		return "", err
	}
	result, e := db.Exec("UPDATE backup_runs SET status='success',finished_at=?,error_message=NULL WHERE id=? AND status='running'", backupTime(time.Now().UTC()), run)
	if e != nil {
		return "", e
	}
	n, e := result.RowsAffected()
	if e != nil || n != 1 {
		return "", fmt.Errorf("backup run was not updated to success")
	}
	return target, nil
}
func PruneBackups(root string, days int, now time.Time) ([]string, error) {
	backupMutex.Lock()
	defer backupMutex.Unlock()
	return backupPruneLocked(root, days, now)
}
func backupPruneLocked(root string, days int, now time.Time) ([]string, error) {
	removed := []string{}
	if days < 0 || days > 3650 {
		return nil, fmt.Errorf("invalid backup retention")
	}
	info, e := os.Lstat(root)
	if os.IsNotExist(e) {
		return removed, nil
	}
	if e != nil {
		return nil, e
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("backup_dir must be a directory without symlink")
	}
	entries, e := os.ReadDir(root)
	if e != nil {
		return nil, e
	}
	type candidate struct {
		path string
		at   time.Time
	}
	candidates := []candidate{}
	for _, entry := range entries {
		if !backupName.MatchString(entry.Name()) || !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := filepath.Join(root, entry.Name())
		_, created, e := backupReadManifest(name)
		if e != nil || entry.Name() != created.Format("2006-01-02_150405") {
			continue
		}
		candidates = append(candidates, candidate{name, created})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].at.Equal(candidates[j].at) {
			return candidates[i].path > candidates[j].path
		}
		return candidates[i].at.After(candidates[j].at)
	})
	cutoff := now.AddDate(0, 0, -days)
	retained := 0
	for _, item := range candidates {
		if retained >= 2 && !item.at.Before(cutoff) {
			continue
		}
		before, e := os.Lstat(item.path)
		if e != nil {
			continue
		}
		if _, e = VerifyBackup(item.path); e != nil {
			continue
		}
		if retained < 2 {
			retained++
			continue
		}
		current, e := os.Lstat(item.path)
		if e != nil || !os.SameFile(before, current) {
			return removed, fmt.Errorf("backup changed during cleanup")
		}
		if e = os.RemoveAll(item.path); e != nil {
			return removed, e
		}
		removed = append(removed, item.path)
	}
	return removed, nil
}
