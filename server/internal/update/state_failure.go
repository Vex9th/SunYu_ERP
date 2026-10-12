package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (e *Engine) requestPath(id string) string {
	return filepath.Join(e.Root, ".updates", "requests", strings.ToLower(id)+".json")
}
func newerJob(current, candidate *Job) *Job {
	if candidate == nil {
		return current
	}
	if current == nil {
		return candidate
	}
	a, ae := time.Parse(time.RFC3339Nano, candidate.UpdatedAt)
	b, be := time.Parse(time.RFC3339Nano, current.UpdatedAt)
	if ae == nil && (be != nil || a.After(b)) {
		return candidate
	}
	return current
}
func (e *Engine) memoryStateFailure(id string) *Job {
	e.stateMu.RLock()
	defer e.stateMu.RUnlock()
	var current *Job
	for key, value := range e.stateFailures {
		if id == "" || key == strings.ToLower(id) {
			v := value
			current = newerJob(current, &v)
		}
	}
	return current
}
func (e *Engine) forgetStateFailure(j Job) {
	e.stateMu.Lock()
	defer e.stateMu.Unlock()
	key := strings.ToLower(j.RequestID)
	if old, ok := e.stateFailures[key]; ok && newerJob(&old, &j) == &j {
		delete(e.stateFailures, key)
	}
}
func (e *Engine) currentJob() *Job {
	var current *Job
	var stored Job
	if readJSON(filepath.Join(e.Root, ".updates", "job.json"), &stored) == nil {
		current = &stored
	}
	if current != nil {
		if request, err := e.Request(current.RequestID); err == nil {
			current = newerJob(current, request)
		}
	} else {
		entries, _ := os.ReadDir(filepath.Join(e.Root, ".updates", "requests"))
		for _, entry := range entries {
			if !entry.IsDir() && requestPattern.MatchString(strings.TrimSuffix(entry.Name(), ".json")) {
				var j Job
				if readJSON(filepath.Join(e.Root, ".updates", "requests", entry.Name()), &j) == nil {
					current = newerJob(current, &j)
				}
			}
		}
	}
	if current != nil {
		return newerJob(current, e.memoryStateFailure(current.RequestID))
	}
	return e.memoryStateFailure("")
}

// Keep two existing snapshots consistent as far as the filesystem permits. The
// caller receives a real error; no extra shadow files or durable success claims.
func (e *Engine) recordStateFailure(j *Job, cause error) error {
	// UI storage errors are separate from the installer transaction state.
	failure := *j
	j = &failure
	if j.PersistenceError != "" {
		j.Error = strings.TrimSpace(strings.TrimSuffix(j.Error, j.PersistenceError))
	}
	j.PersistenceError = cause.Error()
	j.Error = strings.TrimSpace(j.Error + "\n" + j.PersistenceError)
	if j.Status != "manual_recovery" {
		j.Status, j.Phase = "failed", "failed"
	}
	j.Message = "更新状态保存失败，请检查 .updates 目录占用和磁盘权限；实际安装版本请以版本信息为准"
	j.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	e.stateMu.Lock()
	if e.stateFailures == nil {
		e.stateFailures = map[string]Job{}
	}
	e.stateFailures[strings.ToLower(j.RequestID)] = *j
	e.stateMu.Unlock()
	_ = writeJSON(filepath.Join(e.Root, ".updates", "job.json"), j)
	if requestPattern.MatchString(j.RequestID) {
		_ = writeJSON(e.requestPath(j.RequestID), j)
	}
	line := fmt.Sprintf("%s state persistence failure job=%s request=%s: %v\n", j.UpdatedAt, j.ID, j.RequestID, cause)
	if f, err := openUpdateLog(e.Root); err == nil {
		_, _ = f.WriteString(line)
		_ = f.Close()
	} else {
		_, _ = fmt.Fprint(os.Stderr, line)
	}
	return cause
}
