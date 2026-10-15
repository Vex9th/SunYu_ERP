//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func processPath(pid int) (string, error) {
	if p, e := os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe"); e == nil {
		return p, nil
	}
	out, e := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	return strings.TrimSpace(string(out)), e
}
func matchingProcesses(path string) ([]int, error) {
	out, e := exec.Command("ps", "-axo", "pid=").Output()
	if e != nil {
		return nil, e
	}
	var pids []int
	for _, v := range strings.Fields(string(out)) {
		pid, _ := strconv.Atoi(v)
		if processMatches(path, pid) {
			pids = append(pids, pid)
		}
	}
	return pids, nil
}
func terminateOwned(path string, pid int) error {
	if !processMatches(path, pid) {
		return errors.New("进程归属已变化")
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}
func processAlive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }
func configureDetached(cmd *exec.Cmd, visible bool) {
	cmd.Env = append(cmd.Environ(), "PYINSTALLER_RESET_ENVIRONMENT=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
func listenerPID(host string, port int) (int, error) {
	out, e := exec.Command("lsof", "-nP", "-t", "-iTCP@"+host+":"+strconv.Itoa(port), "-sTCP:LISTEN").Output()
	if e != nil {
		return 0, e
	}
	v := strings.Fields(string(out))
	if len(v) != 1 {
		return 0, errors.New("监听进程不唯一")
	}
	return strconv.Atoi(v[0])
}

func openVisibleConsole() {}
