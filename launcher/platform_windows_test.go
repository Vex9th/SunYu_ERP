//go:build windows

package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"unsafe"
)

func TestWindowsNativeStructuresMatchX64ABI(t *testing.T) {
	if runtime.GOARCH != "amd64" {
		t.Skip("Windows release targets x64")
	}
	for name, value := range map[string]struct{ got, want uintptr }{
		"WNDCLASSEXW":     {unsafe.Sizeof(windowClass{}), 80},
		"NOTIFYICONDATAW": {unsafe.Sizeof(notificationIcon{}), 976},
		"MSG":             {unsafe.Sizeof(windowMessage{}), 48},
	} {
		if value.got != value.want {
			t.Errorf("%s size=%d want=%d", name, value.got, value.want)
		}
	}
}

func TestWindowsHealthPIDMustBelongToExactInstallation(t *testing.T) {
	root := filepath.Join(t.TempDir(), "中文 安装目录")
	directory := filepath.Join(root, "runtime")
	if err := os.MkdirAll(directory, 0755); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(directory, "SunYuRuntime.exe")
	if err := os.WriteFile(target, data, 0755); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(target)
	command.Env = append(os.Environ(), "SUNYU_LAUNCHER_TEST_BLOCK=1")
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { input.Close(); command.Wait() }()
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() || scanner.Text() != "ready" {
		t.Fatal("helper failed to start")
	}
	if !processBelongsToRoot(root, command.Process.Pid) {
		t.Fatal("own runtime rejected")
	}
	if processBelongsToRoot(t.TempDir(), command.Process.Pid) {
		t.Fatal("runtime from other installation accepted")
	}
	if processBelongsToRoot(root, os.Getpid()) {
		t.Fatal("unrelated executable accepted")
	}
	if processBelongsToRoot(root, 0) {
		t.Fatal("invalid PID accepted")
	}
}

func TestWindowsRuntimeLogCanAttachWithoutDeleteSharing(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".updates", "logs")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "runtime.log")
	wide, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.CreateFile(wide, syscall.GENERIC_READ|syscall.GENERIC_WRITE, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.CREATE_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	active := os.NewFile(uintptr(handle), path)
	defer active.Close()
	if err := active.Truncate(8*1024*1024 + 1); err != nil {
		t.Fatal(err)
	}
	backend, err := os.OpenFile(filepath.Join(root, ".updates", "backend.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	owned, err := tryLockFile(backend)
	if err != nil || !owned {
		t.Fatal(err)
	}
	writer, err := openRuntimeLog(root)
	if err != nil {
		t.Fatalf("could not attach to existing runtime log: %v", err)
	}
	if _, err := writer.WriteString("reattached"); err != nil {
		writer.Close()
		t.Fatal(err)
	}
	writer.Close()
	if _, err := os.Stat(path + ".previous"); !os.IsNotExist(err) {
		t.Fatal("busy backend log was rotated")
	}
	if err := unlockFile(backend); err != nil {
		t.Fatal(err)
	}
	if err := active.Close(); err != nil {
		t.Fatal(err)
	}
	writer, err = openRuntimeLog(root)
	if err != nil {
		t.Fatalf("stopped log could not rotate: %v", err)
	}
	writer.Close()
	if _, err := os.Stat(path + ".previous"); err != nil {
		t.Fatalf("stopped oversized log was not rotated: %v", err)
	}
}
