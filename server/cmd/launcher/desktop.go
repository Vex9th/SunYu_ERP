package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sunyu.local/erp/internal/update"
	"time"
)

type trayEvent struct {
	status   string
	stopping bool
	err      error
	done     bool
	code     int
}

type desktopService struct {
	root, address string
	options       launchOptions
	events        chan trayEvent
	quit          chan struct{}
	open          chan struct{}
}

func newDesktopService(root, address string, options launchOptions) *desktopService {
	return &desktopService{root: root, address: address, options: options, events: make(chan trayEvent, 16), quit: make(chan struct{}, 1), open: make(chan struct{}, 1)}
}

func (service *desktopService) requestQuit() {
	select {
	case service.quit <- struct{}{}:
	default:
	}
}
func (service *desktopService) requestOpen() {
	select {
	case service.open <- struct{}{}:
	default:
	}
}

func openRuntimeLog(root string) (*os.File, error) {
	directory := filepath.Join(root, ".updates", "logs")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "runtime.log")
	busy, err := installationBusy(root)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(path); err == nil && !busy && info.Size() > 8*1024*1024 {
		backup := path + ".previous"
		if err := os.Remove(backup); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if err := os.Rename(path, backup); err != nil {
			return nil, err
		}
	}
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
}

func (service *desktopService) run() {
	exitCode := 0
	var terminalError error
	defer func() { service.events <- trayEvent{done: true, code: exitCode, err: terminalError} }()
	fail := func(err error) { terminalError = err; exitCode = 1 }
	logFile, err := openRuntimeLog(service.root)
	if err != nil {
		fail(fmt.Errorf("无法写入启动日志：%w", err))
		return
	}
	defer logFile.Close()
	logger := log.New(logFile, "launcher: ", log.Ldate|log.Ltime)
	logger.Printf("starting; root=%s, headless=%v", service.root, service.options.headless)
	defer func() { logger.Printf("finished; code=%d, error=%v", exitCode, terminalError) }()
	probe := newHealthProbe(service.root, service.address, processBelongsToRoot)
	busy, err := installationBusy(service.root)
	if err != nil {
		fail(fmt.Errorf("无法检查安装目录的运行锁：%w", err))
		return
	}
	probeError := probe(context.Background())
	if errors.Is(probeError, errForeignService) {
		fail(probeError)
		return
	}
	if (busy || probeError == nil) && shutdownRequested(service.root) {
		fail(errStopping)
		return
	}
	var childDone <-chan error
	if !busy && probeError != nil {
		// 仅在本启动器持锁、确认没有旧业务进程后清理自己的上次退出标记。
		if err := os.Remove(filepath.Join(service.root, ".updates", "shutdown")); err != nil && !errors.Is(err, os.ErrNotExist) {
			fail(err)
			return
		}
		if err := os.Remove(filepath.Join(service.root, ".updates", "stop")); err != nil && !errors.Is(err, os.ErrNotExist) {
			fail(err)
			return
		}
		command := runtimeCommand(filepath.Join(service.root, "SunYu_ERP.exe"), nil, logFile, logFile)
		command.Env = append(command.Env, "SUNYU_UPDATE_START="+service.options.updateStart)
		if service.options.headless {
			command.Env = append(command.Env, "SUNYU_HEADLESS=1")
		} else {
			command.Env = append(command.Env, "SUNYU_HEADLESS=0")
		}
		if service.options.headless {
			command.Stdin = os.Stdin
			command.Stdout = io.MultiWriter(logFile, os.Stdout)
			command.Stderr = io.MultiWriter(logFile, os.Stderr)
		}
		if err := command.Start(); err != nil {
			fail(fmt.Errorf("启动失败，请保留完整安装包中的 app 目录：%w", err))
			return
		}
		logger.Printf("service pid=%d", command.Process.Pid)
		completed := make(chan error, 1)
		childDone = completed
		go func() { completed <- command.Wait() }()
	} else {
		logger.Print("attached to existing service; no new runtime started")
	}
	if err := service.monitor(childDone, logger, probe); err != nil {
		fail(err)
	}
}

func (service *desktopService) monitor(childDone <-chan error, logger *log.Logger, probe healthProbe) error {
	var busy bool
	var err error
	var probeError error
	serviceExited := false
	ready, everReady, stopping, slow := false, false, false, false
	openRequested := !service.options.noBrowser
	start := time.Now()
	service.events <- trayEvent{status: "服务正在启动"}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-service.quit:
			if stopping {
				continue
			}
			if err := requestServiceStop(service.root); err != nil {
				service.events <- trayEvent{status: "退出失败，请重试", err: fmt.Errorf("退出请求未保存，请检查目录写权限：%w", err)}
				continue
			}
			stopping = true
			openRequested = false
			logger.Print("graceful shutdown requested")
			service.events <- trayEvent{status: "正在退出，等待当前操作完成", stopping: true}
		case <-service.open:
			if !stopping {
				openRequested = true
			}
		case childError := <-childDone:
			childDone = nil
			serviceExited = true
			busy, err = installationBusy(service.root)
			if err != nil {
				// 锁状态不明时继续保留托盘和启动锁，避免留下无人管理的后台。
				logger.Printf("service exited; unable to inspect remaining process locks: %v", err)
				service.events <- trayEvent{err: fmt.Errorf("服务进程已退出，暂时无法确认后台状态：%w", err)}
				continue
			}
			if busy {
				logger.Printf("service exited; backend remains active: %v", childError)
				if !stopping && !shutdownRequested(service.root) {
					service.events <- trayEvent{status: "后端运行中，服务进程已退出", err: errors.New("服务进程已退出，后端仍在运行。当前操作可以继续，请通过托盘安全退出后重新启动。")}
				}
				// 已请求退出时，后续轮询会确认 server.lock 空闲再向孤儿后端写 stop。
				continue
			}
			if childError != nil {
				return fmt.Errorf("服务已退出：%w\n请查看 %s", childError, filepath.Join(service.root, ".updates", "logs", "runtime.log"))
			}
			if !everReady && !stopping && !shutdownRequested(service.root) {
				return errors.New("服务在就绪前退出，请查看 .updates/logs/runtime.log")
			}
			return nil
		case <-ticker.C:
			busy, err = installationBusy(service.root)
			if err != nil {
				logger.Printf("lock check: %v", err)
				continue
			}
			if shutdownRequested(service.root) && !stopping {
				stopping = true
				openRequested = false
				service.events <- trayEvent{status: "正在退出，等待当前操作完成", stopping: true}
			}
			if stopping {
				// 服务进程不存在时（例如上次外部结束了它），仍让存活后端走既有 stop 协议。
				if childDone == nil && !busy {
					return nil
				}
				if childDone == nil {
					if err := stopOrphanBackend(service.root); err != nil {
						logger.Printf("stop orphan backend: %v", err)
					}
				}
				continue
			}
			probeError = probe(context.Background())
			if probeError == nil {
				if !ready {
					ready, everReady = true, true
					logger.Print("service ready")
					status := "服务运行中"
					if serviceExited {
						status = "后端运行中，服务进程已退出"
					}
					service.events <- trayEvent{status: status}
				}
				if openRequested {
					openRequested = false
					if err := openBrowser(service.address); err != nil {
						logger.Printf("browser: %v", err)
						service.events <- trayEvent{err: fmt.Errorf("无法打开浏览器，请手动访问 %s：%w", service.address, err)}
					}
				}
				continue
			}
			if !busy && childDone == nil {
				if ready {
					return errors.New("服务已意外停止，请查看 .updates/logs/runtime.log")
				}
				return probeError
			}
			if errors.Is(probeError, errForeignService) {
				if !stopping {
					service.events <- trayEvent{err: probeError}
					service.requestQuit()
				}
			} else if ready {
				start, slow = time.Now(), false
				ready = false
				service.events <- trayEvent{status: "服务正在重新连接"}
			}
			if !slow && time.Since(start) > 90*time.Second {
				slow = true
				service.events <- trayEvent{status: "服务仍在启动，请查看日志", err: errors.New("服务尚未就绪，可能正在完成迁移或备份。可在托盘菜单查看日志；退出会等待当前操作完成。")}
			}
		}
	}
}

// 只在 service 锁空闲、backend 锁仍被占用时使用；不会干扰更新过程中的新后端启动。
func stopOrphanBackend(root string) error {
	path := filepath.Join(root, ".updates", "server.lock")
	file, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if file != nil {
		defer file.Close()
		acquired, err := tryLockFile(file)
		if err != nil {
			return err
		}
		if !acquired {
			return nil
		}
		defer unlockFile(file)
	}
	target, err := os.OpenFile(filepath.Join(root, ".updates", "stop"), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	return target.Close()
}

func runApplication(executable string, options launchOptions) int {
	root := filepath.Dir(executable)
	interactive, desktopErr := interactiveDesktop()
	if desktopErr != nil {
		logStartupMessage(root, "无法确认交互桌面："+desktopErr.Error())
		// An unknown desktop state must not silently disable the user's tray.
		interactive = true
	}
	options = desktopLaunchOptions(options, interactive)
	logStartupMessage(root, fmt.Sprintf("launch requested; interactive=%v headless=%v update=%s", interactive, options.headless, options.updateStart))

	address, err := serviceAddress(root)
	if err != nil {
		reportStartupError(options, err.Error())
		return 1
	}
	release, owner, err := acquireLauncherLock(root)
	if err != nil {
		reportStartupError(options, fmt.Sprintf("无法获取启动锁：%v", err))
		return 1
	}
	if !owner {
		if shutdownRequested(root) {
			reportStartupError(options, errStopping.Error())
			return 1
		}
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		probe := newHealthProbe(root, address, processBelongsToRoot)
		err := waitForService(ctx, func(ctx context.Context) error {
			if shutdownRequested(root) {
				return errStopping
			}
			return probe(ctx)
		}, 300*time.Millisecond)
		if err != nil {
			reportStartupError(options, fmt.Sprintf("原服务尚未就绪：%v\n请查看托盘状态及 .updates/logs/runtime.log。", err))
			return 1
		}
		if !options.noBrowser {
			if err := openBrowser(address); err != nil {
				reportStartupError(options, fmt.Sprintf("请手动打开 %s：%v", address, err))
				return 1
			}
		}
		return 0
	}
	defer release()
	if handedOff, err := update.PrepareLaunch(root, options.updateStart); err != nil {
		reportStartupError(options, err.Error())
		return 1
	} else if handedOff {
		return 0
	}
	service := newDesktopService(root, address, options)
	if !options.headless {
		return runTray(service)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt)
	defer signal.Stop(signals)
	go service.run()
	for {
		select {
		case <-signals:
			service.requestQuit()
		case event := <-service.events:
			if event.err != nil {
				fmt.Fprintln(os.Stderr, event.err)
			}
			if event.done {
				return event.code
			}
		}
	}
}

func desktopLaunchOptions(options launchOptions, interactive bool) launchOptions {
	options.headless = options.headless || os.Getenv("SUNYU_HEADLESS") == "1" || !interactive
	if !interactive {
		options.noBrowser = true
	}
	return options
}

func logStartupMessage(root, message string) {
	file, err := openRuntimeLog(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "启动日志写入失败：%v; %s\n", err, message)
		return
	}
	defer file.Close()
	log.New(file, "launcher: ", log.Ldate|log.Ltime).Print(message)
}

func reportStartupError(options launchOptions, message string) {
	if executable, err := os.Executable(); err == nil {
		logStartupMessage(filepath.Dir(executable), message)
	}
	if options.headless {
		fmt.Fprintln(os.Stderr, message)
	} else {
		showError(message)
	}
}
