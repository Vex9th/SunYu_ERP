package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"sunyu.local/erp/internal/lifecycle"
)

func (e *Engine) launchHelper(j *Job, m Manifest, stage string) error {
	old, err := ReadManifest(e.Root)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	legacy := map[string]string{}
	if os.IsNotExist(err) {
		legacy, err = legacyInventory(e.Root)
		if err != nil {
			return err
		}
	}
	tx := Transaction{Job: *j, Manifest: m, Old: old, Stage: stage, State: "prepared", LegacyFiles: legacy}
	helper := filepath.Join(e.Root, ".updates", "work", j.ID, "SunYuUpdateHelper.exe")
	source := filepath.Join(e.Root, "SunYu_ERP.exe")
	if old.Format != 2 {
		source, err = os.Executable()
		if err != nil {
			return err
		}
	}
	if err = copyFile(source, helper); err != nil {
		return err
	}
	if err = e.progress(j, "restarting", "已校验更新，正在准备安全安装", 45); err != nil {
		return err
	}
	tx.Job = *j
	if err = e.saveTransaction(&tx); err != nil {
		return err
	}
	logFile, err := openUpdateLog(e.Root)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(helper, "--apply-update", e.Root, j.ID)
	cmd.Dir = e.Root
	cmd.Stdout, cmd.Stderr = logFile, logFile
	configureDetached(cmd)
	if err = cmd.Start(); err != nil {
		tx.Job.Status, tx.Job.Error = "failed", err.Error()
		_ = e.saveTransaction(&tx)
		return err
	}
	return cmd.Process.Release()
}
func openUpdateLog(root string) (*os.File, error) {
	dir := filepath.Join(root, ".updates", "logs")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	return os.OpenFile(filepath.Join(dir, "update.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
}
func (e *Engine) mark(name string) error {
	p, err := safePath(e.Root, ".updates/"+name)
	if err != nil {
		return err
	}
	return atomicBytes(p, []byte(time.Now().UTC().Format(time.RFC3339Nano)), 0600)
}
func (e *Engine) clearStop() error {
	for _, name := range []string{"stop", "shutdown"} {
		if err := os.Remove(filepath.Join(e.Root, ".updates", name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
func waitLock(ctx context.Context, root, name string) (func(), error) {
	for {
		release, err := lifecycle.Acquire(root, name)
		if err == nil {
			return release, nil
		}
		if !errors.Is(err, lifecycle.ErrBusy) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
func (e *Engine) stopAndLock(ctx context.Context) (func(), error) {
	if err := e.mark("maintenance"); err != nil {
		return nil, err
	}
	if err := e.mark("shutdown"); err != nil {
		return nil, err
	}
	if err := e.mark("stop"); err != nil {
		return nil, err
	}
	var releases []func()
	undo := func() {
		for i := len(releases) - 1; i >= 0; i-- {
			releases[i]()
		}
	}
	for _, name := range []string{"launcher.lock", "server.lock", "backend.lock"} {
		release, err := waitLock(ctx, e.Root, name)
		if err != nil {
			undo()
			return nil, fmt.Errorf("等待程序安全退出超时或失败，未强制结束进程：%w", err)
		}
		releases = append(releases, release)
	}
	return undo, nil
}

// RunHelper runs from an independent copy, never the executable being replaced.
func RunHelper(root, id string) error {
	e, err := New(root)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	release, err := waitLock(ctx, e.Root, "installer.lock")
	if err != nil {
		return err
	}
	defer release()
	var tx Transaction
	if err = readJSON(filepath.Join(e.Root, ".updates", "transaction-v2.json"), &tx); err != nil {
		return err
	}
	if !regexpJobID(id) || tx.Job.ID != id || terminal(tx.Job.Status) && tx.Job.Status != "manual_recovery" && tx.State != "completed" && tx.State != "rolled_back" {
		return errors.New("升级事务标识不匹配或已结束")
	}
	if tx.Stage != filepath.Join(e.Root, ".updates", "work", id, "stage") {
		return errors.New("升级暂存目录无效")
	}
	if err = tx.Manifest.Validate(); err != nil {
		return err
	}
	if tx.Manifest.Component != "application" {
		return errors.New("完整升级助手不能安装其它组件")
	}
	if tx.State == "verified" || tx.State == "completed" {
		// After durable verification, cleanup recovery must never stop business or restore Data.
		if err = VerifyInstallation(e.Root); err != nil {
			return err
		}
		if err = e.releaseVerifiedMaintenance(&tx); err != nil {
			return err
		}
		if err = e.clearStop(); err != nil {
			return err
		}
		launchLock, lockErr := lifecycle.Acquire(e.Root, "launcher.lock")
		if lockErr == nil {
			launchLock()
			if _, err = e.startLauncher(tx.Job.ID, false); err != nil {
				return err
			}
		} else if !errors.Is(lockErr, lifecycle.ErrBusy) {
			return lockErr
		}
		return e.completeVerified(&tx)
	}
	_ = e.progress(&tx.Job, "backing_up", "正在等待当前业务操作与备份完成", 50)
	_ = e.saveTransaction(&tx)
	stopped, err := e.stopAndLock(ctx)
	if err != nil {
		tx.Job.Status, tx.Job.Error = "manual_recovery", err.Error()
		tx.Job.Message = "未能确认所有进程退出，程序文件未继续替换；请等待退出后重新运行启动器恢复"
		_ = e.saveTransaction(&tx)
		_ = e.saveJob(&tx.Job)
		return err
	}
	locked := true
	unlock := func() {
		if locked {
			stopped()
			locked = false
		}
	}
	defer unlock()
	if tx.State != "prepared" {
		return e.recoverLocked(&tx, unlock)
	}
	if err = e.backup(&tx); err != nil {
		tx.Job.Status, tx.Job.Error = "failed", err.Error()
		_ = e.clearStop()
		_ = os.Remove(filepath.Join(e.Root, ".updates", "maintenance"))
		_ = e.saveTransaction(&tx)
		_ = e.saveJob(&tx.Job)
		unlock()
		_, _ = e.startLauncher(id, false)
		return err
	}
	_ = e.progress(&tx.Job, "installing", "已完成校验备份，正在安装程序", 70)
	_ = e.saveTransaction(&tx)
	if err = e.replaceProgram(&tx); err != nil {
		return e.rollbackFailure(&tx, unlock, err)
	}
	tx.State = "starting"
	_ = e.progress(&tx.Job, "restarting", "正在启动新程序并验证版本", 85)
	if err = e.saveTransaction(&tx); err != nil {
		return e.rollbackFailure(&tx, unlock, err)
	}
	if err = e.clearStop(); err != nil {
		return e.rollbackFailure(&tx, unlock, err)
	}
	unlock()
	pid, err := e.startLauncher(id, true)
	if err == nil {
		tx.NewPID = pid
		_ = e.saveTransaction(&tx)
		err = e.waitHealthyOwned(tx.Manifest.BackendVersion, 90*time.Second, pid)
	}
	if err != nil {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer stopCancel()
		stopped, stopErr := e.stopAndLock(stopCtx)
		if stopErr != nil {
			return e.manualRecovery(&tx, fmt.Errorf("新程序验证失败：%v；%w", err, stopErr))
		}
		var once sync.Once
		releaseStopped := func() { once.Do(stopped) }
		defer releaseStopped()
		return e.rollbackFailure(&tx, releaseStopped, err)
	}
	// Health validation completes while the maintenance barrier is still active.
	tx.State = "verified"
	if err = e.saveTransaction(&tx); err != nil {
		return e.manualRecovery(&tx, err)
	}
	return e.completeVerified(&tx)
}

func (e *Engine) releaseVerifiedMaintenance(tx *Transaction) error {
	var durable Transaction
	if err := readJSON(filepath.Join(e.Root, ".updates", "transaction-v2.json"), &durable); err != nil {
		return err
	}
	if durable.Job.ID != tx.Job.ID || (durable.State != "verified" && durable.State != "completed") {
		return errors.New("版本验证尚未持久化，不能解除业务维护")
	}
	if err := os.Remove(filepath.Join(e.Root, ".updates", "maintenance")); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (e *Engine) completeVerified(tx *Transaction) error {
	if err := e.releaseVerifiedMaintenance(tx); err != nil {
		return err
	}
	_ = e.progress(&tx.Job, "cleaning", "新版本已就绪，正在清理旧程序与缓存", 95)
	if err := e.cleanup(tx); err != nil {
		tx.Job.Message = "更新已安装；部分旧文件暂未清理：" + err.Error()
	}
	tx.State = "completed"
	tx.Job.Status, tx.Job.Phase, tx.Job.Progress = "success", "success", 100
	if tx.Job.Message == "" || tx.Job.Message == "新版本已就绪，正在清理旧程序与缓存" {
		tx.Job.Message = "更新完成"
	}
	if err := e.saveTransaction(tx); err != nil {
		return err
	}
	return e.saveJob(&tx.Job)
}

func (e *Engine) manualRecovery(tx *Transaction, err error) error {
	tx.Job.Status, tx.Job.Phase, tx.Job.Error, tx.Job.Message = "manual_recovery", "manual_recovery", err.Error(), "恢复尚未完成，业务入口已暂停；请保留 .updates 并重新运行启动器"
	_ = e.saveTransaction(tx)
	_ = e.saveJob(&tx.Job)
	return err
}
func (e *Engine) recoverLocked(tx *Transaction, unlock func()) error {
	if tx.State == "verified" || tx.State == "completed" {
		if err := e.clearStop(); err != nil {
			return err
		}
		if err := e.releaseVerifiedMaintenance(tx); err != nil {
			return err
		}
		unlock()
		if _, err := e.startLauncher(tx.Job.ID, false); err != nil {
			return err
		}
		return e.completeVerified(tx)
	}
	return e.rollbackFailure(tx, unlock, errors.New("上次更新意外中断，已恢复上一版本"))
}
func (e *Engine) rollbackFailure(tx *Transaction, unlock func(), cause error) error {
	if err := e.restore(tx); err != nil {
		return e.manualRecovery(tx, fmt.Errorf("升级失败：%v；恢复失败：%w", cause, err))
	}
	previousVersion, previousService, err := e.rollbackTarget(tx)
	if err != nil {
		return e.manualRecovery(tx, err)
	}
	tx.Job.Status, tx.Job.Phase, tx.Job.Error, tx.Job.Message = "restarting", "restarting", cause.Error(), "原程序和数据已还原，正在验证原版本启动"
	if err := e.saveTransaction(tx); err != nil {
		return e.manualRecovery(tx, err)
	}
	if err := e.saveJob(&tx.Job); err != nil {
		return e.manualRecovery(tx, err)
	}
	if err := e.clearStop(); err != nil {
		return e.manualRecovery(tx, err)
	}
	unlock()
	pid, err := e.startLauncher(tx.Job.ID, false)
	if err == nil {
		err = e.waitHealthyExecutable(previousVersion, 90*time.Second, pid, previousService)
	}
	if err != nil {
		return e.manualRecovery(tx, fmt.Errorf("数据已还原，但原版本未通过启动验证：%w", err))
	}
	tx.Job.Status, tx.Job.Phase, tx.Job.Error, tx.Job.Message = "failed", "failed", cause.Error(), "更新未完成，已恢复上一版本和原始数据"
	if err := e.saveTransaction(tx); err != nil {
		return e.manualRecovery(tx, err)
	}
	if err := e.saveJob(&tx.Job); err != nil {
		return e.manualRecovery(tx, err)
	}
	if err := os.Remove(filepath.Join(e.Root, ".updates", "maintenance")); err != nil && !os.IsNotExist(err) {
		return e.manualRecovery(tx, err)
	}
	return cause
}

func (e *Engine) rollbackTarget(tx *Transaction) (string, string, error) {
	if _, native := tx.ProgramFiles["app/manifest.json"]; native {
		if err := VerifyInstallation(e.Root); err != nil {
			return "", "", err
		}
		m, err := ReadManifest(e.Root)
		return m.BackendVersion, filepath.Join(e.Root, "app", "SunYuService.exe"), err
	}
	expected := tx.ProgramFiles["installation.json"]
	backup := filepath.Join(tx.Backup, "program", "installation.json")
	actual, err := hashFile(backup)
	if err != nil || expected == "" || actual != expected {
		return "", "", errors.New("原版本安装信息备份校验失败")
	}
	var legacy struct {
		Backend string `json:"backend"`
	}
	if err := readJSON(backup, &legacy); err != nil {
		return "", "", err
	}
	if !versionPattern.MatchString(legacy.Backend) {
		return "", "", errors.New("原版本号无效")
	}
	return legacy.Backend, filepath.Join(e.Root, "runtime", "SunYuRuntime.exe"), nil
}

func (e *Engine) startLauncher(id string, updating bool) (int, error) {
	args := []string{"--no-browser"}
	interactive, desktopErr := interactiveDesktop()
	if desktopErr == nil && !interactive || os.Getenv("SUNYU_HEADLESS") == "1" {
		args = append(args, "--headless")
	}
	if _, err := ReadManifest(e.Root); updating || err == nil {
		args = append(args, "--update-start", id)
	}
	cmd := exec.Command(filepath.Join(e.Root, "SunYu_ERP.exe"), args...)
	cmd.Dir = e.Root
	log, err := openUpdateLog(e.Root)
	if err != nil {
		return 0, err
	}
	defer log.Close()
	cmd.Stdout, cmd.Stderr = log, log
	configureDetached(cmd)
	if err = cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	err = cmd.Process.Release()
	return pid, err
}
func healthAddress(root string) (string, error) {
	raw := struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}{Host: "127.0.0.1", Port: 8765}
	b, err := os.ReadFile(filepath.Join(root, "config.json"))
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if err == nil {
		if err = json.Unmarshal(b, &raw); err != nil {
			return "", err
		}
	}
	if raw.Host == "0.0.0.0" || raw.Host == "" {
		raw.Host = "127.0.0.1"
	}
	if raw.Host == "::" {
		raw.Host = "::1"
	}
	if raw.Port < 1 || raw.Port > 65535 {
		return "", errors.New("服务端口无效")
	}
	return "http://" + net.JoinHostPort(raw.Host, strconv.Itoa(raw.Port)), nil
}
func (e *Engine) waitHealthy(version string, timeout time.Duration) error {
	return e.waitHealthyOwned(version, timeout, 0)
}
func (e *Engine) waitHealthyOwned(version string, timeout time.Duration, launcherPID int) error {
	return e.waitHealthyExecutable(version, timeout, launcherPID, filepath.Join(e.Root, "app", "SunYuService.exe"))
}
func (e *Engine) waitHealthyExecutable(version string, timeout time.Duration, launcherPID int, serviceExecutable string) error {
	address, err := healthAddress(e.Root)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if launcherPID > 0 && !processMatches(filepath.Join(e.Root, "SunYu_ERP.exe"), launcherPID) {
			return errors.New("新程序在版本验证完成前退出，正在恢复原版本")
		}
		resp, err := client.Get(address + "/api/health")
		if err == nil {
			var h struct {
				Status  string `json:"status"`
				Version string `json:"backend_version"`
				PID     int    `json:"pid"`
			}
			err = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&h)
			resp.Body.Close()
			if err == nil && resp.StatusCode == 200 && h.Status == "ok" && h.Version == version && processMatches(serviceExecutable, h.PID) {
				return nil
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("新版本服务未在规定时间内通过版本与进程验证")
}
func (e *Engine) cleanup(tx *Transaction) error {
	current, err := ReadManifest(e.Root)
	if err != nil {
		return err
	}
	obsolete := map[string]string{}
	for p, h := range tx.Old.Files {
		if _, keep := current.Files[p]; !keep {
			obsolete[p] = h
		}
	}
	for p, h := range tx.LegacyFiles {
		if _, keep := current.Files[p]; !keep {
			obsolete[p] = h
		}
	}
	legacyBackups, err := e.legacyBackupFiles(tx.DataDir)
	if err != nil {
		return err
	}
	for p, h := range legacyBackups {
		obsolete[p] = h
	}
	if err = e.queueCleanup(obsolete); err != nil {
		return err
	}
	if err = e.retryCleanup(); err != nil {
		return err
	}
	entries, err := os.ReadDir(filepath.Join(e.Root, ".updates", "rollback"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == tx.Job.ID {
			continue
		}
		p := filepath.Join(e.Root, ".updates", "rollback", entry.Name())
		if strings.HasSuffix(entry.Name(), ".partial") {
			id := strings.TrimSuffix(entry.Name(), ".partial")
			var owner map[string]string
			if regexpJobID(id) && readJSON(filepath.Join(p, "owner.json"), &owner) == nil && owner["application"] == Application && owner["id"] == id {
				if err = os.RemoveAll(p); err != nil {
					return err
				}
			}
			continue
		}
		var old Transaction
		if readJSON(filepath.Join(p, "backup.json"), &old) != nil || old.Job.ID != entry.Name() || old.Backup != p || old.Manifest.Application != Application {
			continue
		}
		if err = os.RemoveAll(p); err != nil {
			return err
		}
	}
	if err = e.cleanupWork(tx.Job.ID, true); err != nil {
		return err
	}
	return nil
}
func regexpJobID(s string) bool {
	if len(s) != 24 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// Pending reports only a durable unfinished transaction; launchers must recover it before starting business services.
func pendingState(root string) (string, bool, error) {
	var tx Transaction
	err := readJSON(filepath.Join(root, ".updates", "transaction-v2.json"), &tx)
	_, maintenance := os.Stat(filepath.Join(root, ".updates", "maintenance"))
	if os.IsNotExist(err) {
		if maintenance == nil {
			return "", true, errors.New("发现维护标记但升级事务缺失，请保留 .updates 恢复材料，不能启动业务服务")
		}
		return "", false, nil
	}
	if err != nil {
		return "", true, fmt.Errorf("升级事务损坏，已阻止半安装程序启动：%w", err)
	}
	if !regexpJobID(tx.Job.ID) {
		return "", true, errors.New("升级事务缺少标识，已阻止业务服务启动")
	}
	switch tx.State {
	case "prepared", "backed_up", "replacing", "starting", "verified", "completed", "restoring", "rolled_back":
	default:
		return "", true, errors.New("升级事务状态无效，已阻止业务服务启动")
	}
	pending := !terminal(tx.Job.Status) || tx.Job.Status == "manual_recovery" || maintenance == nil
	return tx.Job.ID, pending, nil
}
func Pending(root string) (string, bool) { id, pending, _ := pendingState(root); return id, pending }

func AuthorizeUpdateStart(root, id string) bool {
	var tx Transaction
	return regexpJobID(id) && readJSON(filepath.Join(root, ".updates", "transaction-v2.json"), &tx) == nil && tx.Job.ID == id && (tx.State == "starting" || tx.State == "rolled_back" || tx.State == "completed" || tx.State == "verified" || tx.State == "prepared" && tx.Job.Status == "failed") && strings.TrimSpace(id) != ""
}

// PrepareLaunch blocks accidental service starts in an unfinished transaction.
// A recovery helper is copied out of the replaceable installation before this launcher exits.
func PrepareLaunch(root, authorizedID string) (bool, error) {
	e, err := New(root)
	if err != nil {
		return false, err
	}
	if authorizedID != "" {
		if !AuthorizeUpdateStart(e.Root, authorizedID) {
			return false, errors.New("启动请求的升级事务无效")
		}
		return false, VerifyInstallation(e.Root)
	}
	release, err := lifecycle.Acquire(e.Root, "installer.lock")
	if errors.Is(err, lifecycle.ErrBusy) {
		return false, errors.New("程序正在自动更新，请稍后打开原网页查看进度")
	}
	if err != nil {
		return false, err
	}
	defer release()
	if id, pending, err := pendingState(e.Root); err != nil {
		return false, err
	} else if pending {
		source, err := os.Executable()
		if err != nil {
			return false, err
		}
		helper := filepath.Join(e.Root, ".updates", "work", id, "SunYuRecovery.exe")
		if err = copyFile(source, helper); err != nil {
			return false, err
		}
		log, err := openUpdateLog(e.Root)
		if err != nil {
			return false, err
		}
		defer log.Close()
		cmd := exec.Command(helper, "--apply-update", e.Root, id)
		cmd.Dir = e.Root
		cmd.Stdout, cmd.Stderr = log, log
		configureDetached(cmd)
		if err = cmd.Start(); err != nil {
			return false, err
		}
		return true, cmd.Process.Release()
	}
	_ = e.retryCleanup()
	_ = e.cleanupWork("", true)
	return false, VerifyInstallation(e.Root)
}

// ValidateServiceStart prevents direct service execution from bypassing an unfinished install.
func ValidateServiceStart(root, authorizedID string) error {
	_, pending, err := pendingState(root)
	if err != nil {
		return err
	}
	if pending && !AuthorizeUpdateStart(root, authorizedID) {
		return errors.New("程序处于未完成升级事务中，请运行 SunYu_ERP.exe 自动恢复")
	}
	return VerifyInstallation(root)
}
