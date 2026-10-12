package update

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sunyu.local/erp/internal/lifecycle"
	"time"
)

var errHandedOff = errors.New("update handed to independent process")

type workerReady struct {
	ID          string `json:"id"`
	PID         int    `json:"pid"`
	UpdaterHash string `json:"updater_hash"`
}

type workerProcess struct {
	cmd  *exec.Cmd
	done <-chan error
}

type workerRequest struct {
	ParentPID   int    `json:"parent_pid,omitempty"`
	Job         Job    `json:"job"`
	Mode        string `json:"mode"`
	UpdaterHash string `json:"updater_hash"`
}

// Controller is the service-facing API. Only checks run in this process;
// installation belongs to a copied update.exe and survives Controller.Close.
type Controller struct {
	*Engine
	Visible bool
}

func NewController(root string) (*Controller, error) {
	e, err := New(root)
	if err != nil {
		return nil, err
	}
	return &Controller{Engine: e}, nil
}
func (c *Controller) Install(id string) error      { return c.dispatch("install", "", id) }
func (c *Controller) Import(path, id string) error { return c.dispatch("import", path, id) }
func (c *Controller) dispatch(mode, path, id string) error {
	return c.startPrepared(id, "checking", func(j *Job) error {
		dir, err := c.ensureWork(j.ID)
		if err != nil {
			return err
		}
		if mode == "import" {
			if _, err = c.prepareImport(path, j); err != nil {
				return err
			}
		}
		hash, err := c.copyUpdater(dir)
		if err != nil {
			return err
		}
		request := workerRequest{Job: *j, Mode: mode, UpdaterHash: hash}
		own, _ := os.Executable()
		a, ae := os.Stat(own)
		b, be := os.Stat(filepath.Join(c.Root, "update.exe"))
		if ae == nil && be == nil && os.SameFile(a, b) {
			request.ParentPID = os.Getpid()
		}
		return writeJSON(filepath.Join(dir, "request.json"), request)
	}, func(j *Job) error {
		cmd, err := c.startWorker(j.ID, false, c.Visible)
		if err != nil {
			return err
		}
		j.OwnerPID, j.OwnerExe = cmd.cmd.Process.Pid, cmd.cmd.Path
		if err = c.saveJob(j); err != nil {
			_ = cmd.cmd.Process.Kill()
			<-cmd.done
			return err
		}
		// Wait only in an untracked observer: service shutdown must never join or kill
		// the child that is waiting for the service locks to become available.
		go func() {
			err := <-cmd.done
			if err != nil {
				c.observeExit(*j, err)
			}
		}()
		return errHandedOff
	})
}
func (e *Engine) copyUpdater(dir string) (string, error) {
	source, err := safePath(e.Root, "update.exe")
	if err != nil {
		return "", err
	}
	h, err := hashFile(source)
	if err != nil {
		return "", fmt.Errorf("独立更新程序 update.exe 缺失或不可读：%w", err)
	}
	if m, me := ReadManifest(e.Root); me == nil {
		if m.Files["update.exe"] != h {
			return "", errors.New("update.exe 与安装清单不一致，请重新下载官方完整包")
		}
	} else if !os.IsNotExist(me) {
		return "", me
	} else {
		own, oe := os.Executable()
		if oe != nil {
			return "", oe
		}
		a, ae := os.Stat(own)
		b, be := os.Stat(source)
		if ae != nil || be != nil || !os.SameFile(a, b) {
			return "", errors.New("旧版迁移必须直接运行安装目录里的官方 update.exe")
		}
	}
	target := filepath.Join(dir, "update.exe")
	if err = copyFile(source, target); err != nil {
		return "", err
	}
	copied, err := hashFile(target)
	if err != nil || copied != h {
		return "", errors.New("独立更新程序副本校验失败")
	}
	return h, nil
}
func (e *Engine) startWorker(id string, recover, visible bool) (*workerProcess, error) {
	if !regexpJobID(id) {
		return nil, errors.New("更新工作标识无效")
	}
	dir := filepath.Join(e.Root, ".updates", "work", id)
	var request workerRequest
	if err := readJSON(filepath.Join(dir, "request.json"), &request); err != nil {
		return nil, err
	}
	if recover {
		request.ParentPID = 0
		own, _ := os.Executable()
		a, ae := os.Stat(own)
		b, be := os.Stat(filepath.Join(e.Root, "update.exe"))
		if ae == nil && be == nil && os.SameFile(a, b) {
			request.ParentPID = os.Getpid()
		}
		if err := writeJSON(filepath.Join(dir, "request.json"), request); err != nil {
			return nil, err
		}
	}
	exe, err := safePath(e.Root, ".updates/work/"+id+"/update.exe")
	if err != nil {
		return nil, err
	}
	h, err := hashFile(exe)
	if err != nil || h != request.UpdaterHash || request.Job.ID != id {
		return nil, errors.New("更新进程副本或任务归属校验失败")
	}
	mode := "--worker"
	if recover {
		mode = "--recover"
	}
	args := []string{mode, "--root", e.Root, "--job", id}
	if !visible {
		args = append(args, "--no-pause")
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = e.Root
	if visible {
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	} else {
		log, err := openUpdateLog(e.Root)
		if err != nil {
			return nil, err
		}
		defer log.Close()
		cmd.Stdout, cmd.Stderr = log, log
		configureDetached(cmd)
	}
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		var ready workerReady
		if readJSON(filepath.Join(dir, "ready.json"), &ready) == nil && ready.ID == id && ready.PID == cmd.Process.Pid && ready.UpdaterHash == request.UpdaterHash {
			return &workerProcess{cmd: cmd, done: done}, nil
		}
		select {
		case exitErr := <-done:
			return nil, fmt.Errorf("独立更新程序在接管任务前退出：%v", exitErr)
		case <-time.After(10 * time.Millisecond):
		}
	}
	_ = cmd.Process.Kill()
	<-done
	return nil, errors.New("独立更新程序未能在规定时间内确认任务")
}
func (e *Engine) observeExit(initial Job, cause error) {
	j, err := e.Request(initial.RequestID)
	if err == nil && (terminal(j.Status) || j.OwnerPID != 0 && j.OwnerPID != initial.OwnerPID) {
		return
	}
	if j == nil {
		j = &initial
	}
	j.Status, j.Phase, j.Error, j.Message = "failed", "failed", cause.Error(), "独立更新程序已退出；请查看 .updates/logs/update.log 后重试"
	j.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	// Never overwrite a newer task's global job: an old exit notification can
	// arrive after another independent controller has started the next request.
	if err = writeJSON(e.requestPath(j.RequestID), j); err != nil {
		j.PersistenceError = err.Error()
		j.Error += "；更新状态保存失败：" + err.Error()
		e.stateMu.Lock()
		if e.stateFailures == nil {
			e.stateFailures = map[string]Job{}
		}
		e.stateFailures[j.RequestID] = *j
		e.stateMu.Unlock()
		if f, logErr := openUpdateLog(e.Root); logErr == nil {
			_, _ = fmt.Fprintln(f, j.Error)
			_ = f.Close()
		}
	}
}

// RunWorker executes the complete download/install operation in the independent
// executable. An exiting service cannot cancel its context or release its lock.
func RunWorker(root, id string, recover bool) (result error) {
	var activeJob *Job
	e, err := newEngine(root, false)
	if err != nil {
		return err
	}
	defer e.Close()
	defer func() {
		if result == nil || activeJob == nil {
			return
		}
		if current, err := e.Request(activeJob.RequestID); err == nil && terminal(current.Status) {
			return
		}
		activeJob.Status, activeJob.Phase, activeJob.Error, activeJob.Message = "failed", "failed", result.Error(), "独立更新程序未完成，请查看更新日志后重试"
		if _, pending := Pending(e.Root); pending {
			activeJob.Status, activeJob.Phase = "manual_recovery", "manual_recovery"
		}
		_ = e.saveJob(activeJob)
	}()
	if !regexpJobID(id) {
		return errors.New("更新工作标识无效")
	}
	dir := filepath.Join(e.Root, ".updates", "work", id)
	var req workerRequest
	if err = readJSON(filepath.Join(dir, "request.json"), &req); err != nil {
		return err
	}
	own, err := os.Executable()
	if err != nil {
		return err
	}
	expected := filepath.Join(dir, "update.exe")
	actualInfo, err := os.Stat(own)
	if err != nil {
		return err
	}
	expectedInfo, err := os.Stat(expected)
	if err != nil || !os.SameFile(actualInfo, expectedInfo) {
		return errors.New("安装必须在受管 update.exe 副本中执行")
	}
	h, err := hashFile(own)
	if err != nil || h != req.UpdaterHash || req.Job.ID != id {
		return errors.New("更新任务与进程校验不匹配")
	}
	j, err := e.Request(req.Job.RequestID)
	if err != nil {
		return err
	}
	activeJob = j
	if j.ID != id {
		return errors.New("更新请求归属无效")
	}
	if terminal(j.Status) && !recover {
		return nil
	}
	if err = writeJSON(filepath.Join(dir, "ready.json"), workerReady{ID: id, PID: os.Getpid(), UpdaterHash: h}); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	release, err := waitLock(ctx, e.Root, "installer.lock")
	if err != nil {
		return err
	}
	defer release()
	j.OwnerPID, j.OwnerExe = os.Getpid(), expected
	j.WorkerStartedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if recover {
		j.Status, j.Phase, j.Message = "restarting", "restarting", "独立更新程序已接管恢复任务"
	}
	if err = e.saveJob(j); err != nil {
		return err
	}
	if recover {
		var active Transaction
		if err = readJSON(filepath.Join(e.Root, ".updates/transaction-v2.json"), &active); err != nil {
			return err
		}
		if active.Job.ID != id {
			return errors.New("恢复事务归属无效")
		}
		active.Job.OwnerPID, active.Job.OwnerExe, active.Job.WorkerStartedAt = j.OwnerPID, j.OwnerExe, j.WorkerStartedAt
		if err = e.saveTransaction(&active); err != nil {
			return err
		}
		if err = e.waitRootUpdater(id); err == nil {
			err = e.runHelperLocked(id)
		}
	} else if req.Mode == "install" {
		err = e.installJob(j)
	} else if req.Mode == "import" {
		err = e.importJob(j, filepath.Join(dir, "download.zip"))
	} else {
		return errors.New("更新任务类型无效")
	}
	// The transaction is authoritative after backup; never reclassify a verified
	// installation as an instruction to restore customer data.
	var tx Transaction
	if readJSON(filepath.Join(e.Root, ".updates", "transaction-v2.json"), &tx) == nil && tx.Job.ID == id && terminal(tx.Job.Status) {
		*j = tx.Job
	}
	if !terminal(j.Status) {
		if err != nil {
			j.Status, j.Phase, j.Error, j.Message = "failed", "failed", err.Error(), "更新失败，原有业务数据已保留"
		} else {
			j.Status, j.Phase, j.Progress = "success", "success", 100
			j.Message = "更新完成"
		}
	}
	saveErr := e.saveJob(j)
	if err == nil && saveErr == nil {
		fmt.Println(j.Message)
	}
	return errors.Join(err, saveErr)
}

func LaunchRecovery(root, id string) error    { return launchRecovery(root, id, false) }
func (c *Controller) Recover(id string) error { return launchRecovery(c.Root, id, c.Visible) }
func launchRecovery(root, id string, visible bool) error {
	e, err := newEngine(root, false)
	if err != nil {
		return err
	}
	defer e.Close()
	release, err := lifecycle.Acquire(e.Root, "installer.lock")
	if errors.Is(err, lifecycle.ErrBusy) {
		return ErrBusy
	}
	if err != nil {
		return err
	}
	cmd, err := e.startWorker(id, true, visible)
	release()
	if err != nil {
		return err
	}
	go func() { _ = <-cmd.done }()
	var request workerRequest
	if err = readJSON(filepath.Join(e.Root, ".updates/work", id, "request.json"), &request); err != nil {
		return err
	}
	return e.waitWorkerStarted(request.Job.RequestID, cmd.cmd.Process.Pid)
}

// WaitHandoff lets the root update.exe exit only after its work copy is started.
func (c *Controller) WaitHandoff(id string) error {
	c.workers.Wait()
	j, err := c.Request(id)
	if err != nil {
		return err
	}
	return c.waitWorkerStarted(id, j.OwnerPID)
}
func (e *Engine) waitWorkerStarted(id string, pid int) error {
	if pid <= 0 {
		return errors.New("独立更新程序未成功启动")
	}
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		j, err := e.Request(id)
		if err != nil {
			return err
		}
		if j.OwnerPID == pid {
			if j.Status == "failed" || j.Status == "manual_recovery" {
				return fmt.Errorf("更新进程未能接管任务：%s %s", j.Message, j.Error)
			}
			if j.WorkerStartedAt != "" {
				return nil
			}
		}
		if !regexpJobID(j.ID) || !processMatches(filepath.Join(e.Root, ".updates/work", j.ID, "update.exe"), pid) {
			return errors.New("独立更新程序在接管任务前退出")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("独立更新程序尚未确认取得安装锁，请查看更新日志")
}

func (e *Engine) waitRootUpdater(id string) error {
	var request workerRequest
	if err := readJSON(filepath.Join(e.Root, ".updates/work", id, "request.json"), &request); err != nil {
		return err
	}
	if request.ParentPID <= 0 {
		return nil
	}
	for deadline := time.Now().Add(30 * time.Second); processMatches(filepath.Join(e.Root, "update.exe"), request.ParentPID); {
		if time.Now().After(deadline) {
			return errors.New("根目录 update.exe 尚未退出，已停止安装，请关闭该窗口后重试")
		}
		time.Sleep(25 * time.Millisecond)
	}
	return nil
}
