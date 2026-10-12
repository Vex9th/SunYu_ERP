package distribution

import (
	_ "embed"
	"encoding/json"
	"errors"
)

// The published Python 1.3.1 component addresses/hashes are frozen here. Native
// packages must never be offered as Python components to the old installer.
//
//go:embed legacy-catalog.json
var legacyCatalogJSON []byte

func writeLegacyCatalog(path, version string) error {
	var catalog struct {
		Format     int             `json:"format"`
		Version    string          `json:"version"`
		Notes      string          `json:"notes"`
		Components json.RawMessage `json:"components"`
	}
	if err := json.Unmarshal(legacyCatalogJSON, &catalog); err != nil {
		return err
	}
	if catalog.Format != 1 || catalog.Version != "1.3.1" {
		return errors.New("内置旧版更新清单无效")
	}
	catalog.Version = version
	catalog.Notes = "Go 原生版 " + version + " 已发布。1.3.1 目录版请下载 " + releaseURL + "v" + version + "/update.exe，将它放在旧程序目录双击运行，并长期保留。迁移保留 Data（含自定义数据目录）和 config.json，完成后通过程序内的一键更新继续升级。当前旧版前后端组件保持 1.3.1，不会把原生更新包交给旧安装流程。"
	return writeJSON(path, catalog)
}
