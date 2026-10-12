//go:build windows

package update

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

func configureDetached(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
func processMatches(expected string, pid int) bool {
	if pid <= 0 {
		return false
	}
	h, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if e != nil {
		return false
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, 32768)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) != nil {
		return false
	}
	actual := windows.UTF16ToString(buf[:n])
	if p, e := filepath.EvalSymlinks(expected); e == nil {
		expected = p
	}
	if p, e := filepath.EvalSymlinks(actual); e == nil {
		actual = p
	}
	return strings.EqualFold(strings.TrimPrefix(actual, `\\?\`), strings.TrimPrefix(expected, `\\?\`))
}

func interactiveDesktop() (bool, error) {
	user32 := windows.NewLazySystemDLL("user32.dll")
	station, _, err := user32.NewProc("GetProcessWindowStation").Call()
	if station == 0 {
		return false, fmt.Errorf("GetProcessWindowStation: %w", err)
	}
	var flags struct{ Inherit, Reserved, Flags uint32 }
	var needed uint32
	ok, _, err := user32.NewProc("GetUserObjectInformationW").Call(station, 1, uintptr(unsafe.Pointer(&flags)), unsafe.Sizeof(flags), uintptr(unsafe.Pointer(&needed)))
	if ok == 0 {
		return false, fmt.Errorf("GetUserObjectInformationW: %w", err)
	}
	return flags.Flags&1 != 0, nil
}
