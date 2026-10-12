package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"sunyu.local/erp/internal/pathidentity"
)

type Transaction struct {
	Job           Job               `json:"job"`
	Manifest      Manifest          `json:"manifest"`
	Old           Manifest          `json:"old"`
	Stage         string            `json:"stage"`
	State         string            `json:"state"`
	Backup        string            `json:"backup"`
	DataDir       string            `json:"data_dir"`
	DataIdentity  string            `json:"data_identity"`
	DataExisted   bool              `json:"data_existed"`
	ConfigExisted bool              `json:"config_existed"`
	DataFiles     map[string]string `json:"data_files"`
	DataDirs      []string          `json:"data_dirs"`
	ProgramFiles  map[string]string `json:"program_files"`
	LegacyFiles   map[string]string `json:"legacy_files,omitempty"`
	ConfigHash    string            `json:"config_hash,omitempty"`
	RestorePhase  string            `json:"restore_phase,omitempty"`
	NewPID        int               `json:"new_pid,omitempty"`
}

func (e *Engine) saveTransaction(tx *Transaction) error {
	return writeJSON(filepath.Join(e.Root, ".updates", "transaction-v2.json"), tx)
}
func inside(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && (rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// Compare existing directory identities in one spelling, including Windows 8.3
// aliases. Missing descendants are appended without creating or rewriting Data.
func comparisonPath(path string) (string, error) {
	var suffix []string
	for current := filepath.Clean(path); ; current = filepath.Dir(current) {
		resolved, err := pathidentity.ResolveExisting(current)
		if err == nil {
			for i := len(suffix) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, suffix[i])
			}
			return resolved, nil
		}
		if !os.IsNotExist(err) || filepath.Dir(current) == current {
			return "", err
		}
		suffix = append(suffix, filepath.Base(current))
	}
}

func installationPaths(root string) (string, string, error) {
	var raw map[string]json.RawMessage
	b, err := os.ReadFile(filepath.Join(root, "config.json"))
	if err != nil && !os.IsNotExist(err) {
		return "", "", err
	}
	if err == nil {
		if err = json.Unmarshal(b, &raw); err != nil {
			return "", "", err
		}
	}
	get := func(key, def string) (string, error) {
		s := def
		if v, ok := raw[key]; ok && string(v) != "null" {
			if err := json.Unmarshal(v, &s); err != nil {
				return "", err
			}
		}
		if s == "" {
			return "", nil
		}
		if !filepath.IsAbs(s) {
			s = filepath.Join(root, s)
		}
		return filepath.Abs(s)
	}
	data, err := get("data_dir", "Data")
	if err != nil {
		return "", "", err
	}
	backup, err := get("backup_dir", "")
	if err != nil {
		return "", "", err
	}
	for _, p := range []string{data, backup} {
		if p != "" {
			if _, err := checkedDataPath(root, p); err != nil {
				return "", "", err
			}
		}
	}
	return data, backup, nil
}

func checkedDataPath(root, path string) (string, error) {
	physicalRoot, err := comparisonPath(root)
	if err != nil {
		return "", err
	}
	physical, err := comparisonPath(path)
	if err != nil {
		return "", err
	}
	// The configured root may itself be a link, as supported by the previous
	// release. Work only on its frozen physical target; never follow links inside.
	if _, err := noLinks(physical); err != nil {
		return "", err
	}
	if inside(physical, physicalRoot) || inside(filepath.Join(physicalRoot, ".updates"), physical) || inside(physical, filepath.Join(physicalRoot, ".updates")) || inside(filepath.Join(physicalRoot, "app"), physical) || inside(physical, filepath.Join(physicalRoot, "app")) {
		return "", errors.New("数据或业务备份目录与程序、更新工作目录重叠，无法安全升级")
	}
	return physical, nil
}

type dataBoundary struct{ root, data, backup string }

func readDataBoundary(root string) (dataBoundary, error) {
	data, backup, err := installationPaths(root)
	if err != nil {
		return dataBoundary{}, err
	}
	physicalRoot, err := comparisonPath(root)
	if err != nil {
		return dataBoundary{}, err
	}
	for _, p := range []*string{&data, &backup} {
		if *p != "" {
			*p, err = comparisonPath(*p)
			if err != nil {
				return dataBoundary{}, err
			}
		}
	}
	return dataBoundary{physicalRoot, data, backup}, nil
}

func (b dataBoundary) protects(relative string) bool {
	path := filepath.Join(b.root, filepath.FromSlash(relative))
	return b.data != "" && inside(b.data, path) || b.backup != "" && inside(b.backup, path)
}

func noLinks(p string) (string, error) {
	p, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	current := p
	for {
		i, err := os.Lstat(current)
		if err == nil && pathidentity.IsLink(i) {
			return "", fmt.Errorf("拒绝链接目录：%s", current)
		}
		if err != nil && !os.IsNotExist(err) {
			return "", err
		}
		next := filepath.Dir(current)
		if next == current {
			break
		}
		current = next
	}
	return p, nil
}
func treeInventory(root string) (map[string]string, []string, error) {
	files := map[string]string{}
	dirs := []string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !validPath(rel) {
			return fmt.Errorf("数据文件名无法安全备份：%s", rel)
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("数据中含链接，无法安全备份：%s", rel)
		}
		if d.IsDir() {
			dirs = append(dirs, rel)
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("数据含特殊文件：%s", rel)
		}
		h, err := hashFile(p)
		if err != nil {
			return err
		}
		files[rel] = h
		return nil
	})
	return files, dirs, err
}
func verifyTree(root string, files map[string]string, dirs []string) error {
	actual, actualDirs, err := treeInventory(root)
	if err != nil {
		return err
	}
	if len(actual) != len(files) || len(actualDirs) != len(dirs) {
		return errors.New("备份内容数量不一致")
	}
	for p, h := range files {
		if actual[p] != h {
			return fmt.Errorf("备份内容损坏：%s", p)
		}
	}
	for i, p := range dirs {
		if actualDirs[i] != p {
			return errors.New("备份目录内容不一致")
		}
	}
	return nil
}
func copyTree(src, dst string, files map[string]string, dirs []string) error {
	if err := os.MkdirAll(dst, 0700); err != nil {
		return err
	}
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(dst, filepath.FromSlash(d)), 0700); err != nil {
			return err
		}
	}
	for _, p := range sortedKeys(files) {
		from, err := safePath(src, p)
		if err != nil {
			return err
		}
		to, err := safePath(dst, p)
		if err != nil {
			return err
		}
		if err = copyFile(from, to); err != nil {
			return err
		}
	}
	return verifyTree(dst, files, dirs)
}
func (e *Engine) backup(tx *Transaction) error {
	data, _, err := installationPaths(e.Root)
	if err != nil {
		return err
	}
	data, err = checkedDataPath(e.Root, data)
	if err != nil {
		return err
	}
	tx.DataDir = data
	tx.Backup = filepath.Join(e.Root, ".updates", "rollback", tx.Job.ID)
	if _, err = safePath(e.Root, ".updates/rollback/"+tx.Job.ID); err != nil {
		return err
	}
	if _, err = os.Lstat(tx.Backup); err == nil {
		var complete Transaction
		if readJSON(filepath.Join(tx.Backup, "backup.json"), &complete) != nil || complete.Job.ID != tx.Job.ID || complete.Backup != tx.Backup || complete.DataDir != data || complete.Manifest.Version != tx.Manifest.Version {
			return errors.New("升级备份位置已有其它内容，不能覆盖")
		}
		if complete.DataExisted {
			if err = verifyTree(filepath.Join(complete.Backup, "data"), complete.DataFiles, complete.DataDirs); err != nil {
				return err
			}
		}
		complete.Job = tx.Job
		*tx = complete
		return e.saveTransaction(tx)
	} else if !os.IsNotExist(err) {
		return err
	}
	partial := tx.Backup + ".partial"
	if _, err = noLinks(partial); err != nil {
		return err
	}
	if _, err = os.Lstat(partial); err == nil {
		var owner map[string]string
		if readJSON(filepath.Join(partial, "owner.json"), &owner) != nil || owner["application"] != Application || owner["id"] != tx.Job.ID {
			return errors.New("不完整备份缺少受管归属标记，不能自动清理")
		}
		if err = os.RemoveAll(partial); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = os.MkdirAll(partial, 0700); err != nil {
		return err
	}
	if err = writeJSON(filepath.Join(partial, "owner.json"), map[string]string{"application": Application, "id": tx.Job.ID}); err != nil {
		return err
	}
	tx.DataFiles, tx.DataDirs = map[string]string{}, []string{}
	if info, statErr := os.Stat(data); statErr == nil {
		if !info.IsDir() {
			return errors.New("数据目录不是普通目录")
		}
		tx.DataExisted = true
		tx.DataIdentity, err = pathidentity.Identity(data)
		if err != nil {
			return err
		}
		tx.DataFiles, tx.DataDirs, err = treeInventory(data)
		if err != nil {
			return err
		}
		if err = copyTree(data, filepath.Join(partial, "data"), tx.DataFiles, tx.DataDirs); err != nil {
			return err
		}
		if current, identityErr := pathidentity.Identity(data); identityErr != nil || current != tx.DataIdentity {
			return errors.New("备份期间数据根目录身份改变，已停止升级")
		}
	} else if !os.IsNotExist(statErr) {
		return statErr
	}
	configPath := filepath.Join(e.Root, "config.json")
	if _, err = os.Stat(configPath); err == nil {
		tx.ConfigExisted = true
		if err = copyFile(configPath, filepath.Join(partial, "config.json")); err != nil {
			return err
		}
		tx.ConfigHash, err = hashFile(filepath.Join(partial, "config.json"))
		if err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	tx.ProgramFiles = map[string]string{}
	owned := map[string]string{}
	for p, h := range tx.Old.Files {
		owned[p] = h
	}
	for p, h := range tx.LegacyFiles {
		owned[p] = h
	}
	owned["app/manifest.json"] = ""
	for _, p := range sortedKeys(owned) {
		source, err := safePath(e.Root, p)
		if err != nil {
			return err
		}
		info, err := os.Lstat(source)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("旧程序文件类型异常：%s", p)
		}
		h, err := hashFile(source)
		if err != nil {
			return err
		}
		tx.ProgramFiles[p] = h
		if err = copyFile(source, filepath.Join(partial, "program", filepath.FromSlash(p))); err != nil {
			return err
		}
	}
	// Refuse to overwrite paths never owned by the prior installation.
	for p, h := range tx.Manifest.Files {
		target, err := safePath(e.Root, p)
		if err != nil {
			return err
		}
		if _, err = os.Lstat(target); err == nil {
			if _, ok := tx.ProgramFiles[p]; !ok {
				actual, err := hashFile(target)
				if err != nil || actual != h {
					return fmt.Errorf("更新目标被非受管文件占用：%s", p)
				}
				tx.ProgramFiles[p] = actual
				if err = copyFile(target, filepath.Join(partial, "program", filepath.FromSlash(p))); err != nil {
					return err
				}
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	tx.State = "backed_up"
	if err = writeJSON(filepath.Join(partial, "backup.json"), tx); err != nil {
		return err
	}
	if err = os.Rename(partial, tx.Backup); err != nil {
		return err
	}
	return e.saveTransaction(tx)
}
func (e *Engine) replaceProgram(tx *Transaction) error {
	if err := tx.Manifest.Validate(); err != nil {
		return err
	}
	tx.State = "replacing"
	if err := e.saveTransaction(tx); err != nil {
		return err
	}
	merged := tx.Manifest
	merged.Component = ""
	merged.Files = map[string]string{}
	for p, h := range tx.Old.Files {
		if strings.HasPrefix(p, "app/web/"+tx.Old.FrontendVersion+"/") {
			merged.Files[p] = h
		}
	}
	for _, p := range sortedKeys(tx.Manifest.Files) {
		source, err := safePath(tx.Stage, p)
		if err != nil {
			return err
		}
		h, err := hashFile(source)
		if err != nil || h != tx.Manifest.Files[p] {
			return fmt.Errorf("暂存文件已变化：%s", p)
		}
		target, err := safePath(e.Root, p)
		if err != nil {
			return err
		}
		if err = copyFile(source, target); err != nil {
			return err
		}
		actual, err := hashFile(target)
		if err != nil || actual != h {
			return fmt.Errorf("程序写入校验失败：%s", p)
		}
		merged.Files[p] = h
	}
	return writeJSON(filepath.Join(e.Root, "app", "manifest.json"), merged)
}
func (e *Engine) restore(tx *Transaction) error {
	if tx.Backup != filepath.Join(e.Root, ".updates", "rollback", tx.Job.ID) {
		return errors.New("事务备份位置无效")
	}
	var saved Transaction
	if readJSON(filepath.Join(tx.Backup, "backup.json"), &saved) != nil || saved.Job.ID != tx.Job.ID || saved.Backup != tx.Backup || saved.DataDir != tx.DataDir || saved.DataIdentity != tx.DataIdentity || saved.DataExisted != tx.DataExisted || saved.ConfigExisted != tx.ConfigExisted || saved.ConfigHash != tx.ConfigHash || len(saved.ProgramFiles) == 0 || !reflect.DeepEqual(saved.ProgramFiles, tx.ProgramFiles) || !reflect.DeepEqual(saved.DataFiles, tx.DataFiles) || !reflect.DeepEqual(saved.DataDirs, tx.DataDirs) || !reflect.DeepEqual(saved.Manifest, tx.Manifest) {
		return errors.New("升级事务恢复元数据缺失或与原始备份不一致，已停止恢复")
	}
	var configValues map[string]json.RawMessage
	if tx.ConfigExisted {
		if err := readJSON(filepath.Join(tx.Backup, "config.json"), &configValues); err != nil {
			return err
		}
	}
	originalData := "Data"
	if raw, ok := configValues["data_dir"]; ok {
		if err := json.Unmarshal(raw, &originalData); err != nil {
			return err
		}
	}
	if !filepath.IsAbs(originalData) {
		originalData = filepath.Join(e.Root, originalData)
	}
	originalData, err := checkedDataPath(e.Root, originalData)
	if err != nil {
		return err
	}
	if originalData != tx.DataDir {
		return errors.New("恢复数据位置与原始配置不一致")
	}
	if tx.DataExisted {
		if err := verifyTree(filepath.Join(tx.Backup, "data"), tx.DataFiles, tx.DataDirs); err != nil {
			return err
		}
	}
	if tx.ConfigExisted {
		h, err := hashFile(filepath.Join(tx.Backup, "config.json"))
		if err != nil || h != tx.ConfigHash {
			return errors.New("配置备份损坏")
		}
	}
	for p, h := range tx.ProgramFiles {
		source, err := safePath(filepath.Join(tx.Backup, "program"), p)
		if err != nil {
			return err
		}
		actual, err := hashFile(source)
		if err != nil || actual != h {
			return fmt.Errorf("程序备份损坏：%s", p)
		}
	}

	if _, err := noLinks(tx.DataDir); err != nil {
		return err
	}
	if tx.DataExisted {
		identity, err := pathidentity.Identity(tx.DataDir)
		if err != nil || tx.DataIdentity == "" || identity != tx.DataIdentity {
			return errors.New("原数据根目录不存在或已被替换，请保留备份并人工恢复")
		}
	} else if _, err := os.Lstat(tx.DataDir); !os.IsNotExist(err) {
		return errors.New("原备份没有数据根目录，但当前位置已有其它内容，请保留现场并人工恢复")
	}
	if tx.RestorePhase == "complete" {
		return nil
	}
	if tx.RestorePhase == "" {
		tx.State, tx.RestorePhase = "restoring", "data"
		if err := e.saveTransaction(tx); err != nil {
			return err
		}
	}
	if tx.RestorePhase == "data" {
		// Preserve the root object, including its Windows short alias and ACL.
		// A crash leaves this checkpoint active; retry rebuilds the contents from
		// the immutable verified snapshot before any business process can restart.
		if tx.DataExisted {
			bound, err := os.OpenRoot(tx.DataDir)
			if err != nil {
				return err
			}
			defer bound.Close()
			directory, err := bound.Open(".")
			if err != nil {
				return err
			}
			entries, err := directory.ReadDir(-1)
			directory.Close()
			if err != nil {
				return err
			}
			for _, entry := range entries {
				if err := bound.RemoveAll(entry.Name()); err != nil {
					return err
				}
			}
			if err := copyTree(filepath.Join(tx.Backup, "data"), tx.DataDir, tx.DataFiles, tx.DataDirs); err != nil {
				return err
			}
			if identity, err := pathidentity.Identity(tx.DataDir); err != nil || identity != tx.DataIdentity {
				return errors.New("恢复期间数据根目录身份改变，请保留备份并人工恢复")
			}
		}
		tx.RestorePhase = "program"
		if err := e.saveTransaction(tx); err != nil {
			return err
		}
	}
	if tx.RestorePhase != "program" {
		return errors.New("恢复检查点无效")
	}

	for _, p := range sortedKeys(tx.ProgramFiles) {
		target, err := safePath(e.Root, p)
		if err != nil {
			return err
		}
		if err = copyFile(filepath.Join(tx.Backup, "program", filepath.FromSlash(p)), target); err != nil {
			return err
		}
	}
	for p := range tx.Manifest.Files {
		if _, old := tx.ProgramFiles[p]; !old {
			target, err := safePath(e.Root, p)
			if err != nil {
				return err
			}
			if err = os.Remove(target); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	if _, old := tx.ProgramFiles["app/manifest.json"]; !old {
		_ = os.Remove(filepath.Join(e.Root, "app", "manifest.json"))
	}
	if tx.ConfigExisted {
		if err := copyFile(filepath.Join(tx.Backup, "config.json"), filepath.Join(e.Root, "config.json")); err != nil {
			return err
		}
	} else {
		if err := os.Remove(filepath.Join(e.Root, "config.json")); err != nil && !os.IsNotExist(err) {
			return err
		}
	}

	tx.State, tx.RestorePhase = "rolled_back", "complete"
	if err := e.saveTransaction(tx); err != nil {
		return err
	}
	return nil
}
