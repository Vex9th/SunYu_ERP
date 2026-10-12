package update

import (
	_ "embed"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

//go:embed legacy-files.json
var legacyDistribution []byte

// Legacy deletion is restricted to known Python-distribution files. Unknown files are preserved.
func legacyInventory(root string) (map[string]string, error) {
	for _, name := range []string{"transaction.json", "pending.json"} {
		if _, err := os.Lstat(filepath.Join(root, ".updates", name)); err == nil {
			return nil, errors.New("旧版存在未完成的更新，请先运行旧启动器完成恢复，再执行原生迁移")
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	var installation struct {
		Format         int    `json:"format"`
		Backend        string `json:"backend"`
		Frontend       string `json:"frontend"`
		APIVersion     int    `json:"api_version"`
		RuntimeVersion int    `json:"runtime_version"`
	}
	if err := readJSON(filepath.Join(root, "installation.json"), &installation); err != nil {
		return nil, errors.New("未找到受支持的旧版安装清单，请将迁移工具放在原 SunYu_ERP.exe 所在目录")
	}
	if installation.Format != 1 || installation.APIVersion != 1 || installation.RuntimeVersion != 1 || !versionPattern.MatchString(installation.Backend) || !versionPattern.MatchString(installation.Frontend) {
		return nil, errors.New("旧版安装协议不受支持")
	}
	boundary, err := readDataBoundary(root)
	if err != nil {
		return nil, err
	}
	files := map[string]string{}
	add := func(rel string) error {
		if !validPath(rel) {
			return errors.New("旧版清单路径无效")
		}
		p, err := safePath(root, rel)
		if err != nil {
			return err
		}
		if boundary.protects(rel) {
			return nil
		}
		info, err := os.Lstat(p)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		h, err := hashFile(p)
		if err != nil {
			return err
		}
		files[rel] = h
		return nil
	}
	for _, p := range []string{"installation.json"} {
		if err = add(p); err != nil {
			return nil, err
		}
	}
	for _, component := range []string{"frontend", "backend"} {
		base := filepath.Join(root, "releases", component)
		entries, _ := os.ReadDir(base)
		for _, entry := range entries {
			if !entry.IsDir() || !versionPattern.MatchString(entry.Name()) {
				continue
			}
			prefix := "releases/" + component + "/" + entry.Name() + "/"
			var manifest struct {
				Format      int               `json:"format"`
				Application string            `json:"application"`
				Component   string            `json:"component"`
				Version     string            `json:"version"`
				Files       map[string]string `json:"files"`
			}
			if readJSON(filepath.Join(base, entry.Name(), ".update-manifest.json"), &manifest) != nil || manifest.Format != 1 || manifest.Application != Application || manifest.Component != component || manifest.Version != entry.Name() {
				continue
			}
			for p, h := range manifest.Files {
				if !validPath(p) || !hashPattern.MatchString(strings.ToLower(h)) {
					return nil, errors.New("旧版本受管清单无效")
				}
				rel := prefix + p
				full, err := safePath(root, rel)
				if err != nil {
					return nil, err
				}
				actual, err := hashFile(full)
				if err == nil && strings.EqualFold(actual, h) {
					if err = add(rel); err != nil {
						return nil, err
					}
				}
			}
			if err = add(prefix + ".update-manifest.json"); err != nil {
				return nil, err
			}
		}
	}
	var trusted struct {
		Files map[string][]string `json:"files"`
	}
	if err = json.Unmarshal(legacyDistribution, &trusted); err != nil {
		return nil, err
	}
	for rel, hashes := range trusted.Files {
		if !validPath(rel) {
			return nil, errors.New("内置旧发行清单路径无效")
		}
		p, err := safePath(root, rel)
		if err != nil {
			return nil, err
		}
		h, err := hashFile(p)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, expected := range hashes {
			if h == expected {
				if err = add(rel); err != nil {
					return nil, err
				}
				break
			}
		}
	}

	return files, nil
}

// Old Python snapshots did not carry application IDs. Require the exact historical
// directory shape, matching data root and a complete verified inventory before collecting them.
func (e *Engine) legacyBackupFiles(dataDir string) (map[string]string, error) {
	out := map[string]string{}
	physicalData, err := comparisonPath(dataDir)
	if err != nil {
		return nil, err
	}
	base, err := safePath(e.Root, ".updates/backups")
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(base)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("旧版升级备份路径不是目录，已保留原文件")
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || len(entry.Name()) != 32 {
			continue
		}
		validID := true
		for _, r := range entry.Name() {
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
				validID = false
			}
		}
		if !validID {
			continue
		}
		dir := filepath.Join(base, entry.Name())
		var metadata struct {
			DataDir string            `json:"data_dir"`
			Files   map[string]string `json:"files"`
		}
		if readJSON(filepath.Join(dir, "backup.json"), &metadata) != nil || len(metadata.Files) == 0 {
			continue
		}
		if !filepath.IsAbs(metadata.DataDir) {
			continue
		}
		physicalSnapshotData, err := comparisonPath(metadata.DataDir)
		if err != nil || !inside(physicalData, physicalSnapshotData) || !inside(physicalSnapshotData, physicalData) {
			continue
		}
		actual, _, err := treeInventory(dir)
		if err != nil || len(actual) != len(metadata.Files)+1 {
			continue
		}
		valid := true
		for p, h := range metadata.Files {
			if !validPath(p) || (p != "config.json" && !strings.HasPrefix(p, "Data/")) || !hashPattern.MatchString(h) || actual[p] != h {
				valid = false
				break
			}
		}
		if !valid || actual["backup.json"] == "" {
			continue
		}
		for p, h := range actual {
			out[".updates/backups/"+entry.Name()+"/"+p] = h
		}
	}
	return out, nil
}
