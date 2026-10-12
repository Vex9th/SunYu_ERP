# SunYu ERP

面向个人使用的非标工业项目管理系统，覆盖项目资料、报价合同、采购库存、施工、收付款、成本和售后。

## 下载与使用

1. 从 [最新版本](https://github.com/Vex9th/SunYu_ERP/releases/latest) 下载 `SunYu_ERP-windows-x64.zip`。
2. 解压到 Windows 本机可写目录，双击 `SunYu_ERP.exe`；服务就绪后自动打开浏览器，并驻留系统托盘。
3. 再次双击 EXE 会打开已有服务页面，不会重复启动。托盘菜单可以打开页面或退出程序；关闭网页不会停止服务。
4. 本机默认地址为 `http://127.0.0.1:8765`，局域网其他设备访问 `http://服务器IP:8765`。首次进入设置 6 位数字密码。

无需安装 Python、Node.js 或 Go。请保留解压后的完整目录，`SunYu_ERP.exe` 需要同目录的 `runtime/`、`updater/` 和 `releases/`。防火墙只允许专用网络，仅供可信局域网使用，不要直接暴露到公网。

## 数据与备份

- `Data/`：数据库和项目文件。
- `config.json`：本机配置；修改前先停止服务。
- 备份目录可在系统设置中配置；数据库应保存在本机，勿放入 NAS 或同步盘。

升级前停止服务并备份数据，保留原有 `Data/` 和 `config.json`。

## 可选更新

系统设置中的“版本与更新”支持检查官方 GitHub Releases、下载组件包和导入可信的离线组件 ZIP。自动检查只显示提醒，不会自动下载或安装；可以稍后处理、忽略版本或关闭提醒。只有登录后的本机连接可以安装更新，局域网其他设备只能查看状态。

前端更新后按页面提示刷新；有未保存内容时先保存或取消编辑。后端更新会短暂进入维护模式并重启服务，更新前自动备份数据库、项目文件和配置。若自动恢复失败，保留更新提示和备份，由维护人员处理。

更新下载会校验 HTTPS 证书，并同时使用系统信任库和随包提供的公共根证书。使用 Clash 等代理时，请让 `localhost`、`127.0.0.1`、`::1` 的本机访问绕过代理。若仍提示证书错误，检查系统时间、根证书及代理/安全软件的 HTTPS 检查设置；不要关闭证书校验，也可以通过可信渠道下载官方组件包后离线导入。

1.3.1 更换了托盘启动器和带 CA 证书的运行环境，从 1.3.0 升级需先退出程序、备份并覆盖完整包。保留 `Data/`、`config.json` 和 `installation.json`；启动后在“版本与更新”分别安装前端、后端 1.3.1，也可导入对应组件包。完整包覆盖不会自动改变已有的组件版本选择。

首次从旧版单文件升级：关闭旧程序、备份数据后，将完整目录包解压到原程序所在目录，沿用原有 `Data/` 和 `config.json`。首次启动会根据 `installation.default.json` 生成 `installation.json`，之后该文件记录当前前后端版本；不要删除或用默认清单覆盖它。运行环境或更新器需要升级时使用完整安装包，并按对应版本说明处理。组件包不能替代完整安装包。

## 开发

React + TypeScript（strict）+ Ant Design + Vite，Python 3.13 + FastAPI，SQLite。
开发环境使用 Node.js 22.12+（或 24+），沿用 npm 与锁文件。
安装 `requirements-dev.txt` 和 `frontend/package-lock.json` 对应依赖后，运行 `python dev.py`。

前端结构、验证命令和迁移说明见 [frontend/README.md](frontend/README.md)。

[MIT License](LICENSE)

## 构建与发布

普通 CI 检查主分支推送和 PR，同一分支的新运行会取消过期运行；标签不会重复触发测试。

在 Actions 中手动运行 **Windows Release**，填写 `version`（例如 `v1.3.1`）即可在测试、完整目录启动、业务持久化及组件升级恢复验证通过后发布。版本号留空时只上传候选构建产物。不要再单独推送标签或提前创建正式 Release。

同一提交的完整版本会直接跳过；未完成的草稿可重跑续传；已有标签指向不同提交时会停止，避免覆盖旧版本。正式附件包括 Windows 完整包、前后端组件 ZIP、`update-manifest.json` 和 `SHA256SUMS.txt`。SHA256 用于完整性检查，离线包仍应来自可信发布来源。

本地 Windows 构建使用 Python 3.13、Node.js 22.12+ 和 Go；安装项目开发依赖后在 PowerShell 执行：

```powershell
$env:SUNYU_VERSION = '1.3.1'
npm --prefix frontend run build
python -m PyInstaller --clean --noconfirm SunYu_ERP.spec
Push-Location launcher
go test ./...
go build -trimpath -ldflags="-s -w -H=windowsgui" -o ../dist/SunYu_ERP.exe .
Pop-Location
python scripts/build_modular.py --version 1.3.1 --output dist/modular
python .github/scripts/modular_smoke.py --package-dir dist/modular/SunYu_ERP --output tmp/modular-smoke
```

构建脚本也接受 `--runtime-dir` 和 `--launcher` 指定已有产物；为保护已有安装和已验证附件，输出中存在同名产物时会停止，请为每批构建使用新目录。`dist/modular/SunYu_ERP/` 是完整安装目录，其旁边是可交付 ZIP 与校验清单。源码运行 `python release.py` 保留原有开发兼容入口。
