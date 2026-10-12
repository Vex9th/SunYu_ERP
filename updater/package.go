package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const maxArchive int64 = 2 << 30

var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$`)

type Archive struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}
type Manifest struct {
	Format      int               `json:"format"`
	Application string            `json:"application"`
	Version     string            `json:"version"`
	Archive     Archive           `json:"archive"`
	Files       map[string]string `json:"files"`
}

func sumBytes(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
func hashFile(p string) (string, error) {
	f, e := os.Open(p)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil {
		return "", e
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func officialURL(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "https" && u.Host == "github.com" && u.User == nil && u.Fragment == "" && u.RawQuery == "" && strings.HasPrefix(u.Path, "/Vex9th/SunYu_ERP/releases/")
}
func (m Manifest) Validate() error {
	if m.Format != 1 || m.Application != "SunYu_ERP" || !validVersion(m.Version) {
		return errors.New("官方更新清单格式或版本无效")
	}
	expected := "https://github.com/Vex9th/SunYu_ERP/releases/download/v" + m.Version + "/SunYu_ERP-windows-x64.zip"
	if m.Archive.URL != expected || !officialURL(m.Archive.URL) || !hashPattern.MatchString(m.Archive.SHA256) {
		return errors.New("更新包来源或SHA256无效")
	}
	if len(m.Files) != 2 {
		return errors.New("更新清单只能包含主程序和更新器")
	}
	for _, p := range []string{"SunYu_ERP.exe", "update.exe"} {
		if !hashPattern.MatchString(m.Files[p]) {
			return errors.New("更新清单缺少程序校验值")
		}
	}
	return nil
}

var zipAllowed = map[string]bool{"SunYu_ERP.exe": true, "update.exe": true, "start.bat": true, "README.md": true, "LICENSE": true, "config.example.json": true}

func extractPackage(archive, stage string, m Manifest) error {
	if err := m.Validate(); err != nil {
		return err
	}
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	seen := map[string]bool{}
	var total uint64
	for _, entry := range r.File {
		if !zipAllowed[entry.Name] || seen[entry.Name] || !entry.Mode().IsRegular() {
			return fmt.Errorf("拒绝更新包中的非白名单或重复文件：%s", entry.Name)
		}
		seen[entry.Name] = true
		total += entry.UncompressedSize64
		if total > 4<<30 || entry.UncompressedSize64 > uint64(maxArchive) {
			return errors.New("更新包解压大小超过限制")
		}
	}
	for p := range m.Files {
		if !seen[p] {
			return fmt.Errorf("更新包缺少%s", p)
		}
	}
	if err = os.MkdirAll(stage, 0700); err != nil {
		return err
	}
	for _, entry := range r.File {
		want, managed := m.Files[entry.Name]
		if !managed {
			continue
		}
		src, err := entry.Open()
		if err != nil {
			return err
		}
		dst, err := os.OpenFile(filepath.Join(stage, entry.Name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			src.Close()
			return err
		}
		n, copyErr := io.Copy(dst, io.LimitReader(src, maxArchive+1))
		src.Close()
		if copyErr == nil && n > maxArchive {
			copyErr = errors.New("解压文件过大")
		}
		if copyErr == nil {
			copyErr = dst.Sync()
		}
		closeErr := dst.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		got, err := hashFile(filepath.Join(stage, entry.Name))
		if err != nil || got != want {
			return fmt.Errorf("更新文件SHA256不匹配：%s", entry.Name)
		}
	}
	return nil
}
