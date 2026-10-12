package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// The copied test binary acts as the runtime, so process spawning and exit codes are real.
func TestMain(m *testing.M) {
	if code := os.Getenv("SUNYU_LAUNCHER_TEST_EXIT"); code != "" {
		cwd, _ := os.Getwd()
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"cwd": cwd, "args": os.Args[1:]})
		fmt.Fprintln(os.Stderr, "runtime stderr")
		exitCode, _ := strconv.Atoi(code)
		os.Exit(exitCode)
	}
	os.Exit(m.Run())
}

func TestLaunchUsesExecutableRootAndPreservesRuntimeExit(t *testing.T) {
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
			got := launch(filepath.Join(root, "SunYu_ERP.exe"), nil, &stdout, &stderr)
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
	var stderr bytes.Buffer
	if code := launch(filepath.Join(t.TempDir(), "SunYu_ERP.exe"), nil, &bytes.Buffer{}, &stderr); code == 0 {
		t.Fatal("missing runtime reported success")
	}
	if !bytes.Contains(stderr.Bytes(), []byte("SunYuRuntime.exe")) {
		t.Fatalf("missing actionable runtime path: %s", stderr.String())
	}
}
