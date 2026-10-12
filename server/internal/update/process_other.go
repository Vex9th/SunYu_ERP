//go:build !windows

package update

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func configureDetached(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
func processMatches(expected string, pid int) bool {
	if pid <= 0 {
		return false
	}
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
	expected, e = filepath.EvalSymlinks(expected)
	return e == nil && expected == actual
}

func interactiveDesktop() (bool, error) { return false, nil }
