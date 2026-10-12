//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func tryLockFile(file *os.File) (bool, error) {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return false, nil
	}
	return err == nil, err
}
func unlockFile(file *os.File) error          { return syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }
func configureChildProcess(command *exec.Cmd) {}
func processBelongsToRoot(root string, pid int) bool {
	actual, e := os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
	if e != nil {
		b, e := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
		if e != nil {
			return false
		}
		actual = strings.TrimSpace(string(b))
	}
	actual, e = filepath.EvalSymlinks(actual)
	if e != nil {
		return false
	}
	expected, e := filepath.EvalSymlinks(filepath.Join(root, "app", "SunYuService.exe"))
	return e == nil && actual == expected
}
func openBrowser(string) error    { return errors.New("桌面托盘仅支持 Windows") }
func showError(message string)    { _, _ = os.Stderr.WriteString(message + "\n") }
func runTray(*desktopService) int { return 1 }

func interactiveDesktop() (bool, error) { return false, nil }
