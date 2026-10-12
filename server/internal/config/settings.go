// Package config preserves the existing installation's JSON configuration.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

type Settings struct {
	ConfigPath, DataDir, BackupDir, Host, SessionSecret                 string
	Port, BackupIntervalHours, BackupRetentionDays, MaxDocumentUploadMB int
	BackupEnabled                                                       bool
}

var configMu sync.Mutex
var allowed = map[string]bool{"data_dir": true, "backup_dir": true, "backup_enabled": true, "backup_interval_hours": true, "backup_retention_days": true, "host": true, "port": true, "session_secret": true, "max_document_upload_mb": true}

func Load(path string) (Settings, error) {
	configMu.Lock()
	defer configMu.Unlock()
	return load(path, nil)
}
func UpdateBackup(path string, enabled *bool, directory *string, interval, retention int) (Settings, error) {
	configMu.Lock()
	defer configMu.Unlock()
	return load(path, func(raw map[string]any) {
		if enabled == nil {
			if directory == nil {
				raw["backup_dir"] = nil
			} else {
				raw["backup_dir"] = strings.TrimSpace(*directory)
			}
		} else {
			raw["backup_enabled"] = *enabled
			if directory != nil {
				raw["backup_dir"] = strings.TrimSpace(*directory)
			}
		}
		raw["backup_interval_hours"] = json.Number(fmt.Sprint(interval))
		raw["backup_retention_days"] = json.Number(fmt.Sprint(retention))
	})
}
func load(path string, patch func(map[string]any)) (Settings, error) {
	path, err := resolvePath(path)
	if err != nil {
		return Settings{}, err
	}
	raw := map[string]any{}
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return Settings{}, err
	}
	if err == nil {
		if !utf8.Valid(data) {
			return Settings{}, fmt.Errorf("config must be UTF-8")
		}
		dec := json.NewDecoder(strings.NewReader(string(data)))
		dec.UseNumber()
		if err = dec.Decode(&raw); err != nil || raw == nil {
			return Settings{}, fmt.Errorf("config root must be a JSON object: %v", err)
		}
		if err = dec.Decode(new(any)); err != io.EOF {
			return Settings{}, fmt.Errorf("config contains trailing JSON or invalid content")
		}
	}
	if patch != nil {
		patch(raw)
	}
	for key := range raw {
		if !allowed[key] {
			return Settings{}, fmt.Errorf("unknown config key: %s", key)
		}
	}
	text := func(key, def string, nullable bool) (string, error) {
		v, ok := raw[key]
		if !ok || (nullable && v == nil) {
			return def, nil
		}
		s, ok := v.(string)
		if !ok || strings.TrimSpace(s) == "" {
			return "", fmt.Errorf("invalid %s", key)
		}
		return s, nil
	}
	number := func(key string, def, min, max int) (int, error) {
		v, ok := raw[key]
		if !ok {
			return def, nil
		}
		n, ok := v.(json.Number)
		if !ok {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		i, e := n.Int64()
		if e != nil || i < int64(min) || i > int64(max) {
			return 0, fmt.Errorf("invalid %s", key)
		}
		return int(i), nil
	}
	s := Settings{ConfigPath: path}
	if s.Host, err = text("host", "0.0.0.0", false); err != nil {
		return s, err
	}
	if s.Port, err = number("port", 8765, 1, 65535); err != nil {
		return s, err
	}
	if s.BackupIntervalHours, err = number("backup_interval_hours", 24, 1, 8760); err != nil {
		return s, err
	}
	if s.BackupRetentionDays, err = number("backup_retention_days", 30, 0, 3650); err != nil {
		return s, err
	}
	if s.MaxDocumentUploadMB, err = number("max_document_upload_mb", 4096, 1, 16384); err != nil {
		return s, err
	}
	dir, err := text("data_dir", "Data", false)
	if err != nil {
		return s, err
	}
	resolve := func(v string) (string, error) {
		if !filepath.IsAbs(v) {
			v = filepath.Join(filepath.Dir(path), v)
		}
		v, e := resolvePath(v)
		if e != nil {
			return "", e
		}
		if info, e := os.Stat(v); e == nil {
			if !info.IsDir() {
				return "", fmt.Errorf("not a directory: %s", v)
			}
		} else if !os.IsNotExist(e) {
			return "", e
		}
		return filepath.Clean(v), nil
	}
	if s.DataDir, err = resolve(dir); err != nil {
		return s, err
	}
	backup, err := text("backup_dir", "", true)
	if err != nil {
		return s, err
	}
	if backup != "" {
		if s.BackupDir, err = resolve(backup); err != nil {
			return s, err
		}
		projects, e := resolvePath(filepath.Join(s.DataDir, "Projects"))
		if e != nil {
			return s, e
		}
		rel, e := filepath.Rel(projects, s.BackupDir)
		if e == nil && (rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
			return s, fmt.Errorf("backup_dir must not be inside Data/Projects")
		}
	}
	s.BackupEnabled = s.BackupDir != ""
	if v, ok := raw["backup_enabled"]; ok {
		flag, ok := v.(bool)
		if !ok {
			return s, fmt.Errorf("backup_enabled must be boolean")
		}
		s.BackupEnabled = flag
	}
	secret, exists := raw["session_secret"]
	if exists {
		if _, ok := secret.(string); !ok {
			return s, fmt.Errorf("session_secret must be a string")
		}
	}
	write := patch != nil
	if !exists || strings.TrimSpace(secret.(string)) == "" {
		buf := make([]byte, 32)
		if _, err = rand.Read(buf); err != nil {
			return s, err
		}
		secret = base64.RawURLEncoding.EncodeToString(buf)
		raw["session_secret"] = secret
		write = true
	}
	s.SessionSecret = secret.(string)
	if write {
		if err = WriteJSON(path, raw); err != nil {
			return s, err
		}
	}
	return s, nil
}

// Resolve existing links while allowing the final directory to be created later.
// The legacy pathlib.resolve() behavior also binds relative Data paths to the
// target configuration file, rather than to an alias used to launch the program.
func resolvePath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return resolveMissingPath(absolute, 0)
}

func resolveMissingPath(path string, links int) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	info, statErr := os.Lstat(path)
	if statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		if links >= 64 {
			return "", fmt.Errorf("too many symbolic links: %s", path)
		}
		target, err := os.Readlink(path)
		if err != nil {
			return "", err
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(path), target)
		}
		return resolveMissingPath(filepath.Clean(target), links+1)
	}
	if statErr != nil && !os.IsNotExist(statErr) {
		return "", statErr
	}
	parent := filepath.Dir(path)
	if parent == path {
		return "", err
	}
	resolved, err = resolveMissingPath(parent, links)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(path)), nil
}

func WriteJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
