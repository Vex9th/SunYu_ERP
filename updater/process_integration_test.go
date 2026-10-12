package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testDriver(t *testing.T) string {
	t.Helper()
	if driver := os.Getenv("SUNYU_UPDATER_TEST_DRIVER"); driver != "" {
		return driver
	}
	goTool, err := exec.LookPath("go")
	if err != nil {
		t.Fatal("need Go SDK or SUNYU_UPDATER_TEST_DRIVER from the same source snapshot")
	}
	source, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	driver := filepath.Join(t.TempDir(), "driver.exe")
	cmd := exec.Command(goTool, "build", "-tags", "updatertest", "-o", driver, ".")
	cmd.Dir = source
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build driver: %v %s", err, out)
	}
	return driver
}
func TestRealWorkerHandoffNoUpdateAndReplay(t *testing.T) {
	driver := testDriver(t)
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "SunYu_ERP.exe"), []byte("old app"), 0700)
	os.WriteFile(filepath.Join(root, "update.exe"), []byte("old updater"), 0700)
	writeJSON(filepath.Join(root, ".updates/installed.json"), map[string]string{"version": "1.2.4", "sha256": sumBytes([]byte("old app"))})
	m := manifestFixture()
	m.Version = "1.2.4"
	m.Archive.URL = strings.ReplaceAll(m.Archive.URL, "1.2.5", "1.2.4")
	b, _ := json.Marshal(m)
	manifest := filepath.Join(t.TempDir(), "manifest.json")
	os.WriteFile(manifest, b, 0600)
	job := "7123456789abcdef0123456789abcdef"
	args := []string{"--root", root, "--apply", "--no-pause", "--job-id", job, "--test-manifest", manifest, "--test-package", filepath.Join(root, "unused.zip")}
	cmd := exec.Command(driver, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("handoff: %v %s", err, out)
	}
	deadline := time.Now().Add(10 * time.Second)
	var status Status
	for time.Now().Before(deadline) {
		readJSON(filepath.Join(root, ".updates/status.json"), &status)
		if !status.Busy && status.Phase == "success" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status.Phase != "success" || status.Message != "当前没有可安装的新版本" {
		log, _ := os.ReadFile(filepath.Join(root, ".updates/logs/updater.log"))
		t.Fatal(status, string(log))
	}
	before, _ := os.ReadFile(filepath.Join(root, ".updates/status.json"))
	cmd = exec.Command(driver, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	after, _ := os.ReadFile(filepath.Join(root, ".updates/status.json"))
	if string(before) != string(after) {
		t.Fatal("same completed UUID restarted task")
	}
}
