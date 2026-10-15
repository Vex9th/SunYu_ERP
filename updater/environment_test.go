package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"testing"
)

func TestDetachedEnvironmentChild(t *testing.T) {
	if os.Getenv("SUNYU_ENVIRONMENT_HELPER") != "1" {
		return
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{
		"reset":  os.Getenv("PYINSTALLER_RESET_ENVIRONMENT"),
		"proxy":  os.Getenv("HTTPS_PROXY"),
		"marker": os.Getenv("SUNYU_ENVIRONMENT_HELPER"),
	})
	os.Exit(0)
}

func TestDetachedProcessResetsFrozenEnvironment(t *testing.T) {
	t.Setenv("_PYI_APPLICATION_HOME_DIR", "deleted-parent-extraction")
	t.Setenv("_PYI_PARENT_PROCESS_LEVEL", "1")
	t.Setenv("PYINSTALLER_RESET_ENVIRONMENT", "0")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:10808")
	t.Setenv("SUNYU_ENVIRONMENT_HELPER", "1")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, explicit := range []bool{false, true} {
		cmd := exec.Command(self, "-test.run=^TestDetachedEnvironmentChild$")
		if explicit {
			cmd.Env = os.Environ()
		}
		configureDetached(cmd, false)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("child process failed: %v: %s", err, output)
		}
		var received map[string]string
		if err := json.Unmarshal(output, &received); err != nil {
			t.Fatal(err)
		}
		if received["reset"] != "1" {
			t.Fatalf("detached restart reused parent PyInstaller environment: %v", received)
		}
		if received["proxy"] != "http://127.0.0.1:10808" || received["marker"] != "1" {
			t.Fatalf("unrelated environment was lost: %v", received)
		}
	}
}
