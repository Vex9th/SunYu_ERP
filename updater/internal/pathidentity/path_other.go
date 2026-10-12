//go:build !windows

package pathidentity

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// ResolveExisting resolves aliases to the existing physical path without changing files.
func ResolveExisting(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}

// IsLink includes Windows reparse points such as directory junctions.
func IsLink(info os.FileInfo) bool {
	return info.Mode()&os.ModeSymlink != 0
}

// Identity identifies the existing directory object across renames and restarts.
func Identity(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("无法确认目录身份：%s", path)
	}
	return fmt.Sprintf("%x:%x", uint64(stat.Dev), uint64(stat.Ino)), nil
}
