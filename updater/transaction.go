package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sunyu.local/updater/internal/pathidentity"
)

type Snapshot struct {
	Root          string            `json:"root"`
	JobID         string            `json:"job_id"`
	DataDir       string            `json:"data_dir"`
	DataIdentity  string            `json:"data_identity"`
	DataExisted   bool              `json:"data_existed"`
	DataFiles     map[string]string `json:"data_files"`
	DataDirs      []string          `json:"data_dirs"`
	Program       map[string]string `json:"program"`
	ConfigHash    string            `json:"config_hash"`
	ConfigExisted bool              `json:"config_existed"`
}
type Transaction struct {
	JobID        string   `json:"job_id"`
	State        string   `json:"state"`
	OldVersion   string   `json:"old_version"`
	NewVersion   string   `json:"new_version"`
	Manifest     Manifest `json:"manifest"`
	Snapshot     Snapshot `json:"snapshot"`
	RestorePhase string   `json:"restore_phase"`
}

func (e *Engine) saveTx(tx *Transaction) error {
	return writeJSON(filepath.Join(e.root, ".updates/transaction.json"), tx)
}
func (e *Engine) barrier(tx *Transaction, phase string) error {
	return writeJSON(filepath.Join(e.root, ".updates/install.json"), Installer{JobID: tx.JobID, Phase: phase, OldVersion: tx.OldVersion, NewVersion: tx.NewVersion})
}
func (e *Engine) dataPath() (string, error) {
	return e.dataPathFrom(filepath.Join(e.root, "config.json"))
}
func (e *Engine) dataPathFrom(config string) (string, error) {
	var c struct {
		DataDir   string `json:"data_dir"`
		BackupDir string `json:"backup_dir"`
	}
	err := readJSON(config, &c)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if c.DataDir == "" {
		c.DataDir = "Data"
	}
	if !filepath.IsAbs(c.DataDir) {
		c.DataDir = filepath.Join(e.root, c.DataDir)
	}
	data, err := resolveMissing(c.DataDir)
	if err != nil {
		return "", err
	}
	updates := filepath.Join(e.root, ".updates")
	if inside(data, e.root) || inside(updates, data) || inside(data, updates) {
		return "", errors.New("DATA目录与程序或更新工作目录重叠，无法安全升级")
	}
	if c.BackupDir != "" {
		if !filepath.IsAbs(c.BackupDir) {
			c.BackupDir = filepath.Join(e.root, c.BackupDir)
		}
		backup, err := resolveMissing(c.BackupDir)
		if err != nil {
			return "", err
		}
		if inside(updates, backup) || inside(backup, updates) {
			return "", errors.New("业务备份目录与更新目录重叠")
		}
	}
	return data, nil
}
func inventory(root string) (map[string]string, []string, error) {
	files := map[string]string{}
	var dirs []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			info, err := d.Info()
			if err != nil {
				return err
			}
			if !info.IsDir() || pathidentity.IsLink(info) {
				return errors.New("DATA根必须是已解析的真实目录")
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if pathidentity.IsLink(info) {
			return fmt.Errorf("DATA中存在链接，未开始替换：%s", p)
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if info.IsDir() {
			dirs = append(dirs, rel)
			return nil
		}
		if !info.Mode().IsRegular() {
			return errors.New("DATA包含非普通文件")
		}
		h, err := hashFile(p)
		if err == nil {
			files[rel] = h
		}
		return err
	})
	sort.Strings(dirs)
	return files, dirs, err
}
func copyInventory(src, dst string, files map[string]string, dirs []string) error {
	if err := os.MkdirAll(dst, 0700); err != nil {
		return err
	}
	for _, p := range dirs {
		if !safeRelative(p) {
			return errors.New("备份目录名无效")
		}
		if err := os.MkdirAll(filepath.Join(dst, filepath.FromSlash(p)), 0700); err != nil {
			return err
		}
	}
	for p, want := range files {
		if !safeRelative(p) {
			return errors.New("备份文件名无效")
		}
		if err := copyFile(filepath.Join(src, filepath.FromSlash(p)), filepath.Join(dst, filepath.FromSlash(p))); err != nil {
			return err
		}
		h, err := hashFile(filepath.Join(dst, filepath.FromSlash(p)))
		if err != nil || h != want {
			return errors.New("数据备份校验失败")
		}
	}
	return nil
}
func safeRelative(p string) bool {
	return p != "" && p != "." && filepath.ToSlash(filepath.Clean(filepath.FromSlash(p))) == p && !filepath.IsAbs(p) && p != ".." && len(p) > 0 && p[0] != '/' && !containsUnsafePath(p)
}
func containsUnsafePath(p string) bool {
	for _, c := range p {
		if c == '\\' || c == ':' || c == 0 {
			return true
		}
	}
	return len(p) >= 3 && p[:3] == "../"
}
func (e *Engine) backup(tx *Transaction, data string) error {
	base := filepath.Join(e.root, ".updates/backup", tx.JobID)
	partial := base + ".partial"
	if err := os.MkdirAll(filepath.Dir(base), 0700); err != nil {
		return err
	}
	if err := os.Mkdir(partial, 0700); err != nil {
		return err
	}
	snap := Snapshot{Root: e.root, JobID: tx.JobID, DataDir: data, Program: map[string]string{}}
	if err := writeJSON(filepath.Join(partial, "owner.json"), map[string]string{"root": e.root, "job_id": tx.JobID}); err != nil {
		return err
	}
	if _, err := os.Stat(data); err == nil {
		snap.DataExisted = true
		snap.DataIdentity, err = pathidentity.Identity(data)
		if err != nil {
			return err
		}
		snap.DataFiles, snap.DataDirs, err = inventory(data)
		if err != nil {
			return err
		}
		if err = copyInventory(data, filepath.Join(partial, "data"), snap.DataFiles, snap.DataDirs); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if snap.DataExisted {
		id, err := pathidentity.Identity(data)
		if err != nil || id != snap.DataIdentity {
			return errors.New("备份期间DATA根目录发生变化")
		}
	}
	for _, name := range []string{"SunYu_ERP.exe", "update.exe"} {
		p := filepath.Join(e.root, name)
		h, err := hashFile(p)
		if os.IsNotExist(err) && name == "update.exe" {
			continue
		}
		if err != nil {
			return err
		}
		snap.Program[name] = h
		if err = copyFile(p, filepath.Join(partial, "program", name)); err != nil {
			return err
		}
	}
	config := filepath.Join(e.root, "config.json")
	if _, err := os.Stat(config); err == nil {
		snap.ConfigExisted = true
		snap.ConfigHash, err = hashFile(config)
		if err != nil {
			return err
		}
		if err = copyFile(config, filepath.Join(partial, "config.json")); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	tx.Snapshot = snap
	tx.State = "backed_up"
	if err := writeJSON(filepath.Join(partial, "snapshot.json"), snap); err != nil {
		return err
	}
	if err := os.Rename(partial, base); err != nil {
		return err
	}
	return e.saveTx(tx)
}
func (e *Engine) install(m Manifest, stage string) error {
	e.apply = true
	if err := e.ensureVersion(true); err != nil {
		return err
	}
	if service, ok := e.services.(interface{ validate() error }); ok {
		if err := service.validate(); err != nil {
			return err
		}
	}
	data, err := e.dataPath()
	if err != nil {
		return err
	}
	for name, want := range m.Files {
		h, err := hashFile(filepath.Join(stage, name))
		if err != nil || h != want {
			return errors.New("安装前文件SHA256复核失败")
		}
	}
	tx := Transaction{JobID: e.status.JobID, State: "preparing", OldVersion: e.current, NewVersion: m.Version, Manifest: m}
	if err = e.saveTx(&tx); err != nil {
		return err
	}
	if err = e.barrier(&tx, "installing"); err != nil {
		return err
	}
	if err = e.progress("stopping", "更新包已校验，正在等待主程序安全退出", 40); err != nil {
		return err
	}
	if err = e.services.stop(); err != nil {
		_ = e.barrier(&tx, "verified")
		tx.State = "rolled_back"
		_ = e.saveTx(&tx)
		return err
	}
	if err = e.progress("backing_up", "正在备份原程序、DATA和配置", 50); err != nil {
		return e.resumeUnchanged(&tx, err)
	}
	if err = e.backup(&tx, data); err != nil {
		return e.resumeUnchanged(&tx, err)
	}
	if err = e.progress("installing", "正在替换主程序和更新器", 70); err != nil {
		return e.rollback(&tx, err)
	}
	tx.State = "replacing"
	if err = e.saveTx(&tx); err != nil {
		return e.rollback(&tx, err)
	}
	for _, name := range []string{"SunYu_ERP.exe", "update.exe"} {
		if err = copyFile(filepath.Join(stage, name), filepath.Join(e.root, name)); err != nil {
			return e.rollback(&tx, err)
		}
		if actual, err := hashFile(filepath.Join(e.root, name)); err != nil || actual != m.Files[name] {
			return e.rollback(&tx, errors.New("安装文件落盘校验失败"))
		}
	}
	tx.State = "starting"
	if err = e.saveTx(&tx); err != nil {
		return e.rollback(&tx, err)
	}
	if err = e.progress("restarting", "正在验证新版本启动；业务写入暂时暂停", 85); err != nil {
		return e.rollback(&tx, err)
	}
	if err = e.services.start(m.Version); err != nil {
		return e.rollback(&tx, err)
	}
	if tx.Snapshot.ConfigExisted {
		h, err := hashFile(filepath.Join(e.root, "config.json"))
		if err != nil || h != tx.Snapshot.ConfigHash {
			return e.rollback(&tx, errors.New("新版本改变了原配置文件，已停止更新"))
		}
	}
	tx.State = "verified"
	if err = e.saveTx(&tx); err != nil {
		return err
	}
	return e.commit(&tx)
}
func (e *Engine) resumeUnchanged(tx *Transaction, cause error) error {
	tx.State = "rolled_back"
	if err := e.saveTx(tx); err != nil {
		return errors.Join(cause, err)
	}
	if err := e.services.start(tx.OldVersion); err != nil {
		return fmt.Errorf("程序未被替换，但原程序重新启动失败：%w", errors.Join(cause, err))
	}
	if err := e.barrier(tx, "verified"); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}
func (e *Engine) commit(tx *Transaction) error {
	if tx.State != "verified" && tx.State != "complete" {
		return errors.New("尚未持久化验证结果，不能提交升级")
	}
	if err := e.barrier(tx, "verified"); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(e.root, ".updates/installed.json"), map[string]string{"version": tx.NewVersion, "sha256": tx.Manifest.Files["SunYu_ERP.exe"]}); err != nil {
		return err
	}
	tx.State = "complete"
	if err := e.saveTx(tx); err != nil {
		return err
	}
	e.current = tx.NewVersion
	e.status.UpdateAvailable = false
	warning := "更新完成"
	if err := e.cleanup(tx.JobID); err != nil {
		warning = "更新完成，部分旧缓存暂未清理：" + err.Error()
	}
	return e.progress("success", warning, 100)
}
func (e *Engine) restore(tx *Transaction) error {
	if tx.State == "verified" || tx.State == "complete" {
		return errors.New("已提交版本禁止回滚DATA")
	}
	snap := tx.Snapshot
	base := filepath.Join(e.root, ".updates/backup", tx.JobID)
	var saved Snapshot
	if !jobPattern.MatchString(tx.JobID) || readJSON(filepath.Join(base, "snapshot.json"), &saved) != nil || !reflect.DeepEqual(snap, saved) || snap.Root != e.root || snap.JobID != tx.JobID {
		return errors.New("恢复快照元数据不一致，请保留备份人工恢复")
	}
	config := filepath.Join(e.root, "config.json")
	if snap.ConfigExisted {
		config = filepath.Join(base, "config.json")
	}
	if err := noLinks(base); err != nil {
		return err
	}
	if err := noLinks(filepath.Join(base, "program")); err != nil {
		return err
	}
	data, err := e.dataPathFrom(config)
	if err != nil || data != snap.DataDir {
		return errors.New("DATA配置路径发生变化，未修改任何数据")
	}
	for name, want := range snap.Program {
		if name != "SunYu_ERP.exe" && name != "update.exe" {
			return errors.New("恢复程序路径异常")
		}
		h, err := hashFile(filepath.Join(base, "program", name))
		if err != nil || h != want {
			return errors.New("原程序备份校验失败")
		}
	}
	if snap.ConfigExisted {
		h, err := hashFile(filepath.Join(base, "config.json"))
		if err != nil || h != snap.ConfigHash {
			return errors.New("配置备份校验失败")
		}
	}
	if snap.DataExisted {
		files, dirs, err := inventory(filepath.Join(base, "data"))
		if err != nil || !reflect.DeepEqual(files, snap.DataFiles) || !reflect.DeepEqual(dirs, snap.DataDirs) {
			return errors.New("DATA快照校验失败")
		}
		id, err := pathidentity.Identity(data)
		if err != nil || id != snap.DataIdentity {
			return errors.New("DATA根目录被删除或替换，未自动覆盖，请保留快照人工恢复")
		}
	} else if _, err := os.Stat(data); err == nil {
		return errors.New("原DATA不存在但新版本创建了目录，请保留快照人工确认")
	}
	tx.State = "restoring"
	tx.RestorePhase = "data"
	if err = e.saveTx(tx); err != nil {
		return err
	}
	if snap.DataExisted {
		bound, err := os.OpenRoot(data)
		if err != nil {
			return err
		}
		entries, err := os.ReadDir(data)
		if err != nil {
			bound.Close()
			return err
		}
		for _, entry := range entries {
			if err = bound.RemoveAll(entry.Name()); err != nil {
				bound.Close()
				return err
			}
		}
		bound.Close()
		if err = copyInventory(filepath.Join(base, "data"), data, snap.DataFiles, snap.DataDirs); err != nil {
			return err
		}
	}
	tx.RestorePhase = "program"
	if err = e.saveTx(tx); err != nil {
		return err
	}
	for name := range snap.Program {
		if err = copyFile(filepath.Join(base, "program", name), filepath.Join(e.root, name)); err != nil {
			return err
		}
	}
	if snap.ConfigExisted {
		if err = copyFile(filepath.Join(base, "config.json"), filepath.Join(e.root, "config.json")); err != nil {
			return err
		}
	}
	tx.RestorePhase = "complete"
	return e.saveTx(tx)
}
func (e *Engine) rollback(tx *Transaction, cause error) error {
	if tx.State == "verified" || tx.State == "complete" {
		return cause
	}
	if err := e.services.stop(); err != nil {
		return fmt.Errorf("更新失败且未能确认新进程停止，保留恢复快照：%w", errors.Join(cause, err))
	}
	if err := e.restore(tx); err != nil {
		return fmt.Errorf("更新失败，自动恢复未完成，业务保持维护：%w", errors.Join(cause, err))
	}
	// A fully restored snapshot is a durable boundary: subsequent startup/status
	// errors must not cause a second data restore after the old service can write.
	tx.State = "rolled_back"
	if err := e.saveTx(tx); err != nil {
		return err
	}
	if err := e.services.start(tx.OldVersion); err != nil {
		return fmt.Errorf("原程序和数据已还原，但启动验证失败：%w", errors.Join(cause, err))
	}
	if err := e.barrier(tx, "verified"); err != nil {
		return errors.Join(cause, err)
	}
	return fmt.Errorf("更新失败，已恢复原程序和原始数据：%w", cause)
}
func (e *Engine) recoverPending() (bool, error) {
	var tx Transaction
	err := readJSON(filepath.Join(e.root, ".updates/transaction.json"), &tx)
	if os.IsNotExist(err) {
		var marker Installer
		if readJSON(filepath.Join(e.root, ".updates/install.json"), &marker) == nil && marker.Phase != "verified" {
			return true, errors.New("维护标记缺少恢复事务，请保留.updates人工恢复")
		}
		return false, nil
	}
	if err != nil {
		return true, fmt.Errorf("升级事务损坏，请保留.updates恢复材料：%w", err)
	}
	if !jobPattern.MatchString(tx.JobID) {
		return true, errors.New("升级事务任务标识无效")
	}
	switch tx.State {
	case "complete":
		return false, nil
	case "verified":
		return true, e.commit(&tx)
	case "rolled_back":
		var barrier Installer
		if readJSON(filepath.Join(e.root, ".updates/install.json"), &barrier) == nil && barrier.Phase == "verified" {
			return false, nil
		}
		if err = e.services.start(tx.OldVersion); err != nil {
			return true, err
		}
		if err = e.barrier(&tx, "verified"); err != nil {
			return true, err
		}
		e.status.Error = "上次更新中断，原版本已恢复"
		return true, e.progress("failed", e.status.Error, 100)
	case "preparing":
		return true, e.resumeUnchanged(&tx, errors.New("上次任务中断，原程序尚未被替换"))
	case "backed_up", "replacing", "starting", "restoring":
		return true, e.rollback(&tx, errors.New("上次任务中断，正在恢复原版本"))
	default:
		return true, errors.New("未知升级事务状态，已停止自动安装")
	}
}
func (e *Engine) cleanup(keep string) error {
	if _, err := e.dataPath(); err != nil {
		return err
	}
	for _, name := range []string{"backup", "work"} {
		if err := noLinks(filepath.Join(e.root, ".updates", name)); err != nil {
			return err
		}
	}
	base := filepath.Join(e.root, ".updates/backup")
	entries, err := os.ReadDir(base)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasSuffix(entry.Name(), ".partial") {
			id := strings.TrimSuffix(entry.Name(), ".partial")
			var owner map[string]string
			dir := filepath.Join(base, entry.Name())
			if jobPattern.MatchString(id) && readJSON(filepath.Join(dir, "owner.json"), &owner) == nil && owner["root"] == e.root && owner["job_id"] == id {
				if err = os.RemoveAll(dir); err != nil {
					return err
				}
			}
		}
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == keep || !jobPattern.MatchString(entry.Name()) {
			continue
		}
		var snap Snapshot
		dir := filepath.Join(base, entry.Name())
		if readJSON(filepath.Join(dir, "snapshot.json"), &snap) == nil && snap.Root == e.root && snap.JobID == entry.Name() {
			if err = os.RemoveAll(dir); err != nil {
				return err
			}
		}
	}
	work := filepath.Join(e.root, ".updates/work")
	entries, err = os.ReadDir(work)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	self, _ := os.Executable()
	self, _ = pathidentity.ResolveExisting(self)
	for _, entry := range entries {
		if !entry.IsDir() || !jobPattern.MatchString(entry.Name()) {
			continue
		}
		dir := filepath.Join(work, entry.Name())
		var owner map[string]string
		if readJSON(filepath.Join(dir, "owner.json"), &owner) != nil || owner["job_id"] != entry.Name() || owner["application"] != "SunYu_ERP" {
			continue
		}
		children, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, child := range children {
			p := filepath.Join(dir, child.Name())
			actual, _ := pathidentity.ResolveExisting(p)
			if actual == self || child.Name() == "owner.json" {
				continue
			}
			if err = os.RemoveAll(p); err != nil {
				return err
			}
		}
		if filepath.Dir(self) != dir {
			_ = os.Remove(filepath.Join(dir, "owner.json"))
			_ = os.Remove(dir)
		}
	}
	return nil
}
