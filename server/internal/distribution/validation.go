package distribution

import (
	"debug/pe"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

func emptyOutput(p string) error {
	i, err := os.Lstat(p)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !i.IsDir() || i.Mode()&os.ModeSymlink != 0 {
		return errors.New("output 必须是不存在的目录或空目录，不能是符号链接")
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		return err
	}
	if len(entries) > 0 {
		return errors.New("output 已有文件，拒绝覆盖；请选择新的输出目录")
	}
	return nil
}
func resolvedMissingDirectory(p string) (string, error) {
	resolved, err := filepath.EvalSymlinks(p)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	parent := filepath.Dir(p)
	if parent == p {
		return "", err
	}
	resolved, err = resolvedMissingDirectory(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(p)), nil
}
func inside(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && (rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
func openRegular(root *os.Root, name string) (*os.File, error) {
	i, err := root.Lstat(filepath.FromSlash(name))
	if err != nil {
		return nil, err
	}
	if !i.Mode().IsRegular() {
		return nil, fmt.Errorf("只允许普通文件，拒绝链接：%s", name)
	}
	f, err := root.Open(filepath.FromSlash(name))
	if err != nil {
		return nil, err
	}
	actual, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if !actual.Mode().IsRegular() || !os.SameFile(i, actual) {
		f.Close()
		return nil, fmt.Errorf("读取时文件发生替换：%s", name)
	}
	return f, nil
}
func validateAMD64(f *os.File) error {
	var dos [2]byte
	if _, err := f.ReadAt(dos[:], 0); err != nil || string(dos[:]) != "MZ" {
		return errors.New("不是 Windows PE 可执行文件")
	}
	p, err := pe.NewFile(f)
	if err != nil {
		return fmt.Errorf("读取 PE 失败: %w", err)
	}
	if p.Machine != pe.IMAGE_FILE_MACHINE_AMD64 {
		return errors.New("PE 架构必须为 AMD64")
	}
	h, ok := p.OptionalHeader.(*pe.OptionalHeader64)
	if !ok || h.Magic != 0x20b || p.Characteristics&0x2 == 0 || p.Characteristics&0x2000 != 0 {
		return errors.New("必须是 PE32+ EXE，不能是 DLL 或对象文件")
	}
	return nil
}
func frontendFiles(root *os.Root) ([]string, error) {
	files := []string{}
	err := fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if name == "." {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("前端构建中存在符号链接：%s", name)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("前端构建中存在特殊文件：%s", name)
		}
		files = append(files, name)
		return nil
	})
	sort.Strings(files)
	return files, err
}

var htmlTags = regexp.MustCompile(`(?is)<(?:script|link|img|source)\b[^>]*>`)
var htmlAttributes = regexp.MustCompile(`(?i)\b(src|href)\s*=\s*["']([^"']+)["']`)

func validateFrontend(root *os.Root, files []string, version string) error {
	f, err := openRegular(root, "index.html")
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 4<<20+1))
	if err != nil {
		return err
	}
	if len(b) > 4<<20 || !utf8.Valid(b) {
		return errors.New("前端 index.html 大小或编码无效")
	}
	known := map[string]bool{}
	for _, name := range files {
		known[name] = true
	}
	prefix := "/__frontend/" + version + "/"
	scripts := 0
	for _, tag := range htmlTags.FindAllString(string(b), -1) {
		for _, attribute := range htmlAttributes.FindAllStringSubmatch(tag, -1) {
			value := html.UnescapeString(attribute[2])
			if strings.HasPrefix(value, "data:") {
				continue
			}
			u, err := url.Parse(value)
			if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(u.Path, prefix) {
				return fmt.Errorf("前端资源必须使用 %sassets/ 路径：%s", prefix, value)
			}
			rel := strings.TrimPrefix(u.Path, prefix)
			if !known[rel] {
				return fmt.Errorf("前端引用的资源不存在：%s", value)
			}
			if strings.HasPrefix(strings.ToLower(tag), "<script") && strings.EqualFold(attribute[1], "src") {
				if !strings.HasPrefix(rel, "assets/") {
					return errors.New("前端脚本必须放在版本化 assets 目录")
				}
				scripts++
			}
		}
	}
	if scripts == 0 {
		return errors.New("前端 index.html 未引用版本化脚本；请先使用 SUNYU_VERSION 构建")
	}
	return nil
}
