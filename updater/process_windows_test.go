//go:build windows

package main

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestExitedProcessAccessDeniedIsNotAnInstallationBlocker(t *testing.T) {
	path, exited, err := queryLiveImage(11616, func(int) (string, error) { return "", windows.ERROR_ACCESS_DENIED }, func(int) (bool, error) { return true, nil })
	if err != nil || !exited || path != "" {
		t.Fatal(path, exited, err)
	}
}
func TestInaccessibleLiveProcessStillBlocksInstallation(t *testing.T) {
	_, exited, err := queryLiveImage(11616, func(int) (string, error) { return "", windows.ERROR_ACCESS_DENIED }, func(int) (bool, error) { return false, nil })
	if exited || !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatal("unknown live process must not be skipped", exited, err)
	}
}
func TestExitDuringImageQueryIsRechecked(t *testing.T) {
	checks := 0
	_, exited, err := queryLiveImage(11616, func(int) (string, error) { return "", windows.ERROR_ACCESS_DENIED }, func(int) (bool, error) { checks++; return checks > 1, nil })
	if err != nil || !exited || checks < 2 {
		t.Fatal(exited, checks, err)
	}
}
func TestWindowsProcessFixture(t *testing.T) {
	if os.Getenv("SUNYU_UPDATER_PROCESS_HELPER") != "1" {
		return
	}
	time.Sleep(30 * time.Second)
	os.Exit(0)
}
func TestTerminatedOwnedProcessCanBeRecheckedSafely(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "SunYu_ERP.exe")
	if err = copyFile(self, target); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(target, "-test.run=^TestWindowsProcessFixture$")
	cmd.Env = append(os.Environ(), "SUNYU_UPDATER_PROCESS_HELPER=1")
	configureDetached(cmd, false)
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(cmd.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	if err = cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	gone, err := confirmedProcessExited(cmd.Process.Pid)
	if err != nil || !gone {
		t.Fatal("terminated owned process not confirmed", gone, err)
	}
	if _, queryErr := processPath(cmd.Process.Pid); queryErr != nil {
		_, gone, err := queryLiveImage(cmd.Process.Pid, processPath, confirmedProcessExited)
		if err != nil || !gone {
			t.Fatal("terminated image-query failure was not resolved", gone, err)
		}
	}
	if err = terminateOwned(target, cmd.Process.Pid); err != nil {
		t.Fatal("already exited process blocked stopping", err)
	}
	pids, err := matchingProcesses(target)
	if err != nil || len(pids) != 0 {
		t.Fatal(pids, err)
	}
}

func TestExitedProcessGeneralFailureIsConfirmedBeforeSkipping(t *testing.T) {
	_, gone, err := queryLiveImage(42, func(int) (string, error) { return "", windows.ERROR_GEN_FAILURE }, func(int) (bool, error) { return true, nil })
	if !gone || err != nil {
		t.Fatal(gone, err)
	}
}
