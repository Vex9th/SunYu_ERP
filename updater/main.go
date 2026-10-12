package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sunyu.local/updater/internal/lifecycle"
	"time"
)

var version = "1.2.5"

type workerRequest struct {
	JobID     string `json:"job_id"`
	Token     string `json:"token"`
	Hash      string `json:"sha256"`
	ParentPID int    `json:"parent_pid"`
	Visible   bool   `json:"visible"`
}
type handshake struct {
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func main() { os.Exit(mainCode()) }
func mainCode() int {
	flags := flag.NewFlagSet("update.exe", flag.ContinueOnError)
	root := flags.String("root", "", "安装目录")
	check := flags.Bool("check", false, "检查更新")
	apply := flags.Bool("apply", false, "一键更新")
	noPause := flags.Bool("no-pause", false, "后台执行")
	job := flags.String("job-id", "", "任务UUID")
	worker := flags.String("worker", "", "内部工作进程凭据")
	addTestFlags(flags)
	if err := flags.Parse(os.Args[1:]); err != nil {
		return 1
	}
	if flags.NArg() != 0 || *check && *apply {
		fmt.Fprintln(os.Stderr, "参数不正确")
		return 1
	}
	self, err := os.Executable()
	if err != nil {
		return 1
	}
	if *root == "" {
		*root = filepath.Dir(self)
	}
	if *job == "" {
		*job = randomID()
	}
	e, err := newEngine(*root, *job)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err = configureTestSource(e); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if *worker != "" {
		if !*noPause {
			openVisibleConsole()
		}
		err = runWorker(e, *worker)
		if !*noPause {
			fmt.Println("按回车关闭更新窗口。")
			bufio.NewReader(os.Stdin).ReadString('\n')
		}
	} else if *check {
		release, lockErr := lifecycle.Acquire(e.root, "updater.lock")
		if lockErr != nil {
			err = lockErr
		} else {
			if activeDispatch(e.root) {
				err = lifecycle.ErrBusy
			} else {
				err = e.run(false)
			}
			release()
		}
	} else {
		err = bootstrap(e, self, !*noPause, testArguments())
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if errors.Is(err, lifecycle.ErrBusy) {
			return 2
		}
		return 1
	}
	return 0
}
func bootstrap(e *Engine, source string, visible bool, extra []string) (result error) {
	e.apply = true
	release, err := lifecycle.Acquire(e.root, "updater.lock")
	if err != nil {
		return err
	}
	if activeDispatch(e.root) {
		release()
		return lifecycle.ErrBusy
	}
	held := true
	defer func() {
		if held {
			release()
		}
		if result != nil {
			e.status.Error = result.Error()
			_ = e.progress("failed", result.Error(), 0)
		}
	}()
	// A completed task with the same id is idempotent. Python may have written a
	// checking reservation before launching this process; that is not completion.
	var old Status
	if readJSON(filepath.Join(e.root, ".updates/status.json"), &old) == nil && old.JobID == e.status.JobID && !old.Busy && (old.Phase == "success" || old.Phase == "failed") {
		return nil
	}
	if err = e.progress("checking", "正在启动独立更新工具", 0); err != nil {
		return err
	}
	if err = os.MkdirAll(e.work, 0700); err != nil {
		return err
	}
	if err = noLinks(e.work); err != nil {
		return err
	}
	if err = writeJSON(filepath.Join(e.work, "owner.json"), map[string]string{"job_id": e.status.JobID, "application": "SunYu_ERP"}); err != nil {
		return err
	}
	target := filepath.Join(e.work, "update.exe")
	if err = copyFile(source, target); err != nil {
		return err
	}
	hash, err := hashFile(target)
	if err != nil {
		return err
	}
	req := workerRequest{e.status.JobID, randomID(), hash, os.Getpid(), visible}
	if err = writeJSON(filepath.Join(e.work, "request.json"), req); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(e.work, "ready.json"))
	_ = os.Remove(filepath.Join(e.work, "ack.json"))
	args := []string{"--root", e.root, "--job-id", e.status.JobID, "--worker", req.Token}
	if !visible {
		args = append(args, "--no-pause")
	}
	args = append(args, extra...)
	cmd := exec.Command(target, args...)
	cmd.Dir = e.root
	configureDetached(cmd, visible)
	if !visible {
		if err = os.MkdirAll(filepath.Join(e.root, ".updates/logs"), 0700); err != nil {
			return err
		}
		log, err := os.OpenFile(filepath.Join(e.root, ".updates/logs/updater.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		defer log.Close()
		cmd.Stdout = log
		cmd.Stderr = log
	}
	if err = cmd.Start(); err != nil {
		return fmt.Errorf("独立更新进程启动失败：%w", err)
	}
	if err = writeJSON(filepath.Join(e.root, ".updates/dispatch.json"), dispatch{e.status.JobID, cmd.Process.Pid}); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	wait := func(name string) error {
		deadline := time.Now().Add(12 * time.Second)
		for time.Now().Before(deadline) {
			var ack handshake
			if readJSON(filepath.Join(e.work, name), &ack) == nil && ack.Token == req.Token && ack.PID == cmd.Process.Pid {
				return nil
			}
			select {
			case err := <-done:
				return fmt.Errorf("更新工作进程在接管前退出：%v", err)
			default:
			}
			time.Sleep(20 * time.Millisecond)
		}
		return errors.New("更新工具接管超时")
	}
	if err = wait("ready.json"); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	release()
	held = false
	if err = wait("ack.json"); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	// Do not pause or print after this point: the worker waits for this root image
	// to exit before any download/replacement, including its own updater binary.
	return nil
}
func runWorker(e *Engine, token string) (result error) {
	e.apply = true
	var req workerRequest
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if readJSON(filepath.Join(e.work, "request.json"), &req) != nil || req.JobID != e.status.JobID || req.Token != token || req.ParentPID < 1 || !samePath(self, filepath.Join(e.work, "update.exe")) {
		return errors.New("拒绝未经交接的更新工作进程")
	}
	hash, err := hashFile(self)
	if err != nil || hash != req.Hash {
		return errors.New("工作副本校验失败")
	}
	if err = writeJSON(filepath.Join(e.work, "ready.json"), handshake{token, os.Getpid()}); err != nil {
		return err
	}
	var release func()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		release, err = lifecycle.Acquire(e.root, "updater.lock")
		if err == nil {
			break
		}
		if !errors.Is(err, lifecycle.ErrBusy) {
			return err
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	defer release()
	defer clearDispatch(e.root, e.status.JobID, os.Getpid())
	var dispatched dispatch
	if readJSON(filepath.Join(e.root, ".updates/dispatch.json"), &dispatched) != nil || dispatched.JobID != e.status.JobID || dispatched.PID != os.Getpid() {
		return errors.New("更新派发记录已改变，拒绝重复执行")
	}
	defer func() {
		if result != nil {
			e.status.Error = result.Error()
			_ = e.progress("failed", result.Error(), e.status.Progress)
		}
	}()
	if err = e.progress("checking", "独立更新工具已接管任务", 0); err != nil {
		return err
	}
	if err = writeJSON(filepath.Join(e.work, "ack.json"), handshake{token, os.Getpid()}); err != nil {
		return err
	}
	deadline = time.Now().Add(30 * time.Second)
	for processAlive(req.ParentPID) {
		if time.Now().After(deadline) {
			return errors.New("入口更新程序尚未退出，未替换任何文件")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return e.run(true)
}

type dispatch struct {
	JobID string `json:"job_id"`
	PID   int    `json:"pid"`
}

func activeDispatch(root string) bool {
	var d dispatch
	if readJSON(filepath.Join(root, ".updates/dispatch.json"), &d) != nil || !jobPattern.MatchString(d.JobID) {
		return false
	}
	return processMatches(filepath.Join(root, ".updates/work", d.JobID, "update.exe"), d.PID)
}
func clearDispatch(root, id string, pid int) {
	var d dispatch
	p := filepath.Join(root, ".updates/dispatch.json")
	if readJSON(p, &d) == nil && d.JobID == id && d.PID == pid {
		_ = os.Remove(p)
	}
}
