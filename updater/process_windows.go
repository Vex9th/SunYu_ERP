//go:build windows

package main

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

func processPath(pid int) (string, error) {
	h, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if e != nil {
		return "", e
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, 32768)
	size := uint32(len(buf))
	if e = windows.QueryFullProcessImageName(h, 0, &buf[0], &size); e != nil {
		return "", e
	}
	return windows.UTF16ToString(buf[:size]), nil
}
func matchingProcesses(path string) ([]int, error) {
	snap, e := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if e != nil {
		return nil, e
	}
	defer windows.CloseHandle(snap)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	var found []int
	for e = windows.Process32First(snap, &entry); e == nil; e = windows.Process32Next(snap, &entry) {
		if !strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), filepath.Base(path)) {
			continue
		}
		actual, exited, queryErr := queryLiveImage(int(entry.ProcessID), processPath, confirmedProcessExited)
		if queryErr != nil {
			return nil, fmt.Errorf("无法核对同名进程%d的实际程序路径，未进行替换：%w", entry.ProcessID, queryErr)
		}
		if exited {
			continue
		}
		if samePath(path, actual) {
			found = append(found, int(entry.ProcessID))
		}
	}
	if !errors.Is(e, windows.ERROR_NO_MORE_FILES) {
		return nil, e
	}
	return found, nil
}
func terminateOwned(path string, pid int) error {
	h, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE, false, uint32(pid))
	if e != nil {
		return exitedOrError(pid, e)
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, 32768)
	size := uint32(len(buf))
	if e = windows.QueryFullProcessImageName(h, 0, &buf[0], &size); e != nil {
		return exitedOrError(pid, e)
	}
	if !samePath(path, windows.UTF16ToString(buf[:size])) {
		return errors.New("进程归属已变化，拒绝结束")
	}
	return exitedOrError(pid, windows.TerminateProcess(h, 0))
}
func exitedOrError(pid int, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	gone, probeErr := confirmedProcessExited(pid)
	if probeErr != nil {
		return errors.Join(err, probeErr)
	}
	if gone {
		return nil
	}
	return err
}
func processAlive(pid int) bool {
	h, e := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if e != nil {
		return false
	}
	defer windows.CloseHandle(h)
	state, e := windows.WaitForSingleObject(h, 0)
	return e == nil && state == uint32(windows.WAIT_TIMEOUT)
}
func configureDetached(cmd *exec.Cmd, visible bool) {
	flags := uint32(windows.CREATE_NEW_PROCESS_GROUP)
	if visible {
		flags |= windows.CREATE_NEW_CONSOLE
	} else {
		flags |= windows.CREATE_NO_WINDOW
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags, HideWindow: !visible}
}
func listenerPID(host string, port int) (int, error) {
	proc := windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")
	ip := net.ParseIP(host)
	family := uintptr(windows.AF_INET)
	rowSize, portOffset, pidOffset := 24, 8, 20
	if ip.To4() == nil {
		family = windows.AF_INET6
		rowSize, portOffset, pidOffset = 56, 20, 52
	}
	size := uint32(0)
	proc.Call(0, uintptr(unsafe.Pointer(&size)), 0, family, 3, 0)
	if size < 4 {
		return 0, errors.New("不能读取本机监听进程")
	}
	buf := make([]byte, size)
	code, _, _ := proc.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, family, 3, 0)
	if code != 0 {
		return 0, fmt.Errorf("读取监听进程失败:%d", code)
	}
	count := *(*uint32)(unsafe.Pointer(&buf[0]))
	for i := uint32(0); i < count; i++ {
		off := 4 + int(i)*rowSize
		if off+rowSize > len(buf) {
			break
		}
		p := int(buf[off+portOffset])<<8 | int(buf[off+portOffset+1])
		var address net.IP
		if family == windows.AF_INET {
			address = net.IP(buf[off+4 : off+8])
		} else {
			address = net.IP(buf[off : off+16])
		}
		if p == port && (address.IsUnspecified() || address.Equal(ip)) {
			return int(*(*uint32)(unsafe.Pointer(&buf[off+pidOffset]))), nil
		}
	}
	return 0, errors.New("未找到此地址的监听进程")
}

func openVisibleConsole() {
	if f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout = f
		os.Stderr = f
	}
	if f, err := os.OpenFile("CONIN$", os.O_RDONLY, 0); err == nil {
		os.Stdin = f
	}
}

// Toolhelp snapshots may retain a PID after TerminateProcess. Only a signaled
// process handle or its absence from a fresh snapshot proves it is safe to skip.
func confirmedProcessExited(pid int) (bool, error) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err == nil {
		defer windows.CloseHandle(h)
		state, waitErr := windows.WaitForSingleObject(h, 0)
		return state == windows.WAIT_OBJECT_0, waitErr
	}
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return true, nil
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(snap)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		if entry.ProcessID == uint32(pid) {
			return false, nil
		}
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return false, err
	}
	return true, nil
}
func queryLiveImage(pid int, query func(int) (string, error), exited func(int) (bool, error)) (string, bool, error) {
	var last error
	for attempt := 0; attempt < 6; attempt++ {
		path, err := query(pid)
		if err == nil {
			return path, false, nil
		}
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return "", true, nil
		}
		last = err
		gone, probeErr := exited(pid)
		if probeErr != nil {
			return "", false, errors.Join(err, probeErr)
		}
		if gone {
			return "", true, nil
		}
		if attempt < 5 {
			time.Sleep(20 * time.Millisecond)
		}
	}
	return "", false, last
}
