//go:build windows

package main

import (
	"fmt"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	wmTray    = 0x8001
	wmService = 0x8002
	menuOpen  = 1001
	menuLogs  = 1002
	menuQuit  = 1003
)

var (
	registerClass         = user32.NewProc("RegisterClassExW")
	createWindow          = user32.NewProc("CreateWindowExW")
	defaultWindowProc     = user32.NewProc("DefWindowProcW")
	destroyWindow         = user32.NewProc("DestroyWindow")
	getMessage            = user32.NewProc("GetMessageW")
	translateMessage      = user32.NewProc("TranslateMessage")
	dispatchMessage       = user32.NewProc("DispatchMessageW")
	postMessage           = user32.NewProc("PostMessageW")
	postQuit              = user32.NewProc("PostQuitMessage")
	shellNotifyIcon       = shell32.NewProc("Shell_NotifyIconW")
	createIcon            = user32.NewProc("CreateIcon")
	destroyIcon           = user32.NewProc("DestroyIcon")
	createMenu            = user32.NewProc("CreatePopupMenu")
	appendMenu            = user32.NewProc("AppendMenuW")
	destroyMenu           = user32.NewProc("DestroyMenu")
	trackPopupMenu        = user32.NewProc("TrackPopupMenu")
	getCursorPos          = user32.NewProc("GetCursorPos")
	setForegroundWindow   = user32.NewProc("SetForegroundWindow")
	registerWindowMessage = user32.NewProc("RegisterWindowMessageW")
	getModuleHandle       = kernel32.NewProc("GetModuleHandleW")
	activeTray            *windowsTray
	trayWindowCallback    = syscall.NewCallback(trayWindowProc)
)

type point struct{ X, Y int32 }
type windowMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          point
	Private        uint32
}
type windowClass struct {
	Size, Style                        uint32
	Procedure                          uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	MenuName, ClassName                *uint16
	SmallIcon                          uintptr
}
type notificationIcon struct {
	Size                uint32
	Window              uintptr
	ID, Flags, Callback uint32
	Icon                uintptr
	Tip                 [128]uint16
	State, StateMask    uint32
	Info                [256]uint16
	Version             uint32
	InfoTitle           [64]uint16
	InfoFlags           uint32
	GUID                [16]byte
	BalloonIcon         uintptr
}
type windowsTray struct {
	service        *desktopService
	window, icon   uintptr
	notification   notificationIcon
	taskbarCreated uint32
	pendingMu      sync.Mutex
	pending        []trayEvent
	status         string
	stopping       bool
	finished       bool
	exitCode       int
}

func runTray(service *desktopService) int {
	// 隐藏窗口与消息循环必须始终位于同一 Windows 线程。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tray := &windowsTray{service: service, status: "服务正在启动"}
	activeTray = tray
	defer func() { activeTray = nil }()
	instance, _, _ := getModuleHandle.Call(0)
	name, _ := syscall.UTF16PtrFromString("SunYuERPTrayWindow")
	class := windowClass{Procedure: trayWindowCallback, Instance: instance, ClassName: name}
	class.Size = uint32(unsafe.Sizeof(class))
	atom, _, err := registerClass.Call(uintptr(unsafe.Pointer(&class)))
	if atom == 0 {
		tray.reportError(fmt.Sprintf("托盘窗口初始化失败：%v", err))
		return 1
	}
	window, _, err := createWindow.Call(0, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(name)), 0, 0, 0, 0, 0, 0, 0, instance, 0)
	if window == 0 {
		tray.reportError(fmt.Sprintf("托盘窗口创建失败：%v", err))
		return 1
	}
	tray.window = window
	tray.icon = makeTrayIcon(instance)
	if tray.icon == 0 {
		destroyWindow.Call(window)
		tray.reportError("托盘图标创建失败")
		return 1
	}
	defer destroyIcon.Call(tray.icon)
	tray.notification = notificationIcon{Window: window, ID: 1, Flags: 1 | 2 | 4 | 0x80, Callback: wmTray, Icon: tray.icon}
	tray.notification.Size = uint32(unsafe.Sizeof(tray.notification))
	taskbarName, _ := syscall.UTF16PtrFromString("TaskbarCreated")
	taskbar, _, _ := registerWindowMessage.Call(uintptr(unsafe.Pointer(taskbarName)))
	tray.taskbarCreated = uint32(taskbar)
	if !tray.addIcon() {
		destroyWindow.Call(window)
		tray.reportError("无法添加系统托盘图标，请确认 Windows 桌面已启动后重试。")
		return 1
	}
	defer shellNotifyIcon.Call(2, uintptr(unsafe.Pointer(&tray.notification)))
	go func() {
		for event := range service.events {
			tray.pendingMu.Lock()
			tray.pending = append(tray.pending, event)
			tray.pendingMu.Unlock()
			postMessage.Call(window, wmService, 0, 0)
			if event.done {
				return
			}
		}
	}()
	go service.run()
	var message windowMessage
	for {
		result, _, err := getMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) == -1 {
			service.requestQuit()
			tray.reportError(fmt.Sprintf("托盘消息循环失败，已请求安全退出：%v", err))
			// 不强杀后台；消息循环失败后仍保持启动锁，直到业务服务正常退出。
			for !tray.finished {
				time.Sleep(100 * time.Millisecond)
				tray.consumeEvents()
			}
			return 1
		}
		if result == 0 {
			return tray.exitCode
		}
		translateMessage.Call(uintptr(unsafe.Pointer(&message)))
		dispatchMessage.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func makeTrayIcon(instance uintptr) uintptr {
	mask := make([]byte, 32*4)
	pixels := make([]byte, 32*32*4)
	// 清晰的蓝底白色 SY 图形，不依赖外置资源或额外图形库。
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			index := (y*32 + x) * 4
			pixels[index], pixels[index+1], pixels[index+2], pixels[index+3] = 0xBA, 0x57, 0x24, 0xFF
			s := x >= 5 && x <= 14 && ((y >= 7 && y <= 10) || (y >= 14 && y <= 17) || (y >= 21 && y <= 24)) || x >= 5 && x <= 8 && y >= 10 && y <= 14 || x >= 11 && x <= 14 && y >= 17 && y <= 21
			letterY := (y >= 7 && y <= 15 && (x >= 18 && x <= 21 || x >= 25 && x <= 28)) || (y >= 14 && y <= 24 && x >= 21 && x <= 25)
			if s || letterY {
				pixels[index], pixels[index+1], pixels[index+2] = 255, 255, 255
			}
		}
	}
	result, _, _ := createIcon.Call(instance, 32, 32, 1, 32, uintptr(unsafe.Pointer(&mask[0])), uintptr(unsafe.Pointer(&pixels[0])))
	return result
}
func (tray *windowsTray) setTip() {
	tray.notification.Tip = [128]uint16{}
	value, _ := syscall.UTF16FromString("SunYu ERP · " + tray.status)
	copy(tray.notification.Tip[:127], value)
}
func (tray *windowsTray) addIcon() bool {
	tray.setTip()
	tray.notification.Flags = 1 | 2 | 4 | 0x80
	result, _, _ := shellNotifyIcon.Call(0, uintptr(unsafe.Pointer(&tray.notification)))
	if result != 0 {
		tray.notification.Version = 4
		shellNotifyIcon.Call(4, uintptr(unsafe.Pointer(&tray.notification)))
	}
	return result != 0
}
func (tray *windowsTray) consumeEvents() {
	tray.pendingMu.Lock()
	pending := tray.pending
	tray.pending = nil
	tray.pendingMu.Unlock()
	for _, event := range pending {
		if event.status != "" {
			tray.status = event.status
			tray.stopping = event.stopping
			tray.setTip()
			tray.notification.Flags = 4
			shellNotifyIcon.Call(1, uintptr(unsafe.Pointer(&tray.notification)))
		}
		if event.err != nil {
			tray.reportError(event.err.Error())
		}
		if event.done {
			tray.finished = true
			tray.exitCode = event.code
			destroyWindow.Call(tray.window)
			return
		}
	}
}
func (tray *windowsTray) popupMenu() {
	menu, _, _ := createMenu.Call()
	if menu == 0 {
		return
	}
	defer destroyMenu.Call(menu)
	add := func(flags, id uintptr, label string) {
		text, _ := syscall.UTF16PtrFromString(label)
		appendMenu.Call(menu, flags, id, uintptr(unsafe.Pointer(text)))
	}
	add(1, 0, tray.status)
	add(0x800, 0, "")
	openFlags := uintptr(0)
	if tray.stopping {
		openFlags = 1
	}
	add(openFlags, menuOpen, "打开 SunYu ERP")
	add(0, menuLogs, "查看运行日志")
	add(0x800, 0, "")
	add(openFlags, menuQuit, "退出服务")
	var cursor point
	getCursorPos.Call(uintptr(unsafe.Pointer(&cursor)))
	setForegroundWindow.Call(tray.window)
	selected, _, _ := trackPopupMenu.Call(menu, 0x100|2, uintptr(cursor.X), uintptr(cursor.Y), 0, tray.window, 0)
	postMessage.Call(tray.window, 0, 0, 0)
	switch selected {
	case menuOpen:
		tray.service.requestOpen()
	case menuLogs:
		if err := openBrowser(filepath.Join(tray.service.root, ".updates", "logs")); err != nil {
			tray.reportError(err.Error())
		}
	case menuQuit:
		tray.stopping = true
		tray.service.requestQuit()
	}
}
func trayWindowProc(window uintptr, message uint32, wParam, lParam uintptr) uintptr {
	tray := activeTray
	if tray != nil {
		switch message {
		case wmTray:
			switch uint32(lParam) & 0xFFFF {
			case 0x400, 0x401:
				if !tray.stopping {
					tray.service.requestOpen()
				}
			case 0x7B:
				tray.popupMenu()
			}
			return 0
		case wmService:
			tray.consumeEvents()
			return 0
		case 0x0010:
			if !tray.finished {
				tray.stopping = true
				tray.service.requestQuit()
			}
			return 0
		case 0x0002:
			postQuit.Call(0)
			return 0
		}
		if tray.taskbarCreated != 0 && message == tray.taskbarCreated {
			tray.addIcon()
			return 0
		}
	}
	result, _, _ := defaultWindowProc.Call(window, uintptr(message), wParam, lParam)
	return result
}

func (tray *windowsTray) reportError(message string) {
	logStartupMessage(tray.service.root, message)
	showError(message)
}
