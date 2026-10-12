package update

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func (e *Engine) installFrontend(j *Job, next Manifest, stage string) error {
	old, err := ReadManifest(e.Root)
	if err != nil {
		return err
	}
	if err = e.progress(j, "installing", "正在切换前端，当前填写内容不会被强制刷新", 65); err != nil {
		return err
	}
	merged := next
	merged.Component = ""
	merged.Files = map[string]string{}
	obsolete := map[string]string{}
	for p, h := range old.Files {
		if !strings.HasPrefix(p, "app/web/") || strings.HasPrefix(p, "app/web/"+old.FrontendVersion+"/") {
			merged.Files[p] = h
		} else {
			obsolete[p] = h
		}
	}
	var created []string
	rollback := func() {
		for _, p := range created {
			_ = os.Remove(p)
		}
	}
	for _, p := range sortedKeys(next.Files) {
		source, err := safePath(stage, p)
		if err != nil {
			rollback()
			return err
		}
		actual, err := hashFile(source)
		if err != nil || actual != next.Files[p] {
			rollback()
			return fmt.Errorf("暂存前端文件已变化：%s", p)
		}
		target, err := safePath(e.Root, p)
		if err != nil {
			rollback()
			return err
		}
		if info, err := os.Lstat(target); err == nil {
			if !info.Mode().IsRegular() {
				rollback()
				return errors.New("前端目标路径被其它文件占用")
			}
			h, err := hashFile(target)
			if err != nil || h != next.Files[p] {
				rollback()
				return fmt.Errorf("同版本前端内容已不同，拒绝覆盖：%s", p)
			}
		} else if !os.IsNotExist(err) {
			rollback()
			return err
		} else {
			source, err := safePath(stage, p)
			if err != nil {
				rollback()
				return err
			}
			if err = copyFile(source, target); err != nil {
				rollback()
				return err
			}
			created = append(created, target)
			actual, err = hashFile(target)
			if err != nil || actual != next.Files[p] {
				rollback()
				return fmt.Errorf("前端写入校验失败：%s", p)
			}
		}
		merged.Files[p] = next.Files[p]
	}
	if err = writeJSON(filepath.Join(e.Root, ".updates", "frontend-previous.json"), old); err != nil {
		rollback()
		return err
	}
	if err = e.queueCleanup(obsolete); err != nil {
		rollback()
		return err
	}
	if err = writeJSON(filepath.Join(e.Root, "app", "manifest.json"), merged); err != nil {
		rollback()
		return err
	}
	if err = e.progress(j, "cleaning", "正在清理更旧的前端文件", 95); err != nil {
		return err
	}
	if err = e.retryCleanup(); err != nil {
		j.Message = "前端已更新；" + err.Error()
	}
	return nil
}

// Remove only manifest-owned, unchanged files. Modified or unknown files remain untouched.
func removeOwnedFiles(root string, files map[string]string) error {
	for _, p := range sortedKeys(files) {
		target, err := safePath(root, p)
		if err != nil {
			return err
		}
		info, err := os.Lstat(target)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		h, err := hashFile(target)
		if err != nil {
			return err
		}
		if h != files[p] {
			continue
		}
		if err = os.Remove(target); err != nil {
			return err
		}
		parent := filepath.Dir(target)
		for parent != root && parent != filepath.Join(root, "app") && parent != filepath.Join(root, ".updates") {
			if err = os.Remove(parent); err != nil {
				break
			}
			parent = filepath.Dir(parent)
		}
	}
	return nil
}
