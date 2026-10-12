package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type launchOptions struct{ headless, noBrowser bool }

func parseOptions(args []string) (launchOptions, error) {
	var options launchOptions
	for _, arg := range args {
		switch arg {
		case "--headless":
			options.headless, options.noBrowser = true, true
		case "--no-browser":
			options.noBrowser = true
		default:
			return options, fmt.Errorf("未知启动参数：%s", arg)
		}
	}
	return options, nil
}

func serviceAddress(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		data = []byte(`{}`)
	} else if err != nil {
		return "", err
	}
	var raw map[string]json.RawMessage
	if len(data) > 1024*1024 || json.Unmarshal(data, &raw) != nil || raw == nil {
		return "", errors.New("config.json 格式无效")
	}
	host, port := "0.0.0.0", 8765
	if value, found := raw["host"]; found {
		if string(value) == "null" || json.Unmarshal(value, &host) != nil {
			return "", errors.New("config.json 的 host 必须是地址")
		}
	}
	if value, found := raw["port"]; found {
		if string(value) == "null" || json.Unmarshal(value, &port) != nil {
			return "", errors.New("config.json 的 port 必须是整数")
		}
	}
	if port < 1 || port > 65535 {
		return "", errors.New("config.json 的 port 必须在 1 至 65535 之间")
	}
	if host == "" || strings.TrimSpace(host) != host || strings.ContainsAny(host, "/\\?#@[]\x00\r\n\t ") || strings.Contains(host, ":") && net.ParseIP(host) == nil {
		return "", errors.New("config.json 的 host 无效")
	}
	switch host {
	case "0.0.0.0":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port)), nil
}

var (
	errUnavailable    = errors.New("服务尚未就绪")
	errForeignService = errors.New("配置端口已被其他程序或其他安装目录使用，请检查 config.json 的 port")
	errStopping       = errors.New("服务正在退出，请等待托盘图标消失后再启动")
)

type healthProbe func(context.Context) error

func newHealthProbe(root, address string, verify func(string, int) bool) healthProbe {
	// 本机探测始终直连，不能受 Clash 或系统代理的规则影响。
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, DialContext: (&net.Dialer{Timeout: time.Second}).DialContext}
	client := &http.Client{Transport: transport, Timeout: 1500 * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context) error {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, address+"/api/health", nil)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err != nil {
			return fmt.Errorf("%w：%v", errUnavailable, err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return errForeignService
		}
		var result struct {
			Status  string `json:"status"`
			Version string `json:"backend_version"`
			PID     int    `json:"pid"`
		}
		decoder := json.NewDecoder(io.LimitReader(response.Body, 8192))
		if decoder.Decode(&result) != nil || result.Status != "ok" || result.Version == "" || result.PID <= 0 || !verify(root, result.PID) {
			return errForeignService
		}
		return nil
	}
}

func waitForService(ctx context.Context, probe healthProbe, interval time.Duration) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := probe(ctx); err == nil {
			return nil
		} else if !errors.Is(err, errUnavailable) {
			return err
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func requestServiceStop(root string) error {
	directory := filepath.Join(root, ".updates")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(directory, "shutdown"), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = file.Sync()
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func shutdownRequested(root string) bool {
	_, err := os.Stat(filepath.Join(root, ".updates", "shutdown"))
	return err == nil
}

// 文件锁由操作系统释放，覆盖同机不同登录会话，也不会留下阻止下次启动的陈旧 PID 文件。
func acquireLauncherLock(root string) (func(), bool, error) {
	directory := filepath.Join(root, ".updates")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, false, err
	}
	file, err := os.OpenFile(filepath.Join(directory, "launcher.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, false, err
	}
	acquired, err := tryLockFile(file)
	if err != nil || !acquired {
		file.Close()
		return nil, acquired, err
	}
	return func() { _ = unlockFile(file); _ = file.Close() }, true, nil
}

func installationBusy(root string) (bool, error) {
	for _, name := range []string{"server.lock", "backend.lock"} {
		file, err := os.OpenFile(filepath.Join(root, ".updates", name), os.O_RDWR, 0600)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, err
		}
		acquired, lockErr := tryLockFile(file)
		if acquired {
			_ = unlockFile(file)
		}
		_ = file.Close()
		if lockErr != nil {
			return false, lockErr
		}
		if !acquired {
			return true, nil
		}
	}
	return false, nil
}
