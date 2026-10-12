package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sunyu.local/updater/internal/pathidentity"
	"time"
)

type localServices struct{ root, job string }

func samePath(a, b string) bool {
	a, e := pathidentity.ResolveExisting(a)
	if e != nil {
		return false
	}
	b, e = pathidentity.ResolveExisting(b)
	if e != nil {
		return false
	}
	ai, e := os.Stat(a)
	if e != nil {
		return false
	}
	bi, e := os.Stat(b)
	return e == nil && os.SameFile(ai, bi)
}
func processMatches(path string, pid int) bool {
	actual, err := processPath(pid)
	return err == nil && samePath(path, actual)
}
func (s *localServices) endpoint() (string, int, error) {
	var c struct {
		Host *string `json:"host"`
		Port *int    `json:"port"`
	}
	err := readJSON(filepath.Join(s.root, "config.json"), &c)
	if err != nil && !os.IsNotExist(err) {
		return "", 0, fmt.Errorf("配置读取失败：%w", err)
	}
	host := "127.0.0.1"
	port := 8765
	if c.Host != nil {
		host = *c.Host
	}
	if c.Port != nil {
		port = *c.Port
	}
	if port < 1 || port > 65535 {
		return "", 0, errors.New("配置端口无效")
	}
	switch host {
	case "0.0.0.0", "localhost":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "", 0, errors.New("服务host必须是本机IP地址")
	}
	if !ip.IsLoopback() {
		addresses, err := net.InterfaceAddrs()
		if err != nil {
			return "", 0, err
		}
		found := false
		for _, a := range addresses {
			local, _, err := net.ParseCIDR(a.String())
			if err == nil && ip.Equal(local) {
				found = true
			}
		}
		if !found {
			return "", 0, errors.New("服务host不是本机地址")
		}
	}
	return host, port, nil
}
func (s *localServices) validate() error { _, _, err := s.endpoint(); return err }
func (s *localServices) stop() error {
	app := filepath.Join(s.root, "SunYu_ERP.exe")
	pids, err := matchingProcesses(app)
	if err != nil {
		return err
	}
	if len(pids) == 0 {
		return nil
	}
	var rt Runtime
	graceful := readJSON(filepath.Join(s.root, ".updates/runtime.json"), &rt) == nil && rt.Instance != "" && processMatches(app, rt.PID) && samePath(app, rt.Executable)
	if graceful {
		if err = writeJSON(filepath.Join(s.root, ".updates/shutdown.json"), map[string]string{"instance_id": rt.Instance}); err != nil {
			return err
		}
	} else {
		for _, pid := range pids {
			if err = terminateOwned(app, pid); err != nil {
				return err
			}
		}
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		pids, err = matchingProcesses(app)
		if err != nil {
			return err
		}
		if len(pids) == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("主程序尚未完全退出，未替换程序或数据；请关闭此安装的程序后重试")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
func (s *localServices) start(expected string) error {
	host, port, err := s.endpoint()
	if err != nil {
		return err
	}
	app := filepath.Join(s.root, "SunYu_ERP.exe")
	pids, err := matchingProcesses(app)
	if err != nil {
		return err
	}
	if len(pids) == 0 {
		if err = os.MkdirAll(filepath.Join(s.root, ".updates/logs"), 0700); err != nil {
			return err
		}
		log, err := os.OpenFile(filepath.Join(s.root, ".updates/logs/runtime.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		cmd := exec.Command(app)
		cmd.Dir = s.root
		cmd.Stdout = log
		cmd.Stderr = log
		configureDetached(cmd, false)
		err = cmd.Start()
		log.Close()
		if err != nil {
			return err
		}
		go cmd.Wait()
	}
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get("http://" + net.JoinHostPort(host, strconv.Itoa(port)) + "/api/health")
		if err == nil {
			var health struct {
				Status   string `json:"status"`
				Version  string `json:"version"`
				PID      int    `json:"pid"`
				Instance string `json:"instance_id"`
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&health)
			response.Body.Close()
			if response.StatusCode == 200 && decodeErr == nil && health.Status == "ok" {
				var rt Runtime
				if readJSON(filepath.Join(s.root, ".updates/runtime.json"), &rt) == nil && (expected == "" || rt.Version == expected) && validVersion(rt.Version) && health.Version == rt.Version && rt.Instance != "" && rt.Instance == health.Instance && rt.PID == health.PID && processMatches(app, rt.PID) && samePath(app, rt.Executable) {
					return nil
				}
				if expected == "1.2.4" && health.Version == "" {
					pid, err := listenerPID(host, port)
					if err == nil && processMatches(app, pid) {
						return nil
					}
				}
			}
		}
		pids, err = matchingProcesses(app)
		if err != nil {
			return err
		}
		if len(pids) == 0 {
			return errors.New("程序在健康检查通过前退出，请查看.updates/logs/runtime.log")
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("版本%s启动验证超时，未开放业务写入", expected)
}

func (s *localServices) detect() (string, error) {
	if err := s.start(""); err != nil {
		return "", err
	}
	var rt Runtime
	if err := readJSON(filepath.Join(s.root, ".updates/runtime.json"), &rt); err != nil {
		return "", err
	}
	if !validVersion(rt.Version) || !processMatches(filepath.Join(s.root, "SunYu_ERP.exe"), rt.PID) {
		return "", errors.New("原服务版本或进程归属已变化")
	}
	return rt.Version, nil
}
