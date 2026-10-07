# 前端开发

正式入口为 `src/main.tsx`，使用 React、TypeScript strict、Vite 和 Ant Design。
主题集中在 `src/react/App.tsx` 的 ConfigProvider，布局使用 CSS Modules；业务页按路由延迟加载。

## 运行与检查

使用 Node.js 22.12+ 或 24+，依赖沿用 npm 锁文件。

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
```

开发服务器使用 5173，将 `/api` 转发到本机 8765。项目根目录的 `python dev.py` 可同时启动前后端。
正式产物位于 `dist/`，继续由原 FastAPI 服务托管，后端协议和数据格式未迁移。

## 代码边界

- `src/react/`：工作台、项目、公司联系人、库存、设置与业务工作区。
- `src/repositories/`、`src/domain/`、`src/api.ts`：复用的后端协议、金额日期规则及幂等请求封装。
- `src/react/__tests__/`：新界面交互、失败恢复、跨页面请求隔离和只读状态测试。
- `src/components/`、旧 `src/App.vue` / `main.ts` / `router.ts` 及 `src/tests/`：保留旧实现与回归基线，**不进入正式页面**。Vue、Element Plus 与其插件只作为开发测试依赖。

`build` 使用独立 `tsconfig.app.json` 检查 React 入口。`typecheck` 同时检查新旧代码，`test` 同时运行协议回归、旧界面基线与 React 测试。只有测试模式加载 Vue 插件。

修改写操作时保留原请求内容、版本与幂等键；未知结果应先原样重试核实，不能因为刷新或切换页面重新生成请求。公司与联系人创建还会在当前浏览器会话内持久化待确认请求。归档项目的业务页面保持只读。

## 工作区交互

页签与列表筛选通过 `navigationState.tsx` 同步到 URL，并按项目、模块记住会话内的位置；文档预览与文件列表共享筛选上下文。新增状态请用共享 hooks，避免多个 `setSearchParams` 在同一事件里覆盖其他条件。

项目编辑器、用工和交付表单以及备份设置支持会话内草稿恢复；刷新或关闭窗口不承诺保留未提交草稿。已有记录的草稿需要保留原版本，版本变化时先核对再保存。不要用最新 revision 直接提交旧草稿。
