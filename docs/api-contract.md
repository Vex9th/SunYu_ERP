# SunYu ERP API 接口契约

> **前端开发唯一真源。** 本文先冻结 URL、字段、枚举和业务口径，允许前端先写 TypeScript 类型与 Mock adapter。接口标记为“规划”时，页面必须显示“演示数据”，不得把 Mock 结果伪装成真实后端数据。

## 1. 状态说明

| 标记 | 含义 |
|---|---|
| 已实现 | 当前后端可以直接调用，前端不得改变既有请求和响应 |
| P0 | 第一批后端实现：项目经营主线、文件、报价合同、三段收款和仪表台 |
| P1 | 第二批后端实现：采购库存、人员排单、工时和现场费用 |
| P2 | 第三批后端实现：调试变更、验收质保、发票和售后 |

接口前缀统一为 `/api`。除健康检查和认证接口外，全部使用登录后的 HttpOnly Session Cookie。

### 1.1 当前真实可接入范围（2026-08-29）

除第 3 节原有接口外，当前后端已经实现并挂载以下子集：

- 项目阶段：阶段列表、计划修改、带幂等键的状态流转；
- 采购：官方 `.xlsx` 模板、采购清单与采购行、清单确认、采购单与确认、到货、项目采购概览；
- 库存：库存物品、期初库存、库存调整、不可变流水、项目领用；
- 人员：施工员、停用、项目排单、当日上工查询和批量原子提交。

本节只说明实现进度，不改变后文冻结的完整契约。Excel 上传预检/确认、供应商付款/发票、隐藏成本报价单、单条上工维护、施工日报与垫资、报价合同收款、完整仪表台及 P2 接口仍是规划状态，前端必须继续显示“演示数据”。

## 2. 全局约定

### 2.1 请求和响应

- JSON 字段使用 `snake_case`，后端严格拒绝未知字段。
- 已有成功响应保持裸对象、裸数组或 `204`，不增加 `{code, data}` 外壳。
- 新增普通列表统一返回；`page` 默认 1，`page_size` 默认 50、最大 200：

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "page_size": 50
}
```

- 固定小集合，如项目阶段和图纸会签，直接返回数组。
- 新增可编辑资源响应包含 `revision: integer`；更新请求携带 `expected_revision`。版本不一致返回 `409`，并在错误中给出 `current_revision`。
- 对尚不存在的项目单例资源使用 `PUT` 创建时，`expected_revision` 传 `null`；资源已经存在后必须传当前整数版本。
- 除“已实现”遗留接口外，所有规划中的 `POST`（创建业务记录、上传版本或产生状态事件）都必须带请求头 `Idempotency-Key: <UUID>`；同一键、Method、Path 和请求内容返回第一次结果，相同键但内容不同返回 `409`。`GET`、`PUT` 和 `DELETE` 不使用该请求头。
- 创建成功返回 `201`；普通读取/更新/状态动作返回 `200`；无响应体的成功操作返回 `204`。

新增接口的错误响应在兼容现有 `detail` 的基础上增加稳定字段：

```json
{
  "detail": "Resource was modified",
  "error_code": "REVISION_CONFLICT",
  "field_errors": {},
  "current_revision": 3
}
```

前端优先识别 `error_code`，无法识别时显示 `detail`。常用状态码：`401` 未登录、`404` 不存在、`409` 状态/并发/幂等冲突、`422` 字段校验失败、`503` 本地服务或备份失败。

### 2.2 基础类型

| 类型 | 规则 | 示例 |
|---|---|---|
| 项目标识 | URL 使用 `{project_code}`，创建后不可修改 | `SY-2026-001` |
| 子资源标识 | SQLite 正整数 | `17` |
| 金额 | 人民币分，字段以 `_cents` 结尾，禁止浮点金额 | `1280000` 表示 ¥12,800.00 |
| 比例 | 基点 `basis_points`，`10000 = 100%` | `3000` 表示 30% |
| 数量 | 十进制字符串，最多 3 位小数 | `"2.500"` |
| 业务日期 | `YYYY-MM-DD`，按 `Asia/Shanghai` 理解 | `2026-09-30` |
| 时间戳 | 带时区 ISO 8601，后端按 UTC 保存 | `2026-08-28T08:30:00+00:00` |
| 可空文本 | 空白 trim 后转 `null` | `null` |

数据库可将数量换算为 `quantity_milli` 保存，但 API 始终收发十进制字符串 `quantity`。前端金额始终保留整数分，数量和日期始终保留字符串，不得先转为 JavaScript 浮点数再提交。

### 2.3 通用状态与业务原则

- 项目阶段：`pending | in_progress | blocked | completed | skipped`。
- 项目生命周期：现有 `active | archived` 保持不变；P0 新增可空的关闭类型 `closure_type: cancelled | completed | null`。新页面统一调用 `/close`；旧 `/archive` 永久兼容并产生 `closure_type = null`，不得猜成项目流产。两个入口都保留第一次关闭结果，重复关闭不改写原因。
- 项目归档、业务作废、库存冲销均保留历史，不物理删除事实记录。
- 报价被拒绝不会自动关闭项目；由用户另行确认是否关闭。
- 合同额、应收、实际到账、发票、采购成本、人员成本是不同事实，不互相代替。
- 到货确认才增加库存；上传采购 Excel 不直接入库。
- 图纸会签可以确认“无需图纸”，上传附件不是提交前提。
- 发票不是收款，报销不是二次成本，质保续费价格也不是收入。

## 3. 已实现接口

### 3.1 健康检查与认证

| Method | Path | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/health` | 无 | `{"status":"ok"}` |
| GET | `/api/auth/session` | 无 | `{"authenticated": boolean, "password_configured": boolean}` |
| POST | `/api/auth/setup` | `{"password":"123456"}` | `204`；只允许首次设置 |
| POST | `/api/auth/login` | `{"password":"123456"}` | `204` 并写入 Session Cookie |
| POST | `/api/auth/logout` | 无 | `204` 并清除 Cookie |

密码必须恰好是 6 位 ASCII 数字。前端首次进入先请求 `/api/auth/session`：未设置密码时展示“创建本机密码”，已设置但未登录时展示“输入密码”。

### 3.2 公司与联系人

`CompanyInput`：`name` 必填；`taxpayer_id`、`registered_address`、`registered_phone`、`bank_name`、`bank_account`、`notes` 可空。

`ContactInput`：`name` 必填；`phone`、`email`、`position`、`notes` 可空。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/companies` | 返回 `CompanySummary[]`，包含 `contact_count` |
| POST | `/api/companies` | 请求 `CompanyInput`，返回 `201 CompanyDetail` |
| GET | `/api/companies/{company_id}` | 返回 `CompanyDetail`，包含 `contacts` |
| PUT | `/api/companies/{company_id}` | 完整 `CompanyInput`，返回 `CompanyDetail` |
| DELETE | `/api/companies/{company_id}` | 未被项目引用时返回 `204` |
| POST | `/api/companies/{company_id}/contacts` | 请求 `ContactInput`，返回 `201 Contact` |
| PUT | `/api/companies/{company_id}/contacts/{contact_id}` | 完整 `ContactInput`，返回 `Contact` |
| DELETE | `/api/companies/{company_id}/contacts/{contact_id}` | 返回 `204` |

### 3.3 项目与备份

`ProjectInput`：`project_code`、`company_id`、`name` 必填，`description` 可空。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects?status=active\|archived\|all` | 返回 `ProjectSummary[]` |
| POST | `/api/projects` | 请求 `ProjectInput`，返回 `201 Project` |
| POST | `/api/projects/{project_code}/archive` | `{"reason": string|null}`，返回 `Project` |
| GET | `/api/projects/{project_code}/dashboard` | 返回 `project`、`company`、`contacts`、`documents` |
| GET | `/api/system/overview` | 返回数据目录、SQLite 路径、备份设置、调度状态和最后一次备份 |
| PUT | `/api/system/backup-settings` | `directory`、`interval_hours`、`retention_days`，返回保存后的设置 |
| POST | `/api/system/backups` | 立即备份，返回 `201 {path, created_at, warning?}` |

备份目录是本机可访问文件夹，允许选择群晖同步目录；SQLite 主库仍放在本机 `Data` 目录。

## 4. P0：项目经营主线

### 4.1 项目详情与阶段

固定阶段代码及顺序：

1. `planning` 项目规划
2. `site_survey` 现场测绘
3. `quotation` 我方报价
4. `technical_agreement` 技术协议
5. `contract` 合同签订/周期确认
6. `advance_payment` 预付款
7. `mechanical_design` 机械设计
8. `electrical_design` 电气设计
9. `procurement` 采购
10. `staffing` 人员排单
11. `mechanical_signoff` 机械图纸会签
12. `electrical_signoff` 电气图纸会签
13. `construction` 施工
14. `progress_payment` 进度款
15. `commissioning` 调试
16. `acceptance` 验收
17. `final_payment` 尾款
18. `closeout` 收尾

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}` | 返回 `ProjectDetail` |
| PUT | `/api/projects/{project_code}` | `company_id`、`name`、`description`、`expected_revision`；项目编号不可改 |
| POST | `/api/projects/{project_code}/close` | Header `Idempotency-Key`；`closure_type`、`reason`、`expected_revision`；返回关闭后的项目 |
| GET | `/api/projects/{project_code}/stages` | 返回固定顺序的 `ProjectStage[]` |
| PUT | `/api/projects/{project_code}/stages/{stage_code}` | 修改 `planned_start_on`、`planned_end_on`、`notes`、`expected_revision` |
| POST | `/api/projects/{project_code}/stages/{stage_code}/transition` | `to_status`、`occurred_at`、`reason`、`expected_revision` |

`ProjectStage` 核心字段：`stage_code`、`status`、`status_reason`、`planned_start_on`、`planned_end_on`、`started_at`、`blocked_at`、`completed_at`、`notes`、`revision`。允许流转：`pending → in_progress/skipped`、`in_progress → blocked/completed/skipped`、`blocked → in_progress/skipped`；`completed/skipped → in_progress` 仅用于纠错。进入 `blocked/skipped` 或从终态纠错都必须填写原因，所有流转保留事件历史。

### 4.2 文件和版本归档（已实现）

文件类别：

`planning_minutes | site_survey | quotation | technical_agreement | contract | mechanical_design | electrical_design | procurement_list | procurement_contract | mechanical_signoff | electrical_signoff | construction | commissioning | acceptance | invoice | warranty | after_sales | other`

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/documents?category=&page=&page_size=` | 返回文档分页列表 |
| POST | `/api/projects/{project_code}/documents` | `multipart/form-data`：`category`、`title`、`notes?`、`file`；返回 `201 DocumentDetail` |
| GET | `/api/projects/{project_code}/documents/{document_id}` | 返回文档及全部版本 |
| PUT | `/api/projects/{project_code}/documents/{document_id}` | JSON：`title`、`notes`、`expected_revision` |
| POST | `/api/projects/{project_code}/documents/{document_id}/versions` | multipart：`file`、`notes?`、`expected_revision`；返回 `201 DocumentVersion` |
| GET | `/api/projects/{project_code}/documents/{document_id}/versions/{version_id}/download` | 返回原文件流和安全文件名 |
| POST | `/api/projects/{project_code}/documents/{document_id}/archive` | `reason`、`expected_revision`；仅归档，不删磁盘文件 |

`DocumentVersion`：`id`、`version_number`、`original_filename`、`content_type`、`size_bytes`、`sha256`、`notes`、`created_at`。同一逻辑文档的物理路径固定为 `Data/Projects/<project_code>/<category>/<document_id>/...`，不能只按类别共用版本号。

API 的 `title` 映射现有数据库列 `documents.logical_name`，不新增第二个同义字段。所有 `document_version_ids` 必须存在、未归档并属于 URL 中的当前项目；请求中出现重复 ID 或跨项目 ID 均返回 `422`。

### 4.3 报价

> 实现状态：已实现。

报价状态：`draft | sent | accepted | rejected | withdrawn`。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/quotes?page=&page_size=` | 返回报价版本分页列表 |
| POST | `/api/projects/{project_code}/quotes` | `quote_date`、`amount_cents`、`valid_until`、`notes`、`document_version_ids`；返回 `201 Quote` |
| GET | `/api/projects/{project_code}/quotes/{quote_id}` | 返回 `Quote` |
| PUT | `/api/projects/{project_code}/quotes/{quote_id}` | 草稿可改字段加 `expected_revision` |
| POST | `/api/projects/{project_code}/quotes/{quote_id}/transition` | `to_status`、`occurred_at`、`reason`、`expected_revision` |

后端生成项目内连续的 `version_number`。被接受的报价金额仍只是报价事实；签订合同后，以合同分摊额作为经营收入基准。

### 4.4 合同与项目分摊

> 实现状态：已实现。

合同状态：`draft | signed | completed | terminated`。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/contracts?page=&page_size=` | 返回与项目关联的合同分页列表 |
| POST | `/api/projects/{project_code}/contracts` | `contract_no`、`title`、`customer_company_id`、`signed_on`、`total_amount_cents`、`final_delivery_on`、`allocations`、`notes`、`document_version_ids`；默认 `draft` |
| GET | `/api/projects/{project_code}/contracts/{contract_id}` | 返回合同、项目分摊和附件引用 |
| PUT | `/api/projects/{project_code}/contracts/{contract_id}` | 可编辑字段加 `expected_revision` |
| POST | `/api/projects/{project_code}/contracts/{contract_id}/transition` | `to_status`、`occurred_at`、`reason`、`expected_revision` |

草稿的 `signed_on`、`final_delivery_on` 允许为 `null`；转为 `signed` 时必须补齐签订日期、最终交付日期和完整分摊。`allocations` 为 `[{"project_code":"SY-2026-001","amount_cents":1280000}]`，已签合同时合计必须等于合同总额。前端第一版可只操作当前项目的一条分摊，但类型必须保留数组，避免以后一个合同对应多个项目时重做页面。

### 4.5 三段收款

> 实现状态：已实现。

固定收款节点：`advance | progress | final`。计划完成状态由金额自动计算：`unplanned | scheduled | partial | paid`，另返回只读 `is_overdue: boolean`，避免“部分到账且已逾期”无法表达。到账记录状态：`active | voided`。收款方式：`bank_transfer | cash | other`；P0 不把未兑付承兑票据计入实际到账。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/payments` | 返回合同基准、三个节点、总实收和总未收 |
| PUT | `/api/projects/{project_code}/payment-terms/{milestone}` | `due_on`、`planned_amount_cents`、`notes`、`expected_revision` |
| POST | `/api/projects/{project_code}/receipts` | Header `Idempotency-Key`；`contract_allocation_id`（可空）、`milestone`、`received_on`、`amount_cents`、`payment_method`、`reference_no`、`notes` |
| PUT | `/api/projects/{project_code}/receipts/{receipt_id}` | 仅可改说明类字段和 `expected_revision`；金额纠错使用作废后重录 |
| POST | `/api/projects/{project_code}/receipts/{receipt_id}/void` | `voided_on`、`reason`、`expected_revision` |

项目收款概览固定返回以下独立口径：

- `contracted_amount_cents`：有效 `signed/completed` 合同在当前项目的分摊合计；
- `receivable_amount_cents`：三个有效付款计划合计；
- `received_amount_cents`：当前项目全部未作废到账合计；
- `allocated_received_amount_cents`：已经核销到合同分摊的未作废到账；
- `unallocated_received_amount_cents`：`contract_allocation_id = null` 的待分配到账；
- `outstanding_receivable_cents = max(receivable_amount_cents - received_amount_cents, 0)`；
- `contract_collection_basis_points = allocated_received_amount_cents / contracted_amount_cents`；
- 每个节点另返回 `planned_amount_cents`、`received_amount_cents`、`outstanding_amount_cents`、`term_fulfillment_basis_points` 和 `is_overdue`。

任何分母为 0 时比例返回 `null`，不能除零或显示 100%。待分配到账可以降低项目总未收，但不得静默计入任一合同的回款比例。

### 4.6 总仪表台和项目仪表台

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/dashboard` | 总览：项目阶段、三段收款、近期交付、待办、备份告警 |
| GET | `/api/projects/{project_code}/dashboard` | 在已有四个字段后增量加入 `stages`、`commercial`、`costs`、`profit`、`receivables`、`todos` |

项目仪表台不得删除当前已有的 `project`、`company`、`contacts`、`documents`。`costs` 分为 `material_consumed_cents`、`labor_cents`、`field_material_cents`、`total_cents`；另列 `procurement_committed_cents`、`procurement_received_cents` 和采购付款现金流，不重复计入利润。在 P1 成本模块接通前，成本和利润字段返回 `null`，并返回 `costs.completeness: "unavailable"`；接通后为 `complete | partial`，不显示伪造的零成本高利润。

### 4.7 P0 完整响应类型

以下 TypeScript 等价类型冻结 P0 响应字段。`readonly` 表示字段由后端计算或生成，不是对应写请求的一部分。

```ts
type ISODate = string
type ISODateTime = string
type MoneyCents = number
type BasisPoints = number

interface PagedResult<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

interface CompanyRecord {
  id: number
  name: string
  taxpayer_id: string | null
  registered_address: string | null
  registered_phone: string | null
  bank_name: string | null
  bank_account: string | null
  notes: string | null
  created_at: ISODateTime
  updated_at: ISODateTime
}

interface ContactRecord {
  id: number
  company_id: number
  name: string
  phone: string | null
  email: string | null
  position: string | null
  notes: string | null
  created_at: ISODateTime
  updated_at: ISODateTime
}

type ProjectStatus = 'active' | 'archived'
type ClosureType = 'cancelled' | 'completed'

interface ProjectDetail {
  id: number
  project_code: string
  company_id: number
  company_name: string
  name: string
  description: string | null
  status: ProjectStatus
  closure_type: ClosureType | null
  archive_reason: string | null
  archived_at: ISODateTime | null
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

type ProjectStageStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'skipped'

interface ProjectStage {
  stage_code: string
  status: ProjectStageStatus
  status_reason: string | null
  planned_start_on: ISODate | null
  planned_end_on: ISODate | null
  started_at: ISODateTime | null
  blocked_at: ISODateTime | null
  completed_at: ISODateTime | null
  notes: string | null
  revision: number
}

interface DashboardDocumentSummary {
  document_count: number
  version_count: number
  categories: Array<{
    category: string
    document_count: number
    version_count: number
  }>
}

interface DocumentVersion {
  id: number
  version_number: number
  original_filename: string
  content_type: string
  size_bytes: number
  sha256: string
  notes: string | null
  created_at: ISODateTime
}

interface DocumentSummary {
  id: number
  project_code: string
  category: string
  title: string
  notes: string | null
  latest_version_number: number
  archived_at: ISODateTime | null
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

interface DocumentDetail extends DocumentSummary {
  versions: DocumentVersion[]
}

type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'withdrawn'

interface Quote {
  id: number
  project_code: string
  version_number: number
  status: QuoteStatus
  quote_date: ISODate
  amount_cents: MoneyCents
  valid_until: ISODate | null
  notes: string | null
  document_version_ids: number[]
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

type ContractStatus = 'draft' | 'signed' | 'completed' | 'terminated'

interface ContractAllocation {
  id: number
  contract_id: number
  project_code: string
  amount_cents: MoneyCents
}

interface Contract {
  id: number
  contract_no: string
  title: string
  customer_company_id: number
  customer_company_name: string
  status: ContractStatus
  signed_on: ISODate | null
  total_amount_cents: MoneyCents
  final_delivery_on: ISODate | null
  allocations: ContractAllocation[]
  notes: string | null
  document_version_ids: number[]
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

type PaymentMilestone = 'advance' | 'progress' | 'final'
type PaymentTermStatus = 'unplanned' | 'scheduled' | 'partial' | 'paid'
type ReceiptStatus = 'active' | 'voided'
type PaymentMethod = 'bank_transfer' | 'cash' | 'other'

interface PaymentTerm {
  id: number | null
  milestone: PaymentMilestone
  due_on: ISODate | null
  planned_amount_cents: MoneyCents
  received_amount_cents: MoneyCents
  outstanding_amount_cents: MoneyCents
  term_fulfillment_basis_points: BasisPoints | null
  status: PaymentTermStatus
  is_overdue: boolean
  notes: string | null
  revision: number | null
}

interface Receipt {
  id: number
  project_code: string
  contract_allocation_id: number | null
  milestone: PaymentMilestone
  received_on: ISODate
  amount_cents: MoneyCents
  payment_method: PaymentMethod
  reference_no: string | null
  notes: string | null
  status: ReceiptStatus
  voided_on: ISODate | null
  void_reason: string | null
  revision: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

interface PaymentOverview {
  contracted_amount_cents: MoneyCents
  receivable_amount_cents: MoneyCents
  received_amount_cents: MoneyCents
  allocated_received_amount_cents: MoneyCents
  unallocated_received_amount_cents: MoneyCents
  outstanding_receivable_cents: MoneyCents
  contract_collection_basis_points: BasisPoints | null
  terms: PaymentTerm[]
  receipts: Receipt[]
}

type CostCompleteness = 'unavailable' | 'partial' | 'complete'

interface ProjectCostSummary {
  material_consumed_cents: MoneyCents | null
  labor_cents: MoneyCents | null
  field_material_cents: MoneyCents | null
  total_cents: MoneyCents | null
  procurement_committed_cents: MoneyCents | null
  procurement_received_cents: MoneyCents | null
  procurement_paid_cents: MoneyCents | null
  completeness: CostCompleteness
}

interface ProjectProfitSummary {
  contracted_amount_cents: MoneyCents
  actual_cost_cents: MoneyCents | null
  actual_profit_cents: MoneyCents | null
  margin_basis_points: BasisPoints | null
}

interface DashboardTodo {
  code: string
  severity: 'info' | 'warning' | 'danger'
  project_code: string | null
  due_on: ISODate | null
  title: string
  description: string | null
}

interface ProjectDashboard {
  project: ProjectDetail
  company: CompanyRecord
  contacts: ContactRecord[]
  documents: DashboardDocumentSummary
  stages: ProjectStage[]
  commercial: {
    accepted_quote: Quote | null
    contracts: Contract[]
  }
  costs: ProjectCostSummary
  profit: ProjectProfitSummary
  receivables: PaymentOverview
  todos: DashboardTodo[]
}

interface DashboardProjectRow {
  project: ProjectDetail
  current_stage: ProjectStage | null
  contracted_amount_cents: MoneyCents
  received_amount_cents: MoneyCents
  outstanding_receivable_cents: MoneyCents
  final_delivery_on: ISODate | null
  actual_profit_cents: MoneyCents | null
}

interface GlobalDashboard {
  generated_at: ISODateTime
  summary: {
    active_project_count: number
    overdue_receivable_count: number
    upcoming_delivery_count: number
    contracted_amount_cents: MoneyCents
    received_amount_cents: MoneyCents
    outstanding_receivable_cents: MoneyCents
  }
  projects: DashboardProjectRow[]
  todos: DashboardTodo[]
  backup: {
    healthy: boolean
    last_success_at: ISODateTime | null
    message: string | null
  }
}
```

`GET /api/dashboard` 返回 `GlobalDashboard`，`GET /api/projects/{project_code}/dashboard` 返回 `ProjectDashboard`。普通项目列表在 P0 增量返回 `ProjectDetail[]`；字段只能新增，不能删除现有字段。

## 5. P1：采购与库存

### 5.1 采购清单与 Excel 导入

采购清单状态：`draft | confirmed | superseded`。采购单状态：`draft | confirmed | partially_received | received | cancelled`。

采购行核心字段：`sequence_no`、`category`、`name`、`specification`、`brand`、`model`、`quantity`、`unit`、`unit_cost_cents`、`quoted_unit_price_cents`，以及只读派生状态：

- `order_status`: `not_ordered | partial | ordered | over_ordered`
- `payment_status`: `unpaid | partial | paid`
- `receipt_status`: `not_received | partial | received`
- `invoice_status`: `not_invoiced | partial | invoiced`
- `usage_status`: `unused | partial | used`

前端不得提交或自行保存这些状态。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/procurement/import-template.xlsx` | 下载官方采购模板 |
| POST | `/api/projects/{project_code}/procurement-imports/preview` | multipart `file`；返回 `201` 导入批次、预览行和逐格错误 |
| POST | `/api/projects/{project_code}/procurement-imports/{import_id}/confirm` | Header `Idempotency-Key`；`list_name`、`expected_revision`；原子生成正式清单 |
| GET | `/api/projects/{project_code}/procurement-lists?page=&page_size=` | 返回采购清单分页列表 |
| POST | `/api/projects/{project_code}/procurement-lists` | `name`、`notes`；返回 `201 ProcurementList` |
| GET | `/api/projects/{project_code}/procurement-lists/{list_id}` | 返回清单、行和派生状态汇总 |
| PUT | `/api/projects/{project_code}/procurement-lists/{list_id}` | `name`、`notes`、`expected_revision` |
| POST | `/api/projects/{project_code}/procurement-lists/{list_id}/lines` | 采购行核心字段；返回 `201 ProcurementLine` |
| PUT | `/api/projects/{project_code}/procurement-lists/{list_id}/lines/{line_id}` | 可编辑字段加 `expected_revision` |
| POST | `/api/projects/{project_code}/procurement-lists/{list_id}/confirm` | `expected_revision`，确认后普通编辑受限 |
| GET | `/api/projects/{project_code}/procurement-overview` | 返回采购状态计数、金额和异常待办 |

Excel 限制：`.xlsx`、最大 20 MB、最多 10,000 条数据行；预检不写正式采购数据和库存；确认必须全有或全无。物料自动匹配只做规范化后的精确匹配，模糊匹配必须由用户确认。

### 5.2 采购单、付款、到货与进项票

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/purchase-orders?page=&page_size=&status=` | 返回采购单分页列表 |
| POST | `/api/projects/{project_code}/purchase-orders` | `order_no`、`supplier_company_id`、`ordered_on`、`expected_delivery_on`、`lines`、`notes`、`document_version_ids` |
| GET | `/api/projects/{project_code}/purchase-orders/{order_id}` | 返回采购单、付款、到货和发票汇总 |
| PUT | `/api/projects/{project_code}/purchase-orders/{order_id}` | 草稿可编辑字段加 `expected_revision` |
| POST | `/api/projects/{project_code}/purchase-orders/{order_id}/confirm` | `expected_revision` |
| POST | `/api/projects/{project_code}/purchase-orders/{order_id}/cancel` | `reason`、`expected_revision` |
| POST | `/api/projects/{project_code}/purchase-orders/{order_id}/supplier-payments` | Header `Idempotency-Key`；`paid_on`、`amount_cents`、`payment_method`、`reference_no`、`allocations`、`notes` |
| POST | `/api/projects/{project_code}/purchase-orders/{order_id}/goods-receipts` | Header `Idempotency-Key`；`received_on`、`warehouse_name`、`lines`、`notes` |
| POST | `/api/projects/{project_code}/purchase-orders/{order_id}/supplier-invoices` | Header `Idempotency-Key`；`invoice_no`、`invoiced_on`、`amount_cents`、`allocations`、`document_version_ids` |
| POST | `/api/projects/{project_code}/supplier-payments/{payment_id}/reverse` | `reason`、`expected_revision`；冲销供应商付款 |
| POST | `/api/projects/{project_code}/goods-receipts/{receipt_id}/reverse` | `reason`、`expected_revision`；冲销到货并反向写库存流水 |
| POST | `/api/projects/{project_code}/supplier-invoices/{invoice_id}/reverse` | `reason`、`expected_revision`；冲销进项票记录 |

P1 不允许超付款、超到货或超开票；超下单必须填写原因。到货确认和库存入库处于同一 SQLite 事务。

- 采购单 `lines`：`procurement_line_id`、`quantity`、`unit_cost_cents`、`overage_reason`。
- 到货 `lines`：`purchase_order_line_id`、`quantity`。
- 付款/发票 `allocations`：`purchase_order_line_id`、`amount_cents`；分摊合计必须等于单据金额，后端不猜一笔部分付款属于哪些物品。

### 5.3 库存

库存物品核心字段：`id`、`brand`、`name`、`model`、`specification`、`unit`、`quantity`、`average_unit_cost_cents`、`inventory_value_cents`、`revision`。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/inventory/items?page=&page_size=&query=&status=` | 展示全部库存和搜索结果 |
| POST | `/api/inventory/items` | `brand`、`name`、`model`、`specification`、`unit`、`opening_quantity`、`opening_unit_cost_cents`、`notes`；初始数量在同一事务生成期初流水 |
| GET | `/api/inventory/items/{item_id}` | 返回物品、余额和最近流水 |
| PUT | `/api/inventory/items/{item_id}` | 档案字段加 `expected_revision` |
| GET | `/api/inventory/items/{item_id}/movements?page=&page_size=` | 返回不可变库存流水 |
| POST | `/api/inventory/adjustments` | Header `Idempotency-Key`；`item_id`、`quantity_delta`、`unit_cost_cents`、`reason`、`occurred_on` |
| POST | `/api/projects/{project_code}/inventory-issues` | Header `Idempotency-Key`；`issued_on`、`worker_id`、`lines`、`notes` |
| POST | `/api/projects/{project_code}/inventory-issues/{issue_id}/reverse` | Header `Idempotency-Key`；`reason`、`expected_revision` |

所有库存增减都产生不可变 `InventoryMovement`。采购入库使用移动加权平均成本；项目领用按出库时平均成本固化项目成本；默认禁止负库存。

手工新建库存物品时，`opening_quantity` 使用十进制字符串；数量为 `"0"` 时 `opening_unit_cost_cents` 可为 `null`，数量大于 0 时必须提供非负成本价。

项目领用 `lines`：`inventory_item_id`、`procurement_line_id`（可空）、`quantity`。若填写采购行，它必须属于当前项目；实际出库成本始终由库存流水计算，前端不提交成本。

### 5.4 隐藏成本价的报价单

| Method | Path | 请求/响应 |
|---|---|---|
| POST | `/api/projects/{project_code}/procurement-lists/{list_id}/quote-exports` | `title`、`customer_company_id`、`notes`；返回 `201 QuoteExport` |
| GET | `/api/projects/{project_code}/quote-exports/{export_id}/download` | 下载 `.xlsx` 报价单 |

导出必须从独立的客户 DTO 新建工作簿，只写报价字段；不得把成本价放入隐藏列、隐藏工作表或公式缓存。

## 6. P1：施工员、排单与现场成本

### 6.1 施工员和项目排单

计薪方式：`daily | hourly`。施工员状态：`active | inactive`。排单状态：`planned | active | completed | cancelled`。上工状态：`present | absent | leave`。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/workers?page=&page_size=&status=&query=` | 返回施工员分页列表 |
| POST | `/api/workers` | `name`、`phone`、`notes`；返回 `201 Worker` |
| GET | `/api/workers/{worker_id}` | 返回 `Worker` |
| PUT | `/api/workers/{worker_id}` | 档案字段加 `expected_revision` |
| POST | `/api/workers/{worker_id}/deactivate` | `effective_on`、`reason`、`expected_revision` |
| GET | `/api/projects/{project_code}/crew-assignments?page=&page_size=&status=` | 返回项目排单分页列表 |
| POST | `/api/projects/{project_code}/crew-assignments` | `worker_id`、`role`、`scheduled_start_on`、`scheduled_end_on`、`pay_basis`、`rate_cents`、`notes` |
| PUT | `/api/projects/{project_code}/crew-assignments/{assignment_id}` | 排单字段加 `expected_revision` |
| POST | `/api/projects/{project_code}/crew-assignments/{assignment_id}/transition` | `to_status`、`effective_at`、`reason`、`expected_revision` |

`rate_cents` 在排单中固化：`daily` 表示分/日，`hourly` 表示分/小时。修改施工员档案不改写历史项目工资。

### 6.2 当日上工和施工日报

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/labor-entries?page=&page_size=&from=&to=&worker_id=` | 返回上工记录分页列表 |
| POST | `/api/projects/{project_code}/labor-entries/batch` | Header `Idempotency-Key`；`work_date` 和 `entries[]`；按人员批量新增或覆盖当天上工记录，整批原子提交 |
| POST | `/api/projects/{project_code}/labor-entries` | `assignment_id`、`work_date`、`attendance_status`、`day_fraction` 或 `work_minutes`、`work_summary`、`notes` |
| PUT | `/api/projects/{project_code}/labor-entries/{entry_id}` | 同上加 `expected_revision` |
| POST | `/api/projects/{project_code}/labor-entries/{entry_id}/void` | `reason`、`expected_revision` |
| GET | `/api/projects/{project_code}/site-daily-reports?page=&page_size=&from=&to=` | 返回施工日报分页列表 |
| PUT | `/api/projects/{project_code}/site-daily-reports/{work_date}` | `location`、`weather`、`work_summary`、`blockers`、`next_plan`、`notes`、`expected_revision`；首次传 `null` |
| POST | `/api/projects/{project_code}/site-daily-reports/{work_date}/confirm` | `confirmed_at`、`expected_revision` |
| POST | `/api/projects/{project_code}/site-daily-reports/{work_date}/reopen` | `reason`、`expected_revision` |

日薪记录使用 `day_fraction: "0.500"`，范围大于 0 且不超过 1；时薪记录使用整数 `work_minutes`。后端按排单费率计算并固化 `cost_cents`。

### 6.3 现场补买和人员垫资

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/material-advances?page=&page_size=&status=&worker_id=` | 返回垫资单分页列表 |
| POST | `/api/projects/{project_code}/material-advances` | `worker_id`、`spent_on`、`vendor_name`、`items`、`notes`、`document_version_ids` |
| GET | `/api/projects/{project_code}/material-advances/{advance_id}` | 返回垫资明细和报销记录 |
| PUT | `/api/projects/{project_code}/material-advances/{advance_id}` | 未报销前可编辑字段加 `expected_revision` |
| POST | `/api/projects/{project_code}/material-advances/{advance_id}/reimbursements` | Header `Idempotency-Key`；`amount_cents`、`reimbursed_on`、`payment_method`、`notes` |
| POST | `/api/projects/{project_code}/material-advances/{advance_id}/void` | `reason`、`expected_revision` |

`items`：`name`、`specification`、`brand`、`quantity`、`unit`、`unit_price_cents`、`line_amount_cents`。垫资单金额计入现场材料成本；后续报销只是偿还施工员，不再次计入项目成本。

垫资状态由报销累计自动计算：`unreimbursed | partial | reimbursed | voided`，前端不得手填。

## 7. P2：调试、验收、发票与售后

### 7.1 图纸会签、调试和技术变更

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/drawing-signoffs` | 固定返回 `mechanical`、`electrical` 两项 |
| PUT | `/api/projects/{project_code}/drawing-signoffs/{discipline}` | `status`、`confirmed_on`、`not_required_reason`、`notes`、`document_version_ids`、`expected_revision` |
| GET | `/api/projects/{project_code}/commissioning-sessions?page=&page_size=&status=` | 返回调试记录分页列表 |
| POST | `/api/projects/{project_code}/commissioning-sessions` | `started_at`、`ended_at`、`status`、`summary`、`issues`、`next_action`、`notes`、`document_version_ids` |
| PUT | `/api/projects/{project_code}/commissioning-sessions/{session_id}` | 可编辑字段加 `expected_revision` |
| GET | `/api/projects/{project_code}/engineering-changes?page=&page_size=&status=` | 返回变更分页列表 |
| POST | `/api/projects/{project_code}/engineering-changes` | `source`、`title`、`description`、`reason`、`contract_delta_cents`、`estimated_cost_delta_cents`、`schedule_delta_days`、`proposed_on`、`notes`、`document_version_ids` |
| PUT | `/api/projects/{project_code}/engineering-changes/{change_id}` | 可编辑字段加 `expected_revision` |
| POST | `/api/projects/{project_code}/engineering-changes/{change_id}/transition` | `to_status`、`effective_on`、`reason`、`expected_revision` |

会签状态：`pending | confirmed | not_required`。调试状态：`planned | in_progress | blocked | completed | cancelled`。变更状态：`proposed | approved | rejected | implemented | cancelled`。变更来源：`commissioning | customer_request | site_condition | technical_agreement | other`。`issues`、`next_action` 都是可空文本。变更的预估成本只进入预测，不冒充已发生成本。

### 7.2 验收和质保

验收类型：`pre_acceptance | final | reinspection`。验收状态：`scheduled | passed | passed_with_punch | failed | cancelled`。质保状态 `not_started | active | expiring | expired` 由日期实时计算，不由前端提交。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/acceptances?page=&page_size=` | 返回历次验收分页列表 |
| POST | `/api/projects/{project_code}/acceptances` | `acceptance_type`、`scheduled_on`、`notes`；返回 `201 AcceptanceRecord` |
| POST | `/api/projects/{project_code}/acceptances/{acceptance_id}/complete` | `performed_on`、`result`、`notes`、`document_version_ids`、`warranty`、`expected_revision`；返回 `{acceptance,warranty}` |
| GET | `/api/projects/{project_code}/warranty` | 返回 `WarrantyTerm` 或 `null` |
| PUT | `/api/projects/{project_code}/warranty` | `starts_on`、`duration_months`、`renewal_price_cents`、`notes`、`expected_revision` |

最终验收通过和质保创建必须处于同一事务。`ends_on` 按日历月计算，遇到短月取月末；`days_remaining=0` 表示今天到期，1 至 30 天为 `expiring`。

### 7.3 发票和售后

发票类型：`contract_payment | additional_work | warranty_service | other`。发票状态：`planned | requested | recorded | void`。售后保障方式：`warranty | paid | goodwill`。售后状态：`open | in_progress | completed | cancelled`。

| Method | Path | 请求/响应 |
|---|---|---|
| GET | `/api/projects/{project_code}/invoices?page=&page_size=&invoice_type=&status=` | 返回发票分页列表 |
| POST | `/api/projects/{project_code}/invoices` | `invoice_type`、`status`、`requested_on`、`recorded_on`、`invoice_number`、`amount_cents`、`counterparty_name`、`notes`、`document_version_ids` |
| PUT | `/api/projects/{project_code}/invoices/{invoice_id}` | 可编辑字段加 `expected_revision` |
| POST | `/api/projects/{project_code}/invoices/{invoice_id}/void` | `reason`、`expected_revision` |
| GET | `/api/projects/{project_code}/after-sales?page=&page_size=&status=` | 返回售后案件分页列表 |
| POST | `/api/projects/{project_code}/after-sales` | `reported_on`、`service_on`、`reason`、`contact_name`、`contact_phone`、`coverage_type`、`notes` |
| PUT | `/api/projects/{project_code}/after-sales/{case_id}` | 可编辑字段加 `expected_revision` |
| POST | `/api/projects/{project_code}/after-sales/{case_id}/transition` | `to_status`、`effective_at`、`resolution`、`reason`、`expected_revision` |
| GET | `/api/projects/{project_code}/delivery-summary` | 聚合施工、调试、验收、质保、尾款、发票、售后和待办 |

发票图片是可选附件。尾款计划和实收继续使用 P0 的 `payment-terms/final` 与 `receipts`，不另建第二套尾款接口。

## 8. 前端 TypeScript 边界

前端应分成两层：

```text
页面 / 组件
    ↓ 只依赖领域类型
ProjectRepository / ProcurementRepository / WorkforceRepository
    ├── Http...Repository   调真实 API
    └── Mock...Repository   仅开发预览，显式标记“演示数据”
```

当前契约不使用 `PATCH`。必须先扩展现有请求工具以支持自定义 Header、`multipart/form-data`、文件下载、`204`、分页和结构化错误。页面组件不得直接调用 `fetch`，也不得按“接口失败就偷偷返回 Mock”降级。

前端可以立即固定以下公共类型：`MoneyCents = number`、`DecimalString = string`、`ISODate = string`、`ISODateTime = string`、`Revision = number`、`PagedResult<T>`、`ApiErrorPayload`。金额展示统一由格式化函数处理，表单提交前保留分值整数。

## 9. 契约变更规则

1. 后端实现必须与本文一致，并以生成的 OpenAPI 做自动契约测试。
2. 已实现接口只能向后兼容扩展；需要破坏性修改时新增版本路径，不静默改字段。
3. 新状态、新字段和新错误码先更新本文和前端类型，再实现业务代码。
4. OpenAPI 与本文冲突时，在同一变更内修正，禁止把兼容分支永久留在前端。
5. 本文不承诺尚未标记“已实现”的接口已经可调用；Mock 只用于页面预览。
