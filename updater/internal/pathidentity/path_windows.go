//go:build windows

package pathidentity

import (
	"fmt"
	"os"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// ResolveExisting resolves aliases to the existing physical path without changing files.
func ResolveExisting(path string) (string, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	handle, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "resolve directory", Path: path, Err: err}
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	// FILE_NAME_NORMALIZED | VOLUME_NAME_DOS returns one long, extended-path
	// spelling for both ordinary paths and 8.3/extended-path aliases.
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil {
		return "", &os.PathError{Op: "resolve directory", Path: path, Err: err}
	}
	if n == 0 || n >= uint32(len(buffer)) {
		return "", fmt.Errorf("目录实际路径长度无效：%s", path)
	}
	resolved := windows.UTF16ToString(buffer[:n])
	// Callers include SQLite URI construction, which requires a normal DOS/UNC
	// path. Every input spelling has already been normalized by the handle API.
	if strings.HasPrefix(resolved, `\\?\UNC\`) {
		return `\\` + strings.TrimPrefix(resolved, `\\?\UNC\`), nil
	}
	return strings.TrimPrefix(resolved, `\\?\`), nil
}

// IsLink includes Windows reparse points such as directory junctions.
func IsLink(info os.FileInfo) bool {
	if info.Mode()&os.ModeSymlink != 0 {
		return true
	}
	attributes, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return ok && attributes.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// Identity identifies the existing directory object across renames and restarts.
func Identity(path string) (string, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	handle, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "identify directory", Path: path, Err: err}
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x:%x:%x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}
