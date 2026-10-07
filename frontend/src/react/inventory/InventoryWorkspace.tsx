import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Descriptions, Drawer, Empty, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { MinusCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import type { PagedResult } from '../../domain/contracts'
import type { InventoryItemDto, InventoryMovementDto } from '../../domain/operations-api'
import { localISODate } from '../../domain/dates'
import { formatMoney } from '../../domain/formatters'
import { createHttpInventoryRepository, type InventoryHttpRepository, type InventoryIssueProjectOption, type InventoryIssueWorkerOption, type InventoryListQuery } from '../../repositories/inventory.live'
import { mutationScope, optional, quantityMilli, required, textValue } from '../procurement/model'
import { ActionFeedback, errorText, FormModal, TextField, useBusinessActions, type FormValues } from '../procurement/ui'
import { adjustmentInput, inventoryInput, issueInput, movementLabel } from './model'
import styles from './InventoryWorkspace.module.css'

const defaultRepository = createHttpInventoryRepository()
const emptyPage = <T,>(): PagedResult<T> => ({ items: [], page: 1, page_size: 20, total: 0 })
const statusLabels = { all: '全部库存', in_stock: '有库存', out_of_stock: '零库存' }
type Dialog = 'create' | 'edit' | 'adjust' | 'issue' | 'reverse-adjustment' | 'reverse-issue' | null

export default function InventoryWorkspace({ repository = defaultRepository }: { repository?: InventoryHttpRepository }) {
  const [page, setPage] = useState(emptyPage<InventoryItemDto>)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [status, setStatus] = useState<InventoryListQuery['status']>('all')
  const [selected, setSelected] = useState<InventoryItemDto | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [movements, setMovements] = useState(emptyPage<InventoryMovementDto>)
  const [movementLoading, setMovementLoading] = useState(false)
  const [movementError, setMovementError] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [targetItem, setTargetItem] = useState<InventoryItemDto | null>(null)
  const [targetMovement, setTargetMovement] = useState<InventoryMovementDto | null>(null)
  const [issueItems, setIssueItems] = useState<InventoryItemDto[]>([])
  const [issueCandidateIds, setIssueCandidateIds] = useState<number[]>([])
  const [projects, setProjects] = useState<InventoryIssueProjectOption[]>([])
  const [workers, setWorkers] = useState<InventoryIssueWorkerOption[]>([])
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [optionsError, setOptionsError] = useState('')
  const [form] = Form.useForm()
  const [confirm, confirmContext] = Modal.useModal()
  const scope = mutationScope(repository, 'inventory')
  const context = useRef({ repository, list: 0, detail: 0, items: 0, workers: 0, mounted: true })
  context.current.repository = repository
  const issueProject = Form.useWatch('project_code', form) as string | undefined
  const selectedIssueLines = Form.useWatch('lines', form) as Array<{ inventory_item_id?: number }> | undefined
  const selectedIssueIds = new Set((selectedIssueLines ?? []).map((line) => line.inventory_item_id))
  const issueOptions = issueItems.filter((item) => issueCandidateIds.includes(item.id) || selectedIssueIds.has(item.id))
  const adjustmentQuantity = Form.useWatch('quantity_delta', form) as string | undefined

  const loadList = useCallback(async (requestedPage = page.page, pageSize = page.page_size, requestedQuery = appliedQuery, requestedStatus = status) => {
    const sequence = ++context.current.list
    setLoading(true); setError('')
    try {
      const result = await repository.listInventoryItems({ page: requestedPage, page_size: pageSize, status: requestedStatus, ...(requestedQuery ? { query: requestedQuery } : {}) })
      if (context.current.mounted && context.current.repository === repository && sequence === context.current.list) setPage(result.data)
    } catch (failure) {
      if (context.current.mounted && context.current.repository === repository && sequence === context.current.list) setError(errorText(failure))
      throw failure
    } finally { if (context.current.mounted && context.current.repository === repository && sequence === context.current.list) setLoading(false) }
  }, [repository, page.page, page.page_size, appliedQuery, status])

  function applyFilters(nextQuery: string, nextStatus = status) {
    setAppliedQuery(nextQuery.trim()); setStatus(nextStatus)
    void loadList(1, page.page_size, nextQuery.trim(), nextStatus).catch(() => undefined)
  }
  function clearFilters() { setQuery(''); applyFilters('', 'all') }

  async function loadDetail(item: InventoryItemDto, movementPage = 1) {
    const sequence = ++context.current.detail
    const current = () => context.current.mounted && context.current.repository === repository && sequence === context.current.detail
    setDetailLoading(true); setMovementLoading(true); setDetailError(''); setMovementError('')
    await Promise.allSettled([
      repository.getInventoryItem(item.id).then((result) => { if (current()) setSelected(result.data) }).catch((failure) => { if (current()) setDetailError(`详情读取失败，当前显示已载入资料：${errorText(failure)}`) }).finally(() => { if (current()) setDetailLoading(false) }),
      repository.listInventoryMovements(item.id, { page: movementPage, page_size: 20 }).then((result) => { if (current()) setMovements(result.data) }).catch((failure) => { if (current()) setMovementError(`流水读取失败：${errorText(failure)}`) }).finally(() => { if (current()) setMovementLoading(false) }),
    ])
  }
  async function refresh() { await loadList(); if (drawer && selected) await loadDetail(selected, movements.page) }
  const actions = useBusinessActions(scope, refresh, () => setDialog(null))

  useEffect(() => {
    context.current.mounted = true; context.current.list++; context.current.detail++
    setSelected(null); setDrawer(false); setDialog(null); setPage(emptyPage()); setMovements(emptyPage())
    setQuery(''); setAppliedQuery(''); setStatus('all')
    void loadList(1, 20, '', 'all').catch(() => undefined)
    return () => { context.current.mounted = false; context.current.list++; context.current.detail++; context.current.items++; context.current.workers++ }
  // Repository changes start a new isolated workspace.
  }, [repository])

  async function loadIssueItems(search = '') {
    const sequence = ++context.current.items
    setOptionsLoading(true); setOptionsError('')
    try {
      const result = await repository.listInventoryItems({ page: 1, page_size: 200, status: 'in_stock', ...(search ? { query: search } : {}) })
      if (sequence === context.current.items && context.current.repository === repository && context.current.mounted) {
        setIssueItems((previous) => [...new Map([...previous, ...result.data.items].map((item) => [item.id, item])).values()])
        setIssueCandidateIds(result.data.items.map((item) => item.id))
      }
    } catch (failure) { if (sequence === context.current.items && context.current.mounted) setOptionsError(errorText(failure)) }
    finally { if (sequence === context.current.items && context.current.mounted) setOptionsLoading(false) }
  }
  async function loadIssueProjects() {
    const activeRepository = repository
    try {
      const result = await repository.listIssueProjects()
      if (context.current.mounted && context.current.repository === activeRepository) setProjects(result.data)
    } catch (failure) { if (context.current.mounted && context.current.repository === activeRepository) setOptionsError(errorText(failure)) }
  }
  async function loadIssueWorkers(projectCode: string) {
    const sequence = ++context.current.workers
    try {
      const result = await repository.listProjectIssueWorkers(projectCode)
      if (sequence === context.current.workers && context.current.repository === repository && context.current.mounted) setWorkers(result.data)
    } catch (failure) {
      if (sequence === context.current.workers && context.current.repository === repository && context.current.mounted) setOptionsError(errorText(failure))
    }
  }
  useEffect(() => {
    context.current.workers++
    setWorkers([]); form.setFieldValue('worker_id', null)
    if (dialog !== 'issue' || !issueProject) return
    void loadIssueWorkers(issueProject)
  }, [issueProject, dialog, repository, form])

  function open(kind: Exclude<Dialog, null>, item?: InventoryItemDto, movement?: InventoryMovementDto) {
    if (actions.pending) return
    actions.setError(''); setOptionsError(''); setTargetItem(item ?? null); setTargetMovement(movement ?? null)
    form.resetFields()
    form.setFieldsValue({ ...(kind === 'edit' ? item : {}), opening_quantity: '0', occurred_on: localISODate(), issued_on: localISODate(), lines: item ? [{ inventory_item_id: item.id, quantity: '' }] : [] })
    setDialog(kind)
    if (kind === 'issue' && item) {
      setIssueItems([item]); setIssueCandidateIds([item.id]); setProjects([]); setWorkers([])
      void loadIssueProjects()
      void loadIssueItems()
    }
  }
  function openDetail(item: InventoryItemDto) {
    setSelected(item); setMovements(emptyPage()); setDrawer(true); void loadDetail(item)
  }
  async function submit(values: FormValues) {
    if (actions.pending) return
    try {
      if (dialog === 'create') {
        const input = inventoryInput(values)
        await actions.run('新增库存', () => repository.createInventoryItem(input), () => repository.discardCreateInventoryItem(input))
      } else if (dialog === 'edit' && targetItem) {
        const input = { name: required(values.name, '物料名称'), unit: required(values.unit, '计量单位'), brand: optional(values.brand), model: optional(values.model), specification: optional(values.specification), notes: optional(values.notes), expected_revision: targetItem.revision }
        const id = targetItem.id
        await actions.run('库存资料', () => repository.updateInventoryItem(id, input))
      } else if (dialog === 'adjust' && targetItem) {
        const input = adjustmentInput(targetItem.id, values)
        await actions.run('库存调整', () => repository.createInventoryAdjustment(input), () => repository.discardCreateInventoryAdjustment(input))
      } else if (dialog === 'issue') {
        const project = required(values.project_code, '领用项目')
        if (!projects.some((entry) => entry.project_code === project)) throw new Error('请选择有效的在建项目')
        const input = issueInput(values, issueItems)
        if (input.worker_id !== null && !workers.some((worker) => worker.worker_id === input.worker_id)) throw new Error('请选择当前项目施工员')
        await actions.run('项目领用', () => repository.createProjectInventoryIssue(project, input), () => repository.discardCreateProjectInventoryIssue(project, input))
      } else if (targetMovement && (dialog === 'reverse-adjustment' || dialog === 'reverse-issue')) {
        const movement = targetMovement
        const adjustment = dialog === 'reverse-adjustment'
        const revision = adjustment ? movement.adjustment_revision : movement.issue_revision
        if (!revision) throw new Error('记录版本无效，请刷新后重试')
        const input = { reason: required(values.reason, '冲销原因'), expected_revision: revision }
        const activeScope = scope
        const approved = await confirm.confirm({ title: adjustment ? '确认冲销库存调整？' : '确认冲销项目领用？', content: `按原记录 #${movement.source_id} 回退数量和成本，保留历史流水。`, okText: '确认冲销', cancelText: '返回检查', okButtonProps: { danger: true } })
        if (!approved || activeScope !== mutationScope(context.current.repository, 'inventory') || !context.current.mounted) return
        if (adjustment) await actions.run('调整冲销', () => repository.reverseInventoryAdjustment(movement.source_id, input), () => repository.discardReverseInventoryAdjustment(movement.source_id, input))
        else {
          const project = required(movement.project_code, '原领用项目')
          await actions.run('领用冲销', () => repository.reverseProjectInventoryIssue(project, movement.source_id, input), () => repository.discardReverseProjectInventoryIssue(project, movement.source_id, input))
        }
      }
    } catch (failure) { actions.setError(errorText(failure)) }
  }
  const titles: Record<Exclude<Dialog, null>, string> = { create: '新增库存', edit: '编辑物料资料', adjust: '库存调整', issue: '项目领用', 'reverse-adjustment': '冲销库存调整', 'reverse-issue': '冲销项目领用' }

  return <section className={styles.workspace}>
    {confirmContext}
    <div className={styles.header}><div><Typography.Title level={3}>库存中心</Typography.Title><Typography.Text type="secondary">跟踪物料数量、库存价值和每一笔出入库</Typography.Text></div>
      <Space><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh().catch(() => undefined)}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={Boolean(actions.pending) || loading} onClick={() => open('create')}>新增库存</Button></Space></div>
    <ActionFeedback actions={actions} />
    {error && <Alert type="error" showIcon title={error} description={page.items.length ? '当前保留上次成功读取的库存，本次筛选结果尚未更新。' : undefined} action={<Button onClick={() => void loadList().catch(() => undefined)}>重新读取</Button>} />}
    <Card styles={{ body: { padding: 16 } }}>
      <div className={styles.toolbar}>
        <div><Typography.Title level={5}>{appliedQuery || status !== 'all' ? '筛选结果' : '当前库存'} <Typography.Text type="secondary">{page.total} 项</Typography.Text></Typography.Title><Typography.Text type="secondary">点击物料名称查看资料与出入库流水。</Typography.Text></div>
        <div className={styles.filters}>
          <label className={styles.filterField}><span>库存状态</span><Select aria-label="库存状态" value={status} options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))} onChange={(value) => applyFilters(appliedQuery, value)} /></label>
          <label className={styles.filterField} htmlFor="inventory-search"><span>物料搜索</span><Input id="inventory-search" prefix={<SearchOutlined />} placeholder="搜索品牌、名称、型号" value={query} onChange={(event) => {
            const next = event.target.value
            setQuery(next)
            if (!next.trim() && appliedQuery) applyFilters('')
          }} onPressEnter={() => applyFilters(query)} allowClear /></label>
          <Button onClick={() => applyFilters(query)}>查询</Button>
        </div>
      </div>
      {(appliedQuery || status !== 'all') && <div className={styles.filterTags} aria-label="当前库存筛选">
        <Typography.Text type="secondary">当前筛选</Typography.Text>
        {appliedQuery && <Tag closable onClose={(event) => { event.preventDefault(); setQuery(''); applyFilters('') }}>关键词：{appliedQuery}</Tag>}
        {status !== 'all' && <Tag closable onClose={(event) => { event.preventDefault(); applyFilters(appliedQuery, 'all') }}>状态：{statusLabels[status ?? 'all']}</Tag>}
        <Button type="link" size="small" onClick={clearFilters}>清除筛选</Button>
      </div>}
      <Table<InventoryItemDto> size="small" rowKey="id" loading={loading} dataSource={page.items} scroll={{ x: 720 }} locale={{ emptyText: <Empty description={error ? '库存读取失败，请重新读取' : appliedQuery || status !== 'all' ? '没有符合当前条件的物料' : '尚未建立库存，先登记物料和期初数量'}>{!error && (appliedQuery || status !== 'all' ? <Button onClick={clearFilters}>清除筛选</Button> : <Button type="primary" disabled={Boolean(actions.pending)} onClick={() => open('create')}>登记第一项库存</Button>)}</Empty> }} pagination={{ current: page.page, pageSize: page.page_size, total: page.total, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (total) => `共 ${total} 项`, onChange: (number, size) => void loadList(size !== page.page_size ? 1 : number, size).catch(() => undefined) }} columns={[
        { title: '物料', key: 'name', width: 280, render: (_, item) => <><Button className={styles.materialLink} type="link" onClick={() => openDetail(item)}>{item.name}</Button><div className={styles.secondary}>{[item.brand, item.model, item.specification].filter(Boolean).join(' · ') || '暂无品牌、型号和规格说明'}</div></> },
        { title: '可用数量', key: 'quantity', width: 140, align: 'right', render: (_, item) => <><strong className={styles.number}>{item.quantity} <small>{item.unit}</small></strong>{quantityMilli(item.quantity) === 0n && <div className={styles.secondary}>暂无库存</div>}</> },
        { title: '库存价值', key: 'value', width: 160, align: 'right', render: (_, item) => <><strong className={styles.number}>{formatMoney(item.inventory_value_cents)}</strong><div className={styles.secondary}>均价 {formatMoney(item.average_unit_cost_cents)} / {item.unit}</div></> },
        { title: '操作', key: 'actions', fixed: 'right', width: 160, render: (_, item) => <Space size={4}><Button type="link" disabled={Boolean(actions.pending)} onClick={() => open('adjust', item)}>调整</Button><Button type="link" disabled={Boolean(actions.pending) || quantityMilli(item.quantity) === 0n} onClick={() => open('issue', item)}>项目领用</Button></Space> },
      ]} />
    </Card>
    <Drawer title={selected?.name ?? '物料详情'} open={drawer} size={900} onClose={() => { setDrawer(false); context.current.detail++ }} extra={<Button disabled={detailLoading || Boolean(actions.pending)} onClick={() => selected && open('edit', selected)}>编辑资料</Button>}>
      <Space orientation="vertical" style={{ width: '100%' }}>
        {detailError && <Alert type="warning" showIcon title={detailError} action={<Button onClick={() => selected && void loadDetail(selected, movements.page)}>重试</Button>} />}
        {selected && <>
          <div className={styles.detailSummary}>
            <div><span>现存数量</span><strong>{selected.quantity} <small>{selected.unit}</small></strong></div>
            <div><span>库存价值</span><strong>{formatMoney(selected.inventory_value_cents)}</strong></div>
            <div><span>平均单价</span><strong>{formatMoney(selected.average_unit_cost_cents)} <small>/ {selected.unit}</small></strong></div>
          </div>
          <div className={styles.detailActions}><Typography.Text type="secondary">出入库会同步更新数量和库存价值。</Typography.Text><Space><Button disabled={detailLoading || Boolean(actions.pending)} onClick={() => open('adjust', selected)}>调整库存</Button><Button type="primary" disabled={detailLoading || Boolean(actions.pending) || quantityMilli(selected.quantity) === 0n} onClick={() => open('issue', selected)}>领用到项目</Button></Space></div>
          <Typography.Title level={5}>物料资料</Typography.Title>
          <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
            { key: 'brand', label: '品牌', children: selected.brand || '—' }, { key: 'model', label: '型号', children: selected.model || '—' },
            { key: 'specification', label: '规格', span: 'filled', children: selected.specification || '—' },
            { key: 'notes', label: '备注', span: 'filled', children: selected.notes || '—' },
          ]} />
        </>}
        <div className={styles.sectionHeading}><Typography.Title level={5}>出入库流水</Typography.Title><Typography.Text type="secondary">按原记录核对数量、金额与去向。错误登记可冲销，历史记录仍会保留。</Typography.Text></div>
        {movementError && <Alert type="warning" showIcon title={movementError} action={<Button onClick={() => selected && void loadDetail(selected, movements.page)}>重试</Button>} />}
        <Table<InventoryMovementDto> size="small" rowKey="id" dataSource={movements.items} loading={movementLoading} scroll={{ x: 790 }} locale={{ emptyText: movementError ? '流水读取失败，请重新读取' : '此物料暂无出入库流水' }} pagination={{ current: movements.page, pageSize: movements.page_size, total: movements.total, onChange: (number) => selected && void loadDetail(selected, number) }} columns={[
          { title: '日期', dataIndex: 'occurred_on', width: 110 }, { title: '类型', key: 'type', render: (_, item) => <Tag>{movementLabel(item)}</Tag> },
          { title: '数量变化', dataIndex: 'quantity_delta', align: 'right' }, { title: '金额变化', dataIndex: 'value_delta_cents', render: formatMoney, align: 'right' },
          { title: '项目 / 说明', key: 'reason', render: (_, item) => [item.project_code, item.reason].filter(Boolean).join(' · ') || '—' },
          { title: '操作', key: 'action', render: (_, item) => item.movement_type === 'adjustment' && item.source_type === 'inventory_adjustment' && item.adjustment_status === 'active' && item.adjustment_revision
            ? <Button type="link" danger disabled={Boolean(actions.pending)} onClick={() => open('reverse-adjustment', selected ?? undefined, item)}>冲销调整</Button>
            : item.movement_type === 'project_issue' && item.source_type === 'inventory_issue' && item.issue_status === 'active' && item.issue_revision && item.project_code
              ? <Button type="link" danger disabled={Boolean(actions.pending)} onClick={() => open('reverse-issue', selected ?? undefined, item)}>冲销领用</Button> : '—' },
        ]} />
      </Space>
    </Drawer>
    <FormModal title={dialog ? titles[dialog] : ''} form={form} open={dialog !== null} onClose={() => setDialog(null)} onSubmit={submit} busy={actions.busy} locked={Boolean(actions.pending)} error={actions.error} width={dialog === 'issue' ? 860 : 660}>
      {(dialog === 'create' || dialog === 'edit') && <>
        <div className={styles.formGrid}><TextField name="name" label="物料名称" required /><TextField name="unit" label="计量单位" required /><TextField name="brand" label="品牌" /><TextField name="model" label="型号" /></div>
        <TextField name="specification" label="规格" />
        {dialog === 'create' && <section className={styles.formSection}><Typography.Title level={5}>期初库存</Typography.Title><p>登记当前已有的数量；没有库存时保留为 0。数量大于 0 时需填写成本单价。</p><div className={styles.formGrid}><TextField name="opening_quantity" label="期初数量" required /><TextField name="cost" label="期初成本单价（元）" /></div></section>}
        <TextField name="notes" label="备注" type="textarea" />
      </>}
      {dialog === 'adjust' && <><Alert type="info" title={`调整 ${targetItem?.name}，当前 ${targetItem?.quantity} ${targetItem?.unit}`} /><TextField name="quantity_delta" label="数量变化" required placeholder="增加填 2.000，减少填 -0.500" extra={`填写变化量，单位：${targetItem?.unit ?? '物料单位'}。最多保留三位小数。`} />{!textValue(adjustmentQuantity).startsWith('-') && <TextField name="cost" label="本次成本单价（元）" required extra="增加库存按本次成本入账；减少库存沿用当前平均成本。" />}<TextField name="occurred_on" label="发生日期" type="date" required /><TextField name="reason" label="调整原因" required type="textarea" /></>}
      {dialog === 'issue' && <>
        {optionsError && <Alert type="error" title={optionsError} showIcon action={<Button onClick={() => { void loadIssueProjects(); void loadIssueItems(); if (issueProject) void loadIssueWorkers(issueProject) }}>重新读取选项</Button>} />}
        <section className={styles.formSection}><Typography.Title level={5}>领用去向</Typography.Title><p>领用会减少库存，并计入所选项目的材料成本。请核对项目后再保存。</p>
          <div className={styles.formGrid}><Form.Item name="project_code" label="领用项目" rules={[{ required: true, message: '请选择领用项目' }]}><Select placeholder="请选择在建项目" showSearch optionFilterProp="label" options={projects.map((project) => ({ value: project.project_code, label: `${project.name} · ${project.project_code}` }))} /></Form.Item>
            <Form.Item name="worker_id" label="项目施工员" extra="可选，选择项目后可指定施工员。"><Select allowClear disabled={!issueProject} placeholder={issueProject ? '可不指定施工员' : '先选择领用项目'} options={workers.map((worker) => ({ value: worker.worker_id, label: `${worker.name} · ${worker.role}` }))} /></Form.Item></div>
          <TextField name="issued_on" label="领用日期" type="date" required />
        </section>
        <section className={styles.formSection}><Typography.Title level={5}>领用物料</Typography.Title><p>只填写本次实际领用数量，可添加多项物料。</p>
          <Form.List name="lines">{(fields, { add, remove }) => <Space orientation="vertical" style={{ width: '100%' }}>{fields.map((field) => {
            const item = issueItems.find((entry) => entry.id === selectedIssueLines?.[field.name]?.inventory_item_id)
            return <div className={styles.issueRow} key={field.key}>
              <Form.Item name={[field.name, 'inventory_item_id']} label="库存物料" rules={[{ required: true, message: '请选择物料' }]}><Select showSearch placeholder="搜索并选择库存物料" filterOption={false} loading={optionsLoading} onSearch={(value) => void loadIssueItems(value)} options={issueOptions.map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.model || ''} · 库存 ${entry.quantity} ${entry.unit}` }))} /></Form.Item>
              <TextField name={[field.name, 'quantity']} label="领用数量" required placeholder="本次领用量" extra={item ? `可用 ${item.quantity} ${item.unit}` : '请先选择物料'} />
              <Button aria-label="移除领用物料" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
            </div>
          })}<Button block type="dashed" icon={<PlusOutlined />} onClick={() => add({ quantity: '' })}>添加领用物料</Button></Space>}</Form.List>
        </section>
        <TextField name="notes" label="领用说明" type="textarea" />
      </>}
      {(dialog === 'reverse-adjustment' || dialog === 'reverse-issue') && <><Alert type="warning" title={`冲销原记录 #${targetMovement?.source_id}，数量 ${targetMovement?.quantity_delta}`} /><TextField name="reason" label="冲销原因" required type="textarea" /></>}
    </FormModal>
  </section>
}
