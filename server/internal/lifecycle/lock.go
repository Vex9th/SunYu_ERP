package lifecycle

import (
	"errors"
	"os"
	"path/filepath"
)

var ErrBusy = errors.New("installation is already running")

func Acquire(root, name string) (func(), error) {
	if name != "server.lock" && name != "backend.lock" && name != "installer.lock" && name != "launcher.lock" {
		return nil, errors.New("unknown lock")
	}
	directory := filepath.Join(root, ".updates")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(directory, name), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lock(file); err != nil {
		file.Close()
		return nil, err
	}
	return func() { _ = unlock(file); _ = file.Close() }, nil
}
