# SunYu ERP

面向个人使用的非标工业项目管理系统，覆盖项目资料、报价合同、采购库存、施工、收付款、成本和售后。

## 下载与使用

1. 从 [最新版本](https://github.com/Vex9th/SunYu_ERP/releases/latest) 下载 `SunYu_ERP-windows-x64.zip`。
2. 解压到 Windows 本机可写目录，双击 `SunYu_ERP.exe`。服务就绪后自动打开浏览器，程序驻留系统托盘。
3. 再次双击 EXE 会打开已有服务页面。托盘菜单可打开页面或退出程序；关闭网页不会停止服务。
4. 默认本机地址为 `http://127.0.0.1:8765`，局域网访问 `http://服务器IP:8765`。首次进入设置 6 位数字密码。

2.0 起后端、启动器和更新器均为 Go 原生程序，无需安装 Python、Node.js、Go 或额外运行库。请保留完整安装目录：

```text
SunYu_ERP/
├── SunYu_ERP.exe          # 日常启动入口、托盘和服务管理
├── app/                  # 当前服务、升级组件、前端资源与校验清单
├── Data/                 # 首次运行创建；数据库和项目文件
├── config.json           # 首次运行创建；本机配置
└── .updates/             # 更新状态与最近一次恢复备份
```

业务数据目录以现有 `config.json` 为准，支持原有自定义目录。防火墙只允许专用网络，仅供可信局域网使用，不要直接暴露到公网。

## 从 1.3.1 升级到 2.0

这是一次运行环境迁移，旧版更新器无法替换自身及 Python 运行库。使用本版本的独立升级助手完成一次迁移：

1. 保存工作，从托盘退出旧程序；另行备份原 `Data/`（或自定义数据目录）和 `config.json`。
2. 下载官方 `SunYu_ERP_Upgrade.exe`，放入**原程序目录**，与原 `SunYu_ERP.exe`、`config.json` 同级。
3. 双击升级助手。它显示执行阶段，自动下载、核验、备份和升级；失败时保留错误信息。成功后用原目录的 `SunYu_ERP.exe` 启动。

迁移完成后，临时放在根目录的 `SunYu_ERP_Upgrade.exe` 可以删除；之后使用页面的一键更新，所需更新组件已随程序放在 `app/` 中。

上述步骤针对带 `installation.json` 的 1.3.1 目录包。更早的单文件版本请先按 1.3.1 发布说明升级到目录包，再执行本次迁移。

不要先覆盖旧目录的程序文件，也不要删除 `installation.json` 或原数据来“重置”安装。升级助手需要原有安装信息完成校验与恢复。现有 SQLite 迁移编号、密码、采购含税金额、付款、发票和公司往来账的业务计算规则保持兼容；升级不主动重算历史金额。

官方 1.3.0、1.3.1 中可以识别的旧程序文件会按清单和哈希清理。用户自行放入或修改过的文件会保留，避免按目录名误删资料。迁移失败且自动恢复未完成时，保留 `.updates/`，再次运行升级助手处理恢复。

## 一键更新

在运行服务的本机登录，进入“系统设置 → 版本与更新”，点击 **一键更新**。程序自动检查、下载、校验、备份并安装，不再要求分别下载和安装前后端。

- 自动检查只提醒，可以关闭、忽略版本或稍后处理；不会强制安装或刷新。
- 前端独立更新时服务继续运行。保存当前页面的工作后，点击“刷新使用新版本”。
- 服务或启动器更新时会短暂停止接收业务写入并重启，页面恢复连接后自动核对原更新任务。
- 已完成更新会清理受管旧程序和下载缓存，只保留最近一次升级恢复备份。业务备份按照系统设置单独保留；被占用的旧文件留待后续重试清理。
- 局域网其他设备可查看状态和检查更新，安装只接受登录后的本机同源请求。

无法直接下载时，可在“无法在线更新时”选择官方组件 ZIP。完全离线时，本机必须已成功检查过对应版本，取得官方校验信息。安装包不含用户数据；请勿把组件 ZIP 手工解压覆盖到程序目录。

Windows 更新下载使用系统信任库并支持系统代理，保留 HTTPS 证书校验。使用 Clash 等代理时，让 `localhost`、`127.0.0.1`、`::1` 绕过代理。证书错误时检查系统时间、根证书和代理的 HTTPS 检查设置。

## 数据与备份

`Data/` 保存数据库和项目文件，`config.json` 保存本机配置。修改配置前先停止服务。数据库保存在本机磁盘，勿放入 NAS 或同步盘；独立备份目录可以在系统设置中配置。

`.updates/` 中的恢复备份服务于软件升级，不能替代日常业务备份。不要在更新或恢复期间手工删除该目录。

## 开发

前端为 React + TypeScript strict + Ant Design + Vite；后端为 Go + SQLite。使用 `server/go.mod` 指定的 Go 工具链，以及 Node.js 22.12+ 或 24+。沿用 npm 锁文件。

分别在两个终端运行：

```sh
cd server
go run ./cmd/service --root ../tmp/dev --listen 127.0.0.1:8765
```

```sh
cd frontend
npm ci
npm run dev
```

开发数据保存在 `tmp/dev`，不读取客户安装目录。检查命令：

```sh
cd server
go test ./...
go vet ./...
```

```sh
cd frontend
npm run typecheck
npm test -- --maxWorkers=1
npm run build
```

代码集中在 `server/internal/`，按 API、配置、数据库、生命周期、更新和打包划分职责。`server/migrations/` 保留原有 SQL 迁移。前端说明见 [frontend/README.md](frontend/README.md)，业务契约见 [docs/api-contract.md](docs/api-contract.md)。

## 构建与发布

普通 CI 检查主分支推送和 PR，同一分支的新运行取消过期运行。发布仅由 Actions 中手动运行 **Windows Release** 触发：填写如 `v2.0.0` 的版本号发布正式版，留空只生成候选产物。

工作流执行 Go 和前端测试、类型检查、Windows 原生编译、成品启动、重复启动及升级验证后才允许发布。同一提交的完整版本直接跳过；未完成草稿可续传；标签指向不同提交时停止。不要提前创建正式 Release。

本地 Windows 构建示例（项目根目录 PowerShell）：

```powershell
$env:SUNYU_VERSION = '2.0.0'
$env:CGO_ENABLED = '0'
npm --prefix frontend ci
npm --prefix frontend run build
New-Item -ItemType Directory -Path dist/native-bin -Force | Out-Null
Push-Location server
go build -trimpath -ldflags="-s -w -H=windowsgui -X main.version=$env:SUNYU_VERSION" -o ../dist/native-bin/SunYu_ERP.exe ./cmd/launcher
go build -trimpath -ldflags="-s -w -H=windowsgui -X main.version=$env:SUNYU_VERSION" -o ../dist/native-bin/SunYuService.exe ./cmd/service
go build -trimpath -ldflags="-s -w -X main.version=$env:SUNYU_VERSION" -o ../dist/native-bin/SunYu_ERP_Upgrade.exe ./cmd/upgrade
go run ./cmd/package --version $env:SUNYU_VERSION --bin-dir ../dist/native-bin --web-dir ../frontend/dist --output ../dist/native --notes (Get-Content ../RELEASE_NOTES.md -Raw -Encoding utf8)
Pop-Location
node .github/scripts/native-smoke.mjs dist/native/SunYu_ERP tmp/native-smoke $env:SUNYU_VERSION
```

每批使用新的输出目录，打包器拒绝覆盖已有产物。发布附件包括完整 ZIP、应用更新 ZIP、前端更新 ZIP、升级助手、两代更新目录和 `SHA256SUMS.txt`。旧版 `update-manifest.json` 仅提供迁移说明，不会把 Go 包交给 Python 组件更新器；新程序使用 `update-manifest-v2.json`。

[MIT License](LICENSE)
