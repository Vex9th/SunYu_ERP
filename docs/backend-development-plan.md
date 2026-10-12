# SunYu ERP 后端开发计划

> **面向后端开发者与 AI 代理：** 按本文顺序实现；每个阶段必须先补测试，再写迁移和业务代码。前端以 [`api-contract.md`](./api-contract.md) 为唯一接口契约，不从数据库结构猜字段。

**目标：** 在保留现有认证、公司联系人、项目基础档案和备份功能的前提下，逐步补齐项目阶段、文件版本、报价合同、三段收款、采购库存、人员施工、验收质保和售后闭环。

**架构：** 项目仍是经营主线，但进度、合同履约、现金收款、采购库存、成本和质保分别建模，禁止用一个项目状态或一个金额字段混代。所有持久化继续使用本机 SQLite；项目附件写入 `Data/Projects/<project_code>/`，备份可写到用户设置的群晖同步目录。

**技术栈：** Python 3.13、FastAPI、SQLite、pytest、Vue 3、TypeScript、Element Plus。

---

## 1. 当前基线

当前实现基线已经覆盖原计划 P0 至 P2 的后端业务闭环。已经可用的能力：

- 六位数字密码设置、登录、退出和会话校验；
- 公司开票资料与多联系人增删查改；
- 项目新建、筛选、归档和基础项目仪表台；
- 项目文件上传、下载和多版本安全归档；
- SQLite 迁移、手动/自动备份、备份清理和 Windows 单文件发布。

截至 2026-09-01，后端已连续执行 `005` 至 `013`，并挂载项目经营、文档、采购库存、人员施工、现场、交付和仪表台路由。当前真实闭环包含：固定 18 阶段、文件版本、报价合同、三段收款、Excel 采购导入、付款/到货/进项票、库存与领用冲销、施工员停用/启用、带不可变事件审计的排单流转、当日上工批量提交、单条上工新增/编辑/作废、施工日报、人员垫资、调试变更、验收质保、发票售后和经营仪表台。

本文件后续任务清单保留为历史实施顺序；当前可调用范围以 [`api-contract.md`](./api-contract.md) 和生成的 OpenAPI 为准。已实现能力不得在前端伪装成演示数据。

## 2. 不可破坏的边界

1. 保留现有 `/api/auth`、`/api/companies`、`/api/projects`、`/api/system` 路径和响应结构。
2. SQLite 主库只能放在本机磁盘，不能放到 NAS、SMB 共享或同步目录。
3. 金额使用整数分，字段统一以 `_cents` 结尾；禁止使用二进制浮点数保存金额。
4. API 中的物料数量、工作日数等可带小数的业务量使用十进制字符串，最多 3 位小数；数据库内部换算为千分整数保存。
5. 日期使用 `YYYY-MM-DD`；时间戳使用带时区的 ISO 8601，后端统一按 UTC 保存。
6. 合同额、开票额、应收额、实际到账、采购成本、人员成本分别保存，不互相覆盖。
7. 采购到货只增加库存并形成采购/库存流水；物料被项目领用时才计入项目实际材料成本。库存余额由流水汇总，禁止直接改余额制造无来源库存。
8. 会签和验收状态与附件分离。允许先确认“已完成/无图纸”，附件不作为强制前置条件。
9. 新增可编辑资源在响应中返回 `revision`，更新请求在 JSON 或表单中携带 `expected_revision`；冲突统一返回 `409`。收款、库存、导入确认等不可重复操作同时要求 `Idempotency-Key` 请求头。
10. 项目归档不删除财务、库存、附件和审计记录。

## 3. 计划文件结构

### 3.1 新增迁移

- `backend/migrations/005_project_workflow_documents.sql`：项目阶段、通用幂等记录、文档元数据扩展。
- `backend/migrations/006_commercial_finance.sql`：报价、合同、合同项目分摊、收款节点、到账记录。
- `backend/migrations/007_dashboard_indexes.sql`：P0 仪表台查询所需组合索引，不保存可重新计算的利润快照。
- `backend/migrations/008_procurement_inventory.sql`：采购清单、采购行、导入批次、库存物品和库存流水。
- `backend/migrations/009_workforce_delivery.sql`：施工员、项目排单、工时、垫资、变更、验收、发票、质保和售后。
- `backend/migrations/010_site_report_events.sql`：施工日报纠错事件。
- `backend/migrations/011_procurement_audit.sql`：采购反冲与进项票附件审计。
- `backend/migrations/012_delivery_events.sql`：交付状态事件与售后在保事实。
- `backend/migrations/013_workforce_events.sql`：排单状态流转的不可变事件审计。

迁移必须严格按编号顺序落地，不能先跳过未实现的版本；P1/P2 新查询需要的索引分别放入 `008`、`009` 或其后连续迁移。

### 3.2 新增后端模块

- `backend/app/features/api_common.py`：分页、错误响应、乐观锁和幂等键公共契约。
- `backend/app/features/project_stages.py`：项目阶段、计划日期和完成确认。
- `backend/app/features/documents.py`：文件上传、版本列表、下载和文档归档。
- `backend/app/features/quotes.py`：报价版本与接受/拒绝状态。
- `backend/app/features/contracts.py`：合同、项目分摊和关键日期。
- `backend/app/features/receivables.py`：预付款、进度款、尾款计划及实际到账。
- `backend/app/features/dashboards.py`：总仪表台、项目进度、成本、利润和待办聚合。
- `backend/app/features/procurement.py`：采购清单、Excel 预检/确认、采购状态和报价单导出。
- `backend/app/features/inventory.py`：库存物品、到货入库、项目领用、退库和调整流水。
- `backend/app/features/workforce.py`：施工员、项目排单、计薪方式和工时。
- `backend/app/features/construction.py`：施工日报、人员垫资和现场补买材料。
- `backend/app/features/engineering_changes.py`：调试、增补和技术协议变更。
- `backend/app/features/acceptance.py`：会签、验收、质保和续保价格。
- `backend/app/features/billing.py`：项目发票记录及附件关联。
- `backend/app/features/after_sales.py`：售后原因、处理过程和完成时间。

每个模块在 `backend/tests/features/` 下建立同名测试文件。跨模块事务测试放在 `backend/tests/integration/`，不得用仅验证 Mock 调用的测试替代数据库结果断言。

## 4. 实施阶段

### P0：让前端拥有稳定的项目经营主线

#### 任务 1：公共 API 契约和项目编辑

- [ ] 在 `backend/tests/features/test_api_common.py` 固定分页、错误结构、`revision` 冲突和幂等键行为。
- [ ] 新增 `api_common.py`，错误结构保持现有 `detail` 字符串兼容，同时增加 `error_code`、`field_errors` 和 `current_revision`。
- [ ] 为项目补充详情和编辑接口；项目编号创建后不可修改，公司、名称和描述可以修改。
- [ ] 运行 `python -m pytest backend/tests/features/test_api_common.py backend/tests/features/test_projects.py -q`，预期 0 失败。
- [ ] 提交：`feat(api): 建立分页与并发控制契约`。

#### 任务 2：项目阶段与文件版本 API

- [ ] 先写 `test_project_stages.py`，覆盖阶段初始化、跳过、阻塞、带原因回退和并发更新。
- [ ] 执行 `005_project_workflow_documents.sql`；每个项目初始化固定阶段清单，阶段状态只允许契约中定义的枚举。
- [ ] 先写 `test_documents.py`，覆盖首次上传、追加版本、并发版本号、下载、哈希、路径穿越和版本归档；业务版本不提供物理删除接口。
- [ ] 扩展并复用 `backend/app/features/files.py` 的安全落盘逻辑，让物理路径包含 `document_id`；同类别的两个逻辑文档必须分别从版本 1 开始，不再实现第二套文件复制。
- [ ] 运行 `python -m pytest backend/tests/features/test_project_stages.py backend/tests/features/test_documents.py backend/tests/features/test_files.py -q`。
- [ ] 提交：`feat(项目): 增加阶段与文件版本接口`。

#### 任务 3：报价、合同与三段收款

- [ ] 先写 `test_quotes.py`，覆盖报价版本、提交、接受、拒绝，以及拒绝后由用户另行选择是否关闭项目；拒绝报价不得自动归档。
- [ ] 先写 `test_contracts.py`，覆盖一个合同分摊到多个项目、分摊金额合计约束和交付日期。
- [ ] 先写 `test_receivables.py`，覆盖预付款/进度款/尾款、分次到账、到账比例和重复请求幂等。
- [ ] 执行 `006_commercial_finance.sql`，所有金额以分保存；合同分摊、收款计划和实际到账使用独立表。
- [ ] 在一个 SQLite 事务内写入实际到账及其幂等记录，重复键必须返回第一次的结果。
- [ ] 运行 `python -m pytest backend/tests/features/test_quotes.py backend/tests/features/test_contracts.py backend/tests/features/test_receivables.py -q`。
- [ ] 提交：`feat(经营): 增加报价合同与三段收款`。

#### 任务 4：总仪表台和项目仪表台

- [ ] 先写 `test_dashboards.py`，固定项目进度、应收、实收、成本、利润和待办的计算口径。
- [ ] 项目实际利润按“已确认合同分摊额 - 项目已领用库存成本 - 已发生人员成本 - 已发生现场费用”计算；已下单、已付款和已到货未领用金额另列为采购承诺/现金流。成本模块尚未接通时返回 `null` 和完整性标记，不显示伪利润。
- [ ] P0 总仪表台只聚合当前已落地的项目阶段、逾期收款、临近交付和备份异常；质保到期在 P2 以新增待办类型接入，不落地重复快照。
- [ ] 为热点查询补 `007_dashboard_indexes.sql` 中与实际查询计划匹配的索引。
- [ ] 运行 `python -m pytest backend/tests/features/test_dashboards.py backend/tests/features/test_projects.py -q`。
- [ ] 提交：`feat(仪表台): 增加项目经营聚合`。

### P1：采购、库存和现场成本闭环

#### 任务 5：采购 Excel 两阶段导入

- [ ] 先写 `test_procurement_imports.py`，使用固定 `.xlsx` fixture 覆盖表头映射、单位、数量、重复行、非法金额和全有或全无提交。
- [ ] 执行 `008_procurement_inventory.sql`；导入预检只保存临时批次，不写正式采购行。
- [ ] 预检返回逐行错误；确认接口要求 `Idempotency-Key`，同一批次只允许确认一次。
- [ ] 提供官方模板下载和隐藏成本价的报价单导出；导出内容通过工作簿单元格断言验证。
- [ ] 运行 `python -m pytest backend/tests/features/test_procurement_imports.py -q`。
- [ ] 提交：`feat(采购): 增加清单导入与报价单导出`。

#### 任务 6：采购状态与库存流水

- [ ] 先写 `test_procurement.py` 和 `test_inventory.py`，覆盖未下单、部分付款、部分到货、部分开票、取消和退货。
- [ ] 为库存写入提供显式 `BEGIN IMMEDIATE` 事务入口，固定“检查余额/版本 → 写事实 → 写流水 → 更新余额 → 提交”的顺序，避免并发读后写丢失。
- [ ] 到货确认与库存入库必须处于同一事务；重复确认不能重复增加库存。
- [ ] 项目领用、退库、盘盈、盘亏全部写库存流水；库存不得出现负数，除非显式启用并审计负库存策略。
- [ ] 到货批次成本进入库存估值，项目领用时按移动加权平均成本计入项目；“报价”字段不参与库存成本。
- [ ] 运行 `python -m pytest backend/tests/features/test_procurement.py backend/tests/features/test_inventory.py backend/tests/integration/test_procurement_inventory.py -q`。
- [ ] 提交：`feat(库存): 打通采购到货与项目领用`。

#### 任务 7：人员、施工日报与垫资

- [ ] 先写 `test_workforce.py`，覆盖施工员停用、日薪/时薪、跨日工时和重复考勤。
- [ ] 先写 `test_construction.py`，覆盖施工日报、现场补买材料、人员垫资和报销状态。
- [ ] 执行 `009_workforce_delivery.sql`；计薪快照保存在项目排单中，后续修改施工员默认薪资不能改写历史成本。
- [ ] 日薪按 API 传入的十进制工作日数换算为千分工作日，时薪按实际分钟计算；结果四舍五入到分。
- [ ] 运行 `python -m pytest backend/tests/features/test_workforce.py backend/tests/features/test_construction.py -q`。
- [ ] 提交：`feat(施工): 增加排单工时与现场费用`。

### P2：交付、质量、发票和售后闭环

#### 任务 8：变更、会签和验收

- [ ] 先写 `test_engineering_changes.py`，覆盖技术、范围、材料和工期变更的提出、批准、拒绝和实施。
- [ ] 会签阶段允许无附件完成，但必须保存确认人说明和完成时间。
- [ ] 先写 `test_acceptance.py`，覆盖验收日期、质保月数、质保截止日、续保价格和验收单可选上传。
- [ ] 质保截止日由验收日期和质保月数计算；跨月末按日历月规则处理并写边界测试。
- [ ] 运行 `python -m pytest backend/tests/features/test_engineering_changes.py backend/tests/features/test_acceptance.py -q`。
- [ ] 提交：`feat(交付): 增加变更会签与验收质保`。

#### 任务 9：发票、尾款和售后

- [ ] 先写 `test_billing.py`，覆盖发票金额、号码、开票日期、图片附件和合同分摊关联。
- [ ] 尾款日期复用收款节点，不再建立第二套尾款金额和到账状态。
- [ ] 先写 `test_after_sales.py`，覆盖报修日期、原因、处理过程、完成时间和是否在保。
- [ ] 售后案件的在保判断以报修日期为准；历史案件不随当前日期变化。
- [ ] 运行 `python -m pytest backend/tests/features/test_billing.py backend/tests/features/test_after_sales.py -q`。
- [ ] 提交：`feat(收尾): 增加发票与售后记录`。

#### 任务 10：全量回归与 Windows 发布

- [ ] 运行 `python -m pytest`，预期 0 失败。
- [ ] 运行 `python -m ruff check .`，预期 0 错误。
- [ ] 运行 `npm --prefix frontend test`、`npm --prefix frontend run typecheck`、`npm --prefix frontend run build`。
- [ ] 在 Windows Release 工作流验证数据库迁移、附件上传、重启持久化和备份恢复。
- [ ] 检查发布 ZIP 不含 `Data`、真实 `config.json`、密码、客户资料和内部代理文档。
- [ ] 创建预发行版本，在真实 Windows 主机完成局域网访问与大文件上传验收后再标记稳定版。

## 5. 前后端并行规则

1. 前端可以立即依据 `api-contract.md` 建立 TypeScript 类型和 Mock adapter。
2. Mock 只存在于开发模式，并在页面明确显示“演示数据”；组件不直接判断 Mock 状态。
3. 每个后端 P0 接口完成后，前端只替换 adapter，不改页面领域模型。
4. OpenAPI 实际输出与文档不一致时，先修后端或文档，禁止前端增加静默兼容分支。
5. 未列入契约的字段、URL 和状态不得由前端自行发明。

## 6. 完成判定

“业务模块完成”必须同时满足：

- 数据迁移可从现有 `004` 数据库幂等升级；
- 正常、异常、非法状态、重复请求和并发冲突测试通过；
- OpenAPI 和本文契约一致；
- 前端已从 Mock adapter 切换到真实 API；
- Windows 单文件程序重启后数据和附件仍可读取；
- 自动备份包含数据库、配置和项目附件，并通过清单哈希校验。
