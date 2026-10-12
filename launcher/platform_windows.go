//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var (
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	user32            = syscall.NewLazyDLL("user32.dll")
	shell32           = syscall.NewLazyDLL("shell32.dll")
	lockFileEx        = kernel32.NewProc("LockFileEx")
	unlockFileEx      = kernel32.NewProc("UnlockFileEx")
	queryProcessImage = kernel32.NewProc("QueryFullProcessImageNameW")
	shellExecute      = shell32.NewProc("ShellExecuteW")
	messageBox        = user32.NewProc("MessageBoxW")
)

func tryLockFile(file *os.File) (bool, error) {
	var overlapped syscall.Overlapped
	result, _, err := lockFileEx.Call(file.Fd(), 3, 0, 1, 0, uintptr(unsafe.Pointer(&overlapped)))
	if result != 0 {
		return true, nil
	}
	if errors.Is(err, syscall.Errno(33)) {
		return false, nil
	}
	return false, err
}
func unlockFile(file *os.File) error {
	var overlapped syscall.Overlapped
	result, _, err := unlockFileEx.Call(file.Fd(), 0, 1, 0, uintptr(unsafe.Pointer(&overlapped)))
	if result == 0 {
		return err
	}
	return nil
}
func configureChildProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
func processBelongsToRoot(root string, pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := syscall.OpenProcess(0x1000, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(process)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	result, _, _ := queryProcessImage.Call(uintptr(process), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)))
	if result == 0 {
		return false
	}
	actual := syscall.UTF16ToString(buffer[:size])
	expected := filepath.Join(root, "runtime", "SunYuRuntime.exe")
	if resolved, err := filepath.EvalSymlinks(expected); err == nil {
		expected = resolved
	}
	if resolved, err := filepath.EvalSymlinks(actual); err == nil {
		actual = resolved
	}
	return strings.EqualFold(strings.TrimPrefix(actual, `\\?\`), strings.TrimPrefix(expected, `\\?\`))
}
func openBrowser(target string) error {
	operation, _ := syscall.UTF16PtrFromString("open")
	value, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	result, _, _ := shellExecute.Call(0, uintptr(unsafe.Pointer(operation)), uintptr(unsafe.Pointer(value)), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("Windows 打开失败，错误码 %d", result)
	}
	return nil
}
func showError(message string) {
	title, _ := syscall.UTF16PtrFromString("SunYu ERP")
	content, _ := syscall.UTF16PtrFromString(strings.ReplaceAll(message, "\x00", ""))
	messageBox.Call(0, uintptr(unsafe.Pointer(content)), uintptr(unsafe.Pointer(title)), 0x10|0x10000)
}
