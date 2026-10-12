package update

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func (e *Engine) queueCleanup(files map[string]string) error {
	pending := map[string]string{}
	p := filepath.Join(e.Root, ".updates", "cleanup.json")
	if err := readJSON(p, &pending); err != nil && !os.IsNotExist(err) {
		return err
	}
	for path, h := range files {
		if !validPath(path) || !hashPattern.MatchString(h) {
			return errors.New("待清理清单无效")
		}
		pending[path] = h
	}
	return writeJSON(p, pending)
}
func (e *Engine) retryCleanup() error {
	p := filepath.Join(e.Root, ".updates", "cleanup.json")
	pending := map[string]string{}
	if err := readJSON(p, &pending); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	boundary, err := readDataBoundary(e.Root)
	if err != nil {
		return err
	}
	active, activeErr := ReadManifest(e.Root)
	if activeErr != nil {
		return nil
	}
	var first error
	for name, h := range pending {
		if !validPath(name) || !hashPattern.MatchString(h) {
			return errors.New("待清理路径或校验值无效")
		}
		_, err := safePath(e.Root, name)
		if err != nil {
			if first == nil {
				first = err
			}
			continue
		}
		if boundary.protects(name) || name == "config.json" {
			return errors.New("待清理路径与用户数据重叠")
		}
		if _, keep := active.Files[name]; keep {
			delete(pending, name)
			continue
		}
		if err = removeOwnedFiles(e.Root, map[string]string{name: h}); err != nil {
			if first == nil {
				first = err
			}
			continue
		}
		delete(pending, name)
	}
	if err = writeJSON(p, pending); err != nil {
		return err
	}
	if first != nil {
		return fmt.Errorf("部分旧文件暂被占用，将在下次启动或更新时重试：%w", first)
	}
	return nil
}
