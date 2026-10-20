# SunYu ERP

面向个人使用的非标工业项目管理系统，覆盖项目资料、报价合同、采购库存、施工、收付款、成本和售后。

当前版本为 **v1.2.8**：Python 单文件主程序，配套独立更新工具。采购单支持含税与未税单价双向输入，按所选税率自动关联并保留两位小数。

## 下载与使用

1. 从 [最新版本](https://github.com/Vex9th/SunYu_ERP/releases/latest) 下载 `SunYu_ERP-windows-x64.zip`。
2. 解压到 Windows 本机可写目录，双击 `start.bat`，保持窗口开启。
3. 本机访问 `http://127.0.0.1:8765`，局域网其他设备访问 `http://服务器IP:8765`。
4. 首次进入设置 6 位数字密码；停止服务按 `Ctrl+C`。

无需安装 Python 或 Node.js。防火墙只允许专用网络，仅供可信局域网使用，不要直接暴露到公网。

## 数据与备份

- `Data/`：数据库和项目文件。
- `config.json`：本机配置；修改前先停止服务。
- 备份目录可在系统设置中配置；数据库应保存在本机，勿放入 NAS 或同步盘。

升级前停止服务并备份数据，保留原有 `Data/` 和 `config.json`。

## 一键更新

业务、Python 运行环境和前端继续内置在 `SunYu_ERP.exe`，安装目录新增 `update.exe`。运行时无需安装 Python、Go 或 Node.js。

登录运行服务的本机，在系统设置中检查版本并点击“一键更新”；也可直接运行安装目录中的 `update.exe`。更新不会强制安装。工具先下载和校验，准备完成后短暂停止服务，替换主程序与更新工具，验证启动成功后清理临时文件。前端随主程序一起更新。

更新工具优先从 [SunERP 蓝奏目录](https://urldown.lanzouw.com/b019w91rof)（提取码 `hru1`）读取清单并在本地解析下载地址，异常时回退 GitHub；镜像暂无新版时也会短暂核对 GitHub，避免漏掉尚未同步的版本。下载仍校验完整包和两个 EXE 的 SHA256。客户端不包含蓝奏登录凭据，也不调用第三方解析服务。遇到人工验证码会停止该来源并回退，不自动处理验证码。

`Data/`（或配置的自定义数据目录）和 `config.json` 保留；`.updates/` 存放更新进度、临时文件与最近一次恢复备份。安装失败会显示原因；需要恢复时应保留该目录供诊断。局域网访问者可以查看状态，安装必须从运行服务本机发起。

从 `v1.2.4` 首次升级时，从 [最新版本附件](https://github.com/Vex9th/SunYu_ERP/releases/latest) 下载独立 `update.exe`，放到原 `SunYu_ERP.exe` 旁再运行。`v1.2.5` 和 `v1.2.6` 请直接双击安装目录里的 `update.exe` 完成本次升级，避开旧设置页启动更新器时的环境继承缺陷；升级到 `v1.2.7` 后可在本机系统设置中检查更新并一键升级。也可停止旧程序后手动解压完整包，保留原数据和配置。

## 开发

React + TypeScript（strict）+ Ant Design + Vite，Python 3.13 + FastAPI，SQLite；独立更新工具使用 Go。
开发环境使用 Node.js 22.12+（或 24+），沿用 npm 与锁文件。
安装 `requirements-dev.txt` 和 `frontend/package-lock.json` 对应依赖后，运行 `python dev.py`。

前端结构、验证命令和迁移说明见 [frontend/README.md](frontend/README.md)。

[MIT License](LICENSE)

## 构建与发布

普通 CI 检查主分支推送和 PR，同一分支的新运行会取消过期运行；标签不会重复触发测试。

在 Actions 中手动运行 **Windows Release**，填写与 `backend/app/version.py` 一致的 `version`（例如 `v1.2.8`），在测试、EXE 启动、数据持久化和 Windows 升级恢复验证通过后发布。版本号留空时只上传候选构建产物。不要再单独推送标签或提前创建正式 Release。

同一提交的完整版本会直接跳过；未完成的草稿可重跑续传；已有标签指向不同提交时会停止，避免覆盖旧版本。新版本附件包括完整 Windows 安装包、独立 `update.exe`、`update-manifest-singlefile.json` 和 `SHA256SUMS.txt`。完整 ZIP 仅包含两个 EXE、启动脚本、说明、许可和示例配置。

正式发布后调用 **Publish Lanzou Mirror**，先上传完整包，再上传版本清单 ZIP，随后从公开分享链接下载并校验。完整包按北京时间 `YYYYMMDDNN.zip` 命名，清单为 `SunERP_v版本_manifest.zip`。当前账号单文件上限为 100 MiB，超限会明确报错。已发布版本不会覆盖；镜像补传可单独运行该工作流，填写已有正式版本号，无需重建 Windows 包。所有版本的自动上传与补传串行执行。

发布凭据只通过仓库加密 Secrets 配置：`LANZOU_COOKIE`、`LANZOU_USERNAME`、`LANZOU_PASSWORD`。先检查已有会话，失效后只尝试一次账号登录，并完成登录鉴权跳转；需要人工验证时提示维护者处理，不循环登录。镜像失败会在 Actions 摘要标明“尚未通过验证”，保留 GitHub 正式版。凭据不进入源码、日志或更新客户端。
