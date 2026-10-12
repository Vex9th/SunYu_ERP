package update

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func (e *Engine) createWork(id string) (string, error) {
	if !regexpJobID(id) {
		return "", errors.New("更新工作标识无效")
	}
	dir, err := safePath(e.Root, ".updates/work/"+id)
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(filepath.Dir(dir), 0700); err != nil {
		return "", err
	}
	if err = os.Mkdir(dir, 0700); err != nil {
		return "", err
	}
	if err = writeJSON(filepath.Join(dir, "work.json"), map[string]string{"application": Application, "id": id}); err != nil {
		return "", err
	}
	return dir, nil
}

// Work roots are engine-created and explicitly marked. Unknown sibling directories are never removed.
func (e *Engine) cleanupWork(keep string, finishCurrent bool) error {
	if _, _, err := installationPaths(e.Root); err != nil {
		return err
	}
	base, err := safePath(e.Root, ".updates/work")
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(base)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	self, _ := os.Executable()
	self, _ = filepath.EvalSymlinks(self)
	for _, entry := range entries {
		if !entry.IsDir() || !regexpJobID(entry.Name()) || entry.Name() == keep && !finishCurrent {
			continue
		}
		dir := filepath.Join(base, entry.Name())
		var owner map[string]string
		if readJSON(filepath.Join(dir, "work.json"), &owner) != nil || owner["application"] != Application || owner["id"] != entry.Name() {
			continue
		}
		children, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		selfInWork := filepath.Dir(self) == dir
		complete := true
		for _, child := range children {
			if child.Name() == "work.json" || selfInWork && child.Name() == "request.json" {
				continue
			}
			p := filepath.Join(dir, child.Name())
			resolved, _ := filepath.EvalSymlinks(p)
			if resolved == self {
				complete = false
				continue
			}
			if err = os.RemoveAll(p); err != nil {
				complete = false
			}
		}
		if complete {
			if err = os.Remove(filepath.Join(dir, "work.json")); err != nil {
				return err
			}
			if err = os.Remove(dir); err != nil {
				return err
			}
		}
	}
	return nil
}
func (e *Engine) pruneRequests() {
	base := filepath.Join(e.Root, ".updates", "requests")
	entries, err := os.ReadDir(base)
	if err != nil || len(entries) <= 100 {
		return
	}
	type item struct{ path, time string }
	var old []item
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !requestPattern.MatchString(id) {
			continue
		}
		var j Job
		if readJSON(filepath.Join(base, entry.Name()), &j) == nil && terminal(j.Status) && j.Status != "manual_recovery" {
			old = append(old, item{filepath.Join(base, entry.Name()), j.UpdatedAt})
		}
	}
	sort.Slice(old, func(i, j int) bool { return old[i].time < old[j].time })
	for len(old) > 100 {
		_ = os.Remove(old[0].path)
		old = old[1:]
	}
}

func (e *Engine) ensureWork(id string) (string, error) {
	dir, err := safePath(e.Root, ".updates/work/"+id)
	if err != nil {
		return "", err
	}
	var marker map[string]string
	if err = readJSON(filepath.Join(dir, "work.json"), &marker); err == nil {
		if !regexpJobID(id) || marker["application"] != Application || marker["id"] != id {
			return "", errors.New("更新目录归属无效")
		}
		return dir, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return e.createWork(id)
}
