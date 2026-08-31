# SunYu ERP

面向个人使用的非标工业项目经营与交付管理系统。

系统以项目为主线，覆盖公司联系人、规划测绘、报价合同、工程版本、采购库存、施工人员、三段收款、项目成本、验收质保和售后记录。

## 当前状态

当前代码已经实现：

- 登录认证；
- 公司与联系人管理；
- 项目建档、编辑、完结、18 阶段和项目/总仪表台；
- 项目文档上传、下载、编辑、归档和多版本保存；
- 报价、合同、预付款/进度款/尾款计划与实际到账；
- Excel 采购清单预检与确认、采购单、付款、到货、进项票和隐藏成本报价单；
- 库存档案、调整、到货入库、项目领用和不可变流水；
- 施工员、项目排单、当天批量上工、施工日报和人员垫资报销；
- 图纸会签、调试、工程变更、验收、质保、发票和售后；
- 项目成本、利润、逾期收款、近期交付和待办聚合；
- 本机配置、SQLite 数据库迁移和备份；
- Vue 生产构建由 FastAPI 同源提供；
- Windows x64 单文件 EXE 的 GitHub Actions 构建、启动和重启冒烟测试。

当前页面默认连接真实后端，不会在接口失败时回退到演示数据。单条上工编辑/作废没有单独入口；当天纠错使用批量上工再次提交覆盖。

## Windows Release

Release 面向一台长期运行的 Windows x64 主机。浏览器通过可信局域网访问这台主机；客户端不需要安装 Node.js 或 Python。

### 首次安装

1. 从 GitHub Release 或手动工作流的 Artifact 下载 `SunYu_ERP-windows-x64.zip`。
2. 解压到当前 Windows 用户可写的本机目录，例如 `D:\SunYu ERP`。目录名可以包含中文和空格。
3. 双击 `start.bat`。程序首次启动会在 EXE 同目录生成 `config.json` 和 `Data`。
4. Windows 防火墙询问时，只允许「专用网络」。
5. 在同一局域网的浏览器访问 `http://服务器IP:8765`，首次进入时设置 6 位数字密码。

`start.bat` 会保留 CMD 窗口。日常使用时继续通过它启动，并保持窗口开启；按 `Ctrl+C` 可停止服务。

Release 默认监听 `0.0.0.0:8765`。如需修改监听地址、端口或备份位置，先停止服务，再编辑 `config.json`。`config.example.json` 展示了所有常用配置项；也可以在首次启动前复制为 `config.json`，程序会自动补充随机 `session_secret`。

### 数据位置

相对路径始终以 EXE 和 `config.json` 所在目录为基准：

- `config.json`：本机配置和随机会话密钥；
- `Data/iapm.sqlite`：SQLite 主数据库；
- `Data/Projects`：项目文件目录，在保存项目文件时创建；
- `Backups`：示例配置中的默认备份目录。

不要把 `Data/iapm.sqlite` 放到 NAS、SMB 共享或同步盘中。需要群晖同步时，应把 `backup_dir` 配置为 Windows 上的本地群晖同步目录，由同步客户端上传备份文件。

### 网络安全边界

当前 Release 只适合本人控制的可信局域网。不要做公网端口映射，不要把 8765 端口直接暴露到互联网。公网访问需要额外的 HTTPS、反向代理、访问控制和安全运维，这些能力当前没有实现。

## 本地开发

环境要求：

- Python 3.13；
- Node.js 22；
- npm。

首次准备：

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --requirement requirements-dev.txt
npm --prefix frontend ci
```

Windows PowerShell 使用 `.venv\Scripts\Activate.ps1` 激活虚拟环境；Windows CMD 使用 `.venv\Scripts\activate.bat`。

日常开发仍使用：

```bash
python dev.py
```

开发入口为 Vite `http://localhost:5173`，后端 API 为 `http://localhost:8765`。开发模式不会由 FastAPI 托管 `frontend/dist`。

常用验证命令：

```bash
python -m pytest
python -m ruff check .
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

## 构建与发布

- `.github/workflows/ci.yml` 在 push 和 pull request 时运行后端测试、Ruff、前端测试、类型检查和构建。
- `.github/workflows/release.yml` 在 `v*` tag 或手动触发时，使用 `windows-latest` 完成全量检查、Vue 构建、PyInstaller 单文件打包和真实 EXE 冒烟测试。
- 手动触发只上传 Artifact；推送 `v*` tag 时还会通过 `gh release create --verify-tag --generate-notes` 创建 GitHub Release。

发布压缩包只包含 `SunYu_ERP.exe`、`start.bat`、`README.md`、`LICENSE` 和 `config.example.json`，不包含开发依赖、测试、`Data` 或真实 `config.json`。

PyInstaller onefile 会把只读资源解压到临时目录。程序只从该目录读取数据库迁移和 `frontend/dist`；所有持久化写入都以 EXE 同目录为根，不写入临时资源目录。

## 技术栈

- 前端：Vue 3、TypeScript、Vite、Element Plus
- 后端：Python、FastAPI
- 数据库：SQLite 单文件
- 部署：单台 Windows 主机提供局域网网页
- 备份：写入用户指定的本机群晖同步目录
- 发布：GitHub Actions、PyInstaller onefile

## 数据安全

本仓库只保存源代码、数据库迁移脚本、虚构测试数据和面向使用者的文档。

真实客户资料、项目文件、SQLite 数据库、备份文件、本机配置、密码和内部开发资料不得提交到 Git。

## 许可证

本项目采用 [MIT License](LICENSE)。
