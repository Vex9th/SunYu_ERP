//go:build windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

func pauseStandaloneConsole() {
	var pid uint32
	count, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetConsoleProcessList").Call(uintptr(unsafe.Pointer(&pid)), 1)
	if count != 1 {
		return
	}
	if info, err := os.Stdin.Stat(); err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return
	}
	fmt.Println("\n按 Enter 关闭此窗口。")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}
