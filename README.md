# SunYu ERP

面向个人使用的非标工业项目管理系统，覆盖项目资料、报价合同、采购库存、施工、收付款、成本和售后。

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

## 开发

React + TypeScript（strict）+ Ant Design + Vite，Python 3.13 + FastAPI，SQLite。
开发环境使用 Node.js 22.12+（或 24+），沿用 npm 与锁文件。
安装 `requirements-dev.txt` 和 `frontend/package-lock.json` 对应依赖后，运行 `python dev.py`。

前端结构、验证命令和迁移说明见 [frontend/README.md](frontend/README.md)。

[MIT License](LICENSE)
