// Package update owns the native distribution manifest and durable install transactions.
package update

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"sunyu.local/erp/internal/pathidentity"
)

const Application = "SunYu_ERP"
const MaxArchiveBytes int64 = 2 << 30
const maxExtractBytes uint64 = 8 << 30

var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Manifest struct {
	Format          int               `json:"format"`
	Application     string            `json:"application"`
	Version         string            `json:"version"`
	BackendVersion  string            `json:"backend_version"`
	FrontendVersion string            `json:"frontend_version"`
	LauncherVersion string            `json:"launcher_version"`
	APIVersion      int               `json:"api_version"`
	Component       string            `json:"component,omitempty"`
	Files           map[string]string `json:"files"`
}
type Archive struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}
type Catalog struct {
	Format          int                `json:"format"`
	Application     string             `json:"application"`
	Version         string             `json:"version"`
	BackendVersion  string             `json:"backend_version"`
	FrontendVersion string             `json:"frontend_version"`
	LauncherVersion string             `json:"launcher_version"`
	APIVersion      int                `json:"api_version"`
	Notes           string             `json:"notes"`
	Packages        map[string]Archive `json:"packages"`
}

func validPath(p string) bool {
	if p == "" || strings.ContainsAny(p, "\\:\x00<>\"|?*") || strings.HasPrefix(p, "/") || path.Clean(p) != p {
		return false
	}
	for _, r := range p {
		if r < 32 {
			return false
		}
	}
	for _, part := range strings.Split(p, "/") {
		if part == "." || part == ".." || strings.TrimRight(part, ". ") != part || len(part) > 240 {
			return false
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || regexp.MustCompile(`^(COM|LPT)[1-9]$`).MatchString(base) {
			return false
		}
	}
	return true
}
func managedPath(p string) bool {
	return p == "update.exe" || p == "SunYu_ERP.exe" || p == "app/SunYuService.exe" || strings.HasPrefix(p, "app/web/")
}
func (m Manifest) Validate() error {
	if m.Format != 2 || m.Application != Application || m.APIVersion != 1 {
		return errors.New("更新包格式或接口版本不兼容")
	}
	for _, v := range []string{m.Version, m.BackendVersion, m.FrontendVersion, m.LauncherVersion} {
		if !validVersion(v) {
			return errors.New("更新包版本无效")
		}
	}
	if m.Component != "" && m.Component != "application" && m.Component != "frontend" {
		return errors.New("更新包组件无效")
	}
	if len(m.Files) == 0 || len(m.Files) > 100000 {
		return errors.New("更新包文件数量无效")
	}
	seen := map[string]bool{}
	for p, h := range m.Files {
		if !validPath(p) || !managedPath(p) || !hashPattern.MatchString(h) {
			return fmt.Errorf("受管文件路径或散列无效：%s", p)
		}
		key := strings.ToLower(p)
		if seen[key] {
			return errors.New("更新包含大小写重复路径")
		}
		seen[key] = true
		if m.Component == "frontend" && !strings.HasPrefix(p, "app/web/"+m.FrontendVersion+"/") {
			return errors.New("前端包包含其它组件")
		}
	}
	if _, ok := m.Files["app/web/"+m.FrontendVersion+"/index.html"]; !ok {
		return errors.New("更新包缺少前端首页")
	}
	if m.Component == "application" {
		for _, p := range []string{"SunYu_ERP.exe", "app/SunYuService.exe", "update.exe"} {
			if _, ok := m.Files[p]; !ok {
				return fmt.Errorf("完整更新包缺少 %s", p)
			}
		}
	}
	return nil
}
func ReadManifest(root string) (Manifest, error) {
	var m Manifest
	b, e := readStateFile(filepath.Join(root, "app", "manifest.json"), 8<<20)
	if e != nil {
		return m, e
	}
	if len(b) > 8<<20 {
		return m, errors.New("安装清单过大")
	}
	if e = json.Unmarshal(b, &m); e != nil {
		return m, e
	}
	return m, m.Validate()
}
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
func safePath(root, rel string) (string, error) {
	if !validPath(rel) {
		return "", errors.New("不安全的文件路径")
	}
	current := root
	for _, part := range strings.Split(rel, "/") {
		current = filepath.Join(current, part)
		i, e := os.Lstat(current)
		if e == nil && pathidentity.IsLink(i) {
			return "", fmt.Errorf("拒绝符号链接：%s", rel)
		}
		if e != nil && !os.IsNotExist(e) {
			return "", e
		}
	}
	return filepath.Join(root, filepath.FromSlash(rel)), nil
}
func sortedKeys[V any](m map[string]V) []string {
	k := make([]string, 0, len(m))
	for p := range m {
		k = append(k, p)
	}
	sort.Strings(k)
	return k
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
	f, e := os.CreateTemp(filepath.Dir(p), ".update-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return replaceStateFile(f.Name(), p)
}
func copyFile(src, dst string) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	info, e := in.Stat()
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() {
		return errors.New("仅允许复制普通文件")
	}
	if e = os.MkdirAll(filepath.Dir(dst), 0700); e != nil {
		return e
	}
	out, e := os.CreateTemp(filepath.Dir(dst), ".update-*")
	if e != nil {
		return e
	}
	defer os.Remove(out.Name())
	_, e = io.Copy(out, in)
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
	if e != nil {
		return e
	}
	return os.Rename(out.Name(), dst)
}

// ExtractPackage validates every ZIP member before writing and verifies every digest.
func ExtractPackage(archive, dest string) (Manifest, error) {
	var m Manifest
	z, e := zip.OpenReader(archive)
	if e != nil {
		return m, e
	}
	defer z.Close()
	if len(z.File) > 100001 {
		return m, errors.New("更新包文件过多")
	}
	entries := map[string]*zip.File{}
	var total uint64
	for _, f := range z.File {
		name := f.Name
		if !validPath(name) || f.Mode()&os.ModeSymlink != 0 || f.FileInfo().IsDir() {
			return m, fmt.Errorf("更新包包含无效成员：%s", name)
		}
		key := strings.ToLower(name)
		if _, ok := entries[key]; ok {
			return m, errors.New("更新包包含重复成员")
		}
		entries[key] = f
		if f.UncompressedSize64 > maxExtractBytes-total {
			return m, errors.New("更新包解压大小超过限制")
		}
		total += f.UncompressedSize64
	}
	mf := entries["manifest.json"]
	if mf == nil || mf.Name != "manifest.json" || mf.UncompressedSize64 > 8<<20 {
		return m, errors.New("更新包缺少有效清单")
	}
	r, e := mf.Open()
	if e != nil {
		return m, e
	}
	b, e := io.ReadAll(io.LimitReader(r, 8<<20+1))
	r.Close()
	if e != nil {
		return m, e
	}
	if e = json.Unmarshal(b, &m); e != nil {
		return m, e
	}
	if e = m.Validate(); e != nil {
		return m, e
	}
	if m.Component == "" {
		return m, errors.New("更新包缺少组件类型")
	}
	if len(entries) != len(m.Files)+1 {
		return m, errors.New("更新包文件数量与清单不一致")
	}
	for _, p := range sortedKeys(m.Files) {
		f := entries[strings.ToLower("payload/"+p)]
		if f == nil || f.Name != "payload/"+p {
			return m, fmt.Errorf("更新包缺少 %s", p)
		}
		target, e := safePath(dest, p)
		if e != nil {
			return m, e
		}
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return m, e
		}
		source, e := f.Open()
		if e != nil {
			return m, e
		}
		out, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if e != nil {
			source.Close()
			return m, e
		}
		h := sha256.New()
		_, e = io.Copy(io.MultiWriter(out, h), source)
		ce := source.Close()
		if e == nil {
			e = ce
		}
		if e == nil {
			e = out.Sync()
		}
		ce = out.Close()
		if e == nil {
			e = ce
		}
		if e != nil {
			return m, e
		}
		if hex.EncodeToString(h.Sum(nil)) != m.Files[p] {
			return m, fmt.Errorf("文件校验失败：%s", p)
		}
	}
	return m, nil
}

// VerifyInstallation rejects mixed or incomplete program files before any service can migrate data.
func VerifyInstallation(root string) error {
	m, err := ReadManifest(root)
	if err != nil {
		return fmt.Errorf("程序安装清单缺失或损坏，请保留 DATA 和 config.json 后恢复完整程序：%w", err)
	}
	for _, required := range []string{"SunYu_ERP.exe", "app/SunYuService.exe", "update.exe"} {
		if _, ok := m.Files[required]; !ok {
			return fmt.Errorf("安装清单缺少程序文件：%s", required)
		}
	}
	for p, h := range m.Files {
		if strings.HasPrefix(p, "app/web/") && !strings.HasPrefix(p, "app/web/"+m.FrontendVersion+"/") {
			continue
		}
		target, err := safePath(root, p)
		if err != nil {
			return err
		}
		actual, err := hashFile(target)
		if err != nil || actual != h {
			return fmt.Errorf("程序文件缺失或版本混合，已阻止服务启动：%s", p)
		}
	}
	return nil
}
