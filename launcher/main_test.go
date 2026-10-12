package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The copied test binary acts as the runtime, so process spawning and exit codes are real.
func TestMain(m *testing.M) {
	if mode := os.Getenv("SUNYU_LAUNCHER_TEST_ORPHAN"); mode != "" {
		if mode == "child" {
			time.Sleep(3 * time.Second)
			_ = os.WriteFile(os.Getenv("SUNYU_LAUNCHER_TEST_ORPHAN_DONE"), []byte("done"), 0600)
			return
		}
		_ = os.Setenv("SUNYU_LAUNCHER_TEST_ORPHAN", "child")
		child := exec.Command(os.Args[0])
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		fmt.Fprintln(os.Stdout, child.Process.Pid)
		return
	}
	if root := os.Getenv("SUNYU_LAUNCHER_LOCK_PROBE"); root != "" {
		release, acquired, err := acquireLauncherLock(root)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		if acquired {
			defer release()
		}
		fmt.Fprintln(os.Stdout, acquired)
		return
	}
	if os.Getenv("SUNYU_LAUNCHER_TEST_BLOCK") != "" {
		fmt.Fprintln(os.Stdout, "ready")
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}
	if code := os.Getenv("SUNYU_LAUNCHER_TEST_EXIT"); code != "" {
		cwd, _ := os.Getwd()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"cwd": cwd, "args": os.Args[1:]})
		fmt.Fprintln(os.Stderr, "runtime stderr")
		exitCode, _ := strconv.Atoi(code)
		os.Exit(exitCode)
	}
	os.Exit(m.Run())
}

func TestRuntimeCommandUsesExecutableRootAndPreservesRuntimeExit(t *testing.T) {
	for _, exitCode := range []int{0, 23} {
		t.Run(strconv.Itoa(exitCode), func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "安装 中文 with spaces")
			runtimeDirectory := filepath.Join(root, "runtime")
			if err := os.MkdirAll(runtimeDirectory, 0755); err != nil {
				t.Fatal(err)
			}
			binary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(runtimeDirectory, "SunYuRuntime.exe"), data, 0755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("SUNYU_LAUNCHER_TEST_EXIT", strconv.Itoa(exitCode))
			var stdout, stderr bytes.Buffer
			command := runtimeCommand(filepath.Join(root, "SunYu_ERP.exe"), nil, &stdout, &stderr)
			got := 0
			if err := command.Run(); err != nil {
				var exitError *exec.ExitError
				if !errors.As(err, &exitError) {
					t.Fatal(err)
				}
				got = exitError.ExitCode()
			}
			if got != exitCode {
				t.Fatalf("exit = %d, want %d: %s", got, exitCode, stderr.String())
			}
			var result struct {
				Cwd  string   `json:"cwd"`
				Args []string `json:"args"`
			}
			if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			// macOS may resolve /var to /private/var for the child working directory.
			wantRoot, err := filepath.EvalSymlinks(root)
			if err != nil {
				t.Fatal(err)
			}
			gotRoot, err := filepath.EvalSymlinks(result.Cwd)
			if err != nil {
				t.Fatal(err)
			}
			if gotRoot != wantRoot {
				t.Fatalf("cwd = %q, want %q", gotRoot, wantRoot)
			}
			if len(result.Args) != 3 || result.Args[0] != "--root" || result.Args[1] != root || result.Args[2] != "--supervise" {
				t.Fatalf("runtime arguments = %#v", result.Args)
			}
			if stderr.String() != "runtime stderr\n" {
				t.Fatalf("stderr was not inherited: %q", stderr.String())
			}
		})
	}
}

func TestMissingRuntimeReturnsFailure(t *testing.T) {
	command := runtimeCommand(filepath.Join(t.TempDir(), "SunYu_ERP.exe"), nil, &bytes.Buffer{}, &bytes.Buffer{})
	err := command.Run()
	if err == nil {
		t.Fatal("missing runtime reported success")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("SunYuRuntime.exe")) {
		t.Fatalf("missing actionable path: %v", err)
	}
}

func TestRuntimeCommandReturnsAfterSupervisorExitWithInheritedOutput(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "runtime")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "SunYuRuntime.exe"), binary, 0700); err != nil {
		t.Fatal(err)
	}
	finished := filepath.Join(root, "child-finished")
	var stdout, stderr bytes.Buffer
	defer func() {
		if runtime.GOOS == "windows" {
			if pid, err := strconv.Atoi(strings.TrimSpace(stdout.String())); err == nil {
				if process, err := os.FindProcess(pid); err == nil {
					_, _ = process.Wait()
				}
			}
		}
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(finished); err == nil {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Error("orphan test helper did not finish")
	}()
	t.Setenv("SUNYU_LAUNCHER_TEST_ORPHAN", "parent")
	t.Setenv("SUNYU_LAUNCHER_TEST_ORPHAN_DONE", finished)
	command := runtimeCommand(filepath.Join(root, "SunYu_ERP.exe"), nil, &stdout, &stderr)
	started := time.Now()
	err = command.Run()
	elapsed := time.Since(started)
	if !errors.Is(err, exec.ErrWaitDelay) {
		t.Fatalf("expected bounded pipe wait, got %v after %v", err, elapsed)
	}
}
