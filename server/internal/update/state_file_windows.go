//go:build windows

package update

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
)

func openStateFile(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// Readers retain a complete old snapshot while atomic replacement publishes
	// the next one. Without SHARE_DELETE, Windows denies the replacement.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open state snapshot", Path: path, Err: err}
	}
	return os.NewFile(uintptr(handle), path), nil
}

func replaceStateFile(source, target string) error {
	directory, err := os.OpenRoot(filepath.Dir(target))
	if err != nil {
		return err
	}
	defer directory.Close()
	if filepath.Dir(source) != filepath.Dir(target) {
		return errors.New("状态文件必须在同一目录原子替换")
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		err := directory.Rename(filepath.Base(source), filepath.Base(target))
		if err == nil {
			return nil
		}
		if !errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_SHARING_VIOLATION) && !errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return err
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
}
