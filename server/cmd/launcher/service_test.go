package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestServiceAddressUsesConfiguredPortAndLocalWildcardHost(t *testing.T) {
	for _, tc := range []struct{ config, want string }{
		{`{}`, "http://127.0.0.1:8765"},
		{`{"host":"0.0.0.0","port":9876}`, "http://127.0.0.1:9876"},
		{`{"host":"::","port":9876}`, "http://[::1]:9876"},
		{`{"host":"192.168.1.12","port":9876}`, "http://192.168.1.12:9876"},
	} {
		t.Run(tc.config, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(tc.config), 0600); err != nil {
				t.Fatal(err)
			}
			got, err := serviceAddress(root)
			if err != nil || got != tc.want {
				t.Fatalf("address=%q error=%v", got, err)
			}
		})
	}
	got, err := serviceAddress(t.TempDir())
	if err != nil || got != "http://127.0.0.1:8765" {
		t.Fatalf("default=%q, %v", got, err)
	}
}

func TestServiceAddressRejectsInvalidConfig(t *testing.T) {
	for _, data := range []string{`{"port":0}`, `{"port":65536}`, `{"port":true}`, `{"host":"http://localhost"}`, `{"host":""}`, `{"host":"localhost/path"}`, `{"port":1.5}`, `[]`, `{"host":null}`} {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := serviceAddress(root); err == nil {
			t.Fatalf("accepted invalid config %s", data)
		}
	}
}

func TestProbeServiceBypassesProxyAndChecksOwningExecutable(t *testing.T) {
	var proxied atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { proxied.Add(1); w.WriteHeader(502) }))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "backend_version": "1.3.0", "pid": 123})
	}))
	defer server.Close()
	var verified bool
	probe := newHealthProbe("/installation", server.URL, func(root string, pid int) bool { verified = root == "/installation" && pid == 123; return verified })
	if err := probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !verified || proxied.Load() != 0 {
		t.Fatalf("verification=%v proxy calls=%d", verified, proxied.Load())
	}
	probe = newHealthProbe("/installation", server.URL, func(string, int) bool { return false })
	if err := probe(context.Background()); !errors.Is(err, errForeignService) {
		t.Fatalf("foreign service accepted: %v", err)
	}
}

func TestProbeServiceRejectsRedirectAndOtherApplications(t *testing.T) {
	for _, data := range []string{`{"status":"ok"}`, `{"status":"ok","backend_version":"1.3.0","pid":0}`, `{"status":"bad","backend_version":"1.3.0","pid":12}`, `<html>another application</html>`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(data)) }))
		probe := newHealthProbe("/root", server.URL, func(string, int) bool { return true })
		if err := probe(context.Background()); !errors.Is(err, errForeignService) {
			t.Errorf("accepted %s: %v", data, err)
		}
		server.Close()
	}
	var followed atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { followed.Store(true) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer redirect.Close()
	if err := newHealthProbe("/root", redirect.URL, func(string, int) bool { return true })(context.Background()); !errors.Is(err, errForeignService) {
		t.Fatal(err)
	}
	if followed.Load() {
		t.Fatal("health redirect followed")
	}
}

func TestWaitForServiceWaitsThroughStartupAndHonorsCancellation(t *testing.T) {
	calls := 0
	probe := func(context.Context) error {
		calls++
		if calls < 3 {
			return errUnavailable
		}
		return nil
	}
	if err := waitForService(context.Background(), probe, time.Millisecond); err != nil || calls != 3 {
		t.Fatalf("calls=%d error=%v", calls, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitForService(ctx, func(context.Context) error { return errUnavailable }, time.Millisecond); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := waitForService(context.Background(), func(context.Context) error { return errForeignService }, time.Millisecond); !errors.Is(err, errForeignService) {
		t.Fatal(err)
	}
}

func TestStopRequestPreservesBusinessFiles(t *testing.T) {
	root := t.TempDir()
	config := []byte(`{"port":9876,"data_dir":"external-data"}`)
	if err := os.WriteFile(filepath.Join(root, "config.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
	if err := requestServiceStop(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, ".updates", "shutdown")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "config.json"))
	if err != nil || string(got) != string(config) {
		t.Fatal("configuration changed")
	}
}

func TestParseOptionsRejectsUnknownAndHeadlessDisablesBrowser(t *testing.T) {
	got, err := parseOptions([]string{"--headless"})
	if err != nil || !got.headless || !got.noBrowser {
		t.Fatalf("options=%+v %v", got, err)
	}
	got, err = parseOptions([]string{"--no-browser"})
	if err != nil || got.headless || !got.noBrowser {
		t.Fatalf("options=%+v %v", got, err)
	}
	if _, err = parseOptions([]string{"--unknown"}); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatal("unknown option accepted")
	}
}

func TestLauncherLockSerializesProcessesAndReleases(t *testing.T) {
	root := t.TempDir()
	release, owner, err := acquireLauncherLock(root)
	if err != nil || !owner {
		t.Fatalf("first lock: %v %v", owner, err)
	}
	defer release()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	check := func(want string) {
		t.Helper()
		command := exec.Command(executable)
		command.Env = append(os.Environ(), "SUNYU_LAUNCHER_LOCK_PROBE="+root)
		output, err := command.CombinedOutput()
		if err != nil || strings.TrimSpace(string(output)) != want {
			t.Fatalf("lock ownership=%s error=%v want=%s", output, err, want)
		}
	}
	check("false")
	release()
	check("true")
}

func TestInstallationBusyRespectsBackendAndSupervisorLocks(t *testing.T) {
	for _, name := range []string{"server.lock", "backend.lock"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Mkdir(filepath.Join(root, ".updates"), 0700); err != nil {
				t.Fatal(err)
			}
			file, err := os.OpenFile(filepath.Join(root, ".updates", name), os.O_CREATE|os.O_RDWR, 0600)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			acquired, err := tryLockFile(file)
			if err != nil || !acquired {
				t.Fatal(err)
			}
			if busy, err := installationBusy(root); err != nil || !busy {
				t.Fatalf("busy=%v error=%v", busy, err)
			}
			if err := unlockFile(file); err != nil {
				t.Fatal(err)
			}
			if busy, err := installationBusy(root); err != nil || busy {
				t.Fatalf("busy=%v error=%v", busy, err)
			}
		})
	}
}

func TestOrphanStopNeverInterruptsLiveSupervisor(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".updates"), 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(filepath.Join(root, ".updates", "server.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	acquired, err := tryLockFile(file)
	if err != nil || !acquired {
		t.Fatal(err)
	}
	if err := stopOrphanBackend(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, ".updates", "stop")); !os.IsNotExist(err) {
		t.Fatal("live supervisor received backend stop")
	}
	if err := unlockFile(file); err != nil {
		t.Fatal(err)
	}
	if err := stopOrphanBackend(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, ".updates", "stop")); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeLogDoesNotRotateWhileBackendHoldsInstallation(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".updates", "logs")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "runtime.log")
	active, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
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
	defer unlockFile(backend)
	writer, err := openRuntimeLog(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.WriteString("attached"); err != nil {
		writer.Close()
		t.Fatal(err)
	}
	writer.Close()
	if _, err := os.Stat(path + ".previous"); !os.IsNotExist(err) {
		t.Fatal("active log was rotated")
	}
	info, err := active.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 8*1024*1024+1+int64(len("attached")) {
		t.Fatalf("existing handle no longer references active log: %d", info.Size())
	}
}

func TestSupervisorExitKeepsOrphanManagedUntilBackendStops(t *testing.T) {
	for _, quitBeforeExit := range []bool{false, true} {
		t.Run(fmt.Sprint(quitBeforeExit), func(t *testing.T) {
			root := t.TempDir()
			if err := os.Mkdir(filepath.Join(root, ".updates"), 0700); err != nil {
				t.Fatal(err)
			}
			lock := func(name string) *os.File {
				t.Helper()
				file, err := os.OpenFile(filepath.Join(root, ".updates", name), os.O_CREATE|os.O_RDWR, 0600)
				if err != nil {
					t.Fatal(err)
				}
				owned, err := tryLockFile(file)
				if err != nil || !owned {
					file.Close()
					t.Fatal(err)
				}
				t.Cleanup(func() { file.Close() })
				return file
			}
			backend := lock("backend.lock")
			supervisor := lock("server.lock")
			service := newDesktopService(root, "http://127.0.0.1:8765", launchOptions{noBrowser: true})
			childDone := make(chan error, 1)
			result := make(chan error, 1)
			go func() {
				result <- service.monitor(childDone, log.New(io.Discard, "", 0), func(context.Context) error { return nil })
			}()
			defer func() { supervisor.Close(); backend.Close(); service.requestQuit() }()
			awaitEvent := func(match func(trayEvent) bool) {
				t.Helper()
				deadline := time.NewTimer(3 * time.Second)
				defer deadline.Stop()
				for {
					select {
					case err := <-result:
						t.Fatalf("tray management ended before backend stopped: %v", err)
					case event := <-service.events:
						if match(event) {
							return
						}
					case <-deadline.C:
						t.Fatal("timed out waiting for tray state")
					}
				}
			}
			awaitEvent(func(event trayEvent) bool { return event.status == "服务运行中" })
			if quitBeforeExit {
				service.requestQuit()
				awaitEvent(func(event trayEvent) bool { return event.stopping })
			}
			if err := supervisor.Close(); err != nil {
				t.Fatal(err)
			}
			childDone <- errors.New("supervisor terminated externally")
			if !quitBeforeExit {
				awaitEvent(func(event trayEvent) bool { return strings.Contains(event.status, "服务进程已退出") })
				if _, err := os.Stat(filepath.Join(root, ".updates", "stop")); !os.IsNotExist(err) {
					t.Fatal("orphan was stopped before user requested exit")
				}
				service.requestQuit()
				awaitEvent(func(event trayEvent) bool { return event.stopping })
			}
			deadline := time.Now().Add(3 * time.Second)
			for {
				if _, err := os.Stat(filepath.Join(root, ".updates", "stop")); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("orphan backend never received graceful stop")
				}
				select {
				case err := <-result:
					t.Fatalf("tray disappeared with active backend: %v", err)
				default:
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !shutdownRequested(root) {
				t.Fatal("persistent shutdown request missing")
			}
			select {
			case err := <-result:
				t.Fatalf("tray exited before backend released its lock: %v", err)
			default:
			}
			if err := backend.Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("tray did not finish after backend stopped")
			}
		})
	}
}

func TestNormalSupervisorExitAfterReadyAndReconnectRemainsSuccessful(t *testing.T) {
	for _, wasReady := range []bool{false, true} {
		t.Run(fmt.Sprint(wasReady), func(t *testing.T) {
			root := t.TempDir()
			service := newDesktopService(root, "http://127.0.0.1:8765", launchOptions{noBrowser: true})
			childDone := make(chan error, 1)
			result := make(chan error, 1)
			var healthy atomic.Bool
			healthy.Store(wasReady)
			go func() {
				result <- service.monitor(childDone, log.New(io.Discard, "", 0), func(context.Context) error {
					if healthy.Load() {
						return nil
					}
					return errUnavailable
				})
			}()
			defer func() {
				select {
				case childDone <- nil:
				default:
				}
			}()
			awaitState := func(want string) {
				t.Helper()
				deadline := time.NewTimer(3 * time.Second)
				defer deadline.Stop()
				for {
					select {
					case event := <-service.events:
						if event.status == want {
							return
						}
					case err := <-result:
						t.Fatalf("monitor exited before state %q: %v", want, err)
					case <-deadline.C:
						t.Fatalf("timed out waiting for %q", want)
					}
				}
			}
			awaitState("服务正在启动")
			if wasReady {
				awaitState("服务运行中")
				if err := os.Mkdir(filepath.Join(root, ".updates"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, ".updates", "stop"), nil, 0600); err != nil {
					t.Fatal(err)
				}
				healthy.Store(false)
				awaitState("服务正在重新连接")
				if shutdownRequested(root) {
					t.Fatal("temporary backend stop became a permanent shutdown request")
				}
				select {
				case err := <-result:
					t.Fatalf("backend restart ended launcher before supervisor exited: %v", err)
				default:
				}
			}
			childDone <- nil
			select {
			case err := <-result:
				if wasReady && err != nil {
					t.Fatalf("normal shutdown was reported as startup failure: %v", err)
				}
				if !wasReady && err == nil {
					t.Fatal("exit before first readiness was accepted")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("monitor did not finish after supervisor exited")
			}
		})
	}
}
