package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sunyu.local/updater/internal/pathidentity"
)

func readJSON(p string, v any) error {
	f, e := openStateFile(p)
	if e != nil {
		return e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 8<<20+1))
	if e != nil {
		return e
	}
	if len(b) > 8<<20 {
		return errors.New("更新状态过大")
	}
	return json.Unmarshal(b, v)
}
func writeJSON(p string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return atomicBytes(p, append(b, '\n'), 0600)
}
func atomicBytes(p string, b []byte, mode os.FileMode) error {
	if e := os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(p), ".write-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	e = f.Chmod(mode)
	if e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e == nil {
		e = replaceStateFile(f.Name(), p)
	}
	return e
}
func copyFile(src, dst string) error {
	f, e := os.Open(src)
	if e != nil {
		return e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() {
		return errors.New("拒绝非普通文件")
	}
	if e = os.MkdirAll(filepath.Dir(dst), 0700); e != nil {
		return e
	}
	out, e := os.CreateTemp(filepath.Dir(dst), ".copy-*")
	if e != nil {
		return e
	}
	defer os.Remove(out.Name())
	_, e = io.Copy(out, f)
	if e == nil {
		e = out.Chmod(info.Mode().Perm())
	}
	if e == nil {
		e = out.Sync()
	}
	ce := out.Close()
	if e == nil {
		e = ce
	}
	if e == nil {
		e = replaceStateFile(out.Name(), dst)
	}
	return e
}
func inside(parent, child string) bool {
	r, e := filepath.Rel(parent, child)
	return e == nil && (r == "." || r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)))
}
func resolveMissing(p string) (string, error) {
	var tail []string
	for {
		resolved, e := pathidentity.ResolveExisting(p)
		if e == nil {
			for i := len(tail) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, tail[i])
			}
			return resolved, nil
		}
		if !os.IsNotExist(e) || filepath.Dir(p) == p {
			return "", e
		}
		tail = append(tail, filepath.Base(p))
		p = filepath.Dir(p)
	}
}
func noLinks(p string) error {
	for {
		i, e := os.Lstat(p)
		if e == nil && pathidentity.IsLink(i) {
			return errors.New("更新受管路径不能是链接")
		}
		if e != nil && !os.IsNotExist(e) {
			return e
		}
		n := filepath.Dir(p)
		if n == p {
			return nil
		}
		p = n
	}
}
