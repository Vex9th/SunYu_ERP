# 局域网 HTTP 分组账号提交修复

## 复现与原因

用户反馈分组账号新建、确认采购清单时报 `crypto.randomUUID is not a function`。使用隔离合成数据、非主账号 `buyer`，在真实局域网 HTTP 地址复现：`isSecureContext=false`、`crypto.randomUUID` 不存在、`crypto.getRandomValues` 存在。创建请求在发往后端前就失败。

`randomUUID` 仅在安全上下文可用，见 [Web Cryptography 标准](https://w3c.github.io/webcrypto/#Crypto-interface)。因此同样调用该接口的其他模块也受影响，并非只发生于采购清单或分组账号。

## 修改范围

- 新增统一 UUID v4 生成函数：优先原生 `randomUUID`，局域网 HTTP 使用 `getRandomValues` 生成安全随机字节并设置版本位、变体位。不使用 `Math.random`，不新增依赖。
- 替换 8 个源文件中 14 处直接调用，覆盖公共 JSON/附件提交、公司与联系人、采购导入、图纸附件、施工人员和交付表单、更新任务编号。
- 保留原请求内容、幂等键缓存和重试逻辑；断网后重试沿用同一个键，成功后的下一笔请求生成新键。
- 浏览器实测另发现公司保存成功后跳转被“未保存”提示误拦截。成功响应后先标记已提交再导航；失败请求和真正未保存的修改继续受保护。
- 无后端业务、数据库迁移、权限放宽或 DNS 修改。

## 相关验证

| 验证 | 结果 |
| --- | --- |
| 缺失 `randomUUID` 红测 | 修复前复现异常；修复后通过 |
| 公共请求与相关模块专项 | 7 个文件、145 项通过 |
| 显式移除 `randomUUID` 后的相关消费者测试 | 9 个文件、160 项通过，覆盖采购、库存、公司、施工、交付、更新面板 |
| 公司真实路由跳转红测 | 修复前路由被阻止；修复后直接进入新公司详情 |
| 最终 UUID、公司保存与未保存保护专项 | 3 个文件、21 项通过 |
| TypeScript / Vue 类型检查、生产构建、diff 空白检查 | 通过 |
| 独立代码审查 | 未发现 P1/P2 问题 |

上述批次有重叠，不应相加作为独立用例总数。未运行全量回归。构建保留已有分块体积提示；相关下载测试保留 jsdom 不支持页面导航的诊断，测试本身通过。

## 实际分组账号操作

在同一真实局域网 HTTP 页面使用 `合成采购员 · 合成采购组`，账号 `is_owner=false`，仅分配项目 1：

1. 新建采购清单、添加物料、确认物料。
2. 新建、修改、确认采购单，登记到货、付款、进项发票并上传附件。
3. 采购金额、已付款、已开票均为 50 元；附件下载字节与上传文件一致。
4. 新建施工人员、新建公司、添加联系人，操作记录包含实际分组账号备注名。
5. 最终构建下再次新建公司：保存后直接打开详情，无误报未保存提示；控制台无错误。

权限反向验证：未授权项目、账号管理、更新管理接口返回 403；不能给未授权项目建清单。主账号撤销确认权限后，同一成员登录会话的确认请求立即返回 403，物料仍为草稿，刷新页面后确认按钮禁用。

## 数据保护与证据

仅在 `tmp/lan-http-20261111/browser/` 使用合成 `DATA` 和 `config.json`；未修改原有数据和配置。DNS 文件前后 SHA-256 一致。测试服务验证后停止。

证据保留于 `tmp/lan-http-20261111/verification/`：

- `member-api-result.json`：实际接口结果、权限拒绝结果与操作人记录。
- `procurement-browser.jpg`、`revoked-confirm-browser.jpg`、`company-saved-browser.jpg`：真实浏览器结果。
- `http-red.log`、`related-frontend.log`、`http-consumers.log`、`company-navigation-red.log`、`final-related.log`：定向测试日志。
- `final-typecheck.log`、`final-build.log`、`protected-before.json`、`protected-after.json`：构建与保护检查。

本次只完成源码修复和验证，未提交、打包或发布；已安装的 v1.2.14 尚不包含本修复。未执行 Windows EXE 构建或运行验证。
