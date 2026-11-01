import '@testing-library/jest-dom/vitest'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ProcurementWorkspace from '../procurement/ProcurementWorkspace'
import type { ProcurementHttpRepository } from '../../repositories/procurement.live'
import ProcurementLists from '../procurement/ProcurementLists'
import type { ProcurementLineDto, ProcurementListDetailDto } from '../../domain/operations-api'

const access = vi.hoisted(() => ({ can: (_permission: string): boolean => true, namespace: 'account:1', user: null }))
vi.mock('../access/useAccess', () => ({ useAccess: () => access }))
vi.mock('../activity/OperationHistory', () => ({ OperationHistory: () => <span>操作记录</span> }))
vi.mock('../activity/ActivitySummary', () => ({ ActivitySummary: () => <span>历史未记录</span> }))
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable:true, value: () => ({ matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return true} }) })
  globalThis.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }
  const original = window.getComputedStyle.bind(window)
  window.getComputedStyle = element => original(element)
})
afterEach(() => { cleanup(); access.can = () => true })
const base = { procurement_list_id:1, inventory_item_id:null, sequence_no:1, category:'测试', specification:null, brand:null, model:null, quantity:'1.000', unit:'件', unit_cost_cents:100, quoted_unit_price_cents:200, cost_total_cents:100, quoted_total_cents:200, ordered_quantity:'0.000', ordered_amount_cents:0, paid_amount_cents:0, received_quantity:'0.000', invoiced_amount_cents:0, issued_quantity:'0.000', order_status:'not_ordered', payment_status:'unpaid', receipt_status:'not_received', invoice_status:'not_invoiced', usage_status:'unused', revision:1, created_at:'', updated_at:'' } as const
const a: ProcurementLineDto = { ...base, id:1, name:'物料 A', confirmation_status:'confirmed', confirmed_at:'2026-10-31', can_reopen:false, edit_block_reason:'已被采购单 PO-001 引用，保留历史内容，不可撤回或修改' }
const b: ProcurementLineDto = { ...base, id:2, sequence_no:2, name:'物料 B', confirmation_status:'draft', confirmed_at:null, can_reopen:false, edit_block_reason:null }
const list: ProcurementListDetailDto = { id:1, project_code:'P-001', name:'部分确认清单', notes:null, status:'draft', revision:3, line_count:2, confirmed_line_count:1, confirmed_at:null, cost_total_cents:200, quoted_total_cents:400, lines:[a,b], created_at:'', updated_at:'' }
function props() { return { lists:[list], selectedId:1, onSelect:vi.fn(), loading:false, readonly:false, locked:false, onCreate:vi.fn(), onImport:vi.fn(), onAddLine:vi.fn(), onEditList:vi.fn(), onConfirmList:vi.fn(), onCopyList:vi.fn(), onQuote:vi.fn(), quoteAvailable:true, onEditLine:vi.fn(), onDeleteLine:vi.fn(), onOrderLine:vi.fn(), onConfirmLine:vi.fn(), onReopenLine:vi.fn() } }
it('已采购 A 不锁住 B，逐项确认和部分报价直接可用', () => {
  const callbacks = props()
  render(<ProcurementLists {...callbacks} />)
  const rowA = screen.getByText('物料 A').closest('tr')!
  const rowB = screen.getByText('物料 B').closest('tr')!
  expect(within(rowA).getByText(/已被采购单 PO-001/)).toBeTruthy()
  expect(within(rowB).getByRole('button',{name:'编辑'})).toBeEnabled()
  fireEvent.click(within(rowB).getByRole('button',{name:'确认'}))
  expect(callbacks.onConfirmLine).toHaveBeenCalledWith(list,b)
  expect(screen.queryByRole('button',{name:'确认清单'})).toBeNull()
  expect(screen.getByText('已确认 1/2')).toBeTruthy()
  expect(screen.getByRole('button',{name:'客户报价'})).toBeEnabled()
})
it('未引用已确认项可撤回，无权限与引用原因分别展示', () => {
  access.can = permission => permission !== 'procurement.lines.confirm'
  const callbacks = props()
  render(<ProcurementLists {...callbacks} lists={[{...list,lines:[{...a,can_reopen:true,edit_block_reason:'此项已确认，请先撤回确认后编辑'},b]}]} />)
  expect(screen.getByRole('button',{name:'撤回确认'})).toBeEnabled()
  expect(screen.getByRole('button',{name:'确认'})).toBeDisabled()
  expect(screen.getByText('无确认权限')).toBeTruthy()
})

it('有导出权限但无价格权限时不能生成含价格的报价文件', () => {
  access.can = permission => permission !== 'sensitive.procurement_prices'
  render(<ProcurementLists {...props()} />)
  expect(screen.getByRole('button', {name:'客户报价'})).toBeDisabled()
  expect(screen.getByRole('button', {name:'添加物料'})).toBeDisabled()
  expect(screen.getByRole('button', {name:'编辑'})).toBeDisabled()
  expect(screen.getByRole('button', {name:'建立采购单'})).toBeDisabled()
  expect(screen.getByRole('button', {name:'编辑清单'})).toBeEnabled()
  expect(screen.getByRole('button', {name:'确认'})).toBeEnabled()
})

it('行展开摘要不显示未授权的付款发票和到货内容', () => {
  access.can = permission => !['procurement.payments.view', 'procurement.invoices.view', 'procurement.receipts.view'].includes(permission)
  render(<ProcurementLists {...props()} />)
  fireEvent.click(screen.getByRole('button', {name:'展开物料 B明细'}))
  expect(screen.queryByText('累计付款')).toBeNull()
  expect(screen.queryByText('累计开票')).toBeNull()
  expect(screen.queryByText('累计到货')).toBeNull()
})

it('已采购数量被权限隐藏时可显示已确认行，但未知余量不能用于下单', () => {
  const hidden = { ...a, ordered_quantity: null } as unknown as ProcurementLineDto
  const callbacks = props()
  render(<ProcurementLists {...callbacks} lists={[{...list, lines:[hidden]}]} />)
  expect(screen.getByRole('button', {name:'建立采购单'})).toBeDisabled()
  expect(screen.getByText('已购 —')).toBeTruthy()
  expect(callbacks.onOrderLine).not.toHaveBeenCalled()
})

function liveRepository(current = list): ProcurementHttpRepository {
  const result = <T,>(data: T) => Promise.resolve({ source: 'live', data })
  return {
    listSupplierCompanies: () => result([{id:1,name:'供应商'}]),
    listProcurementLists: () => result({items:[current],total:1,page:1,page_size:20}),
    getProcurementList: () => result(current),
    listPurchaseOrders: () => result({items:[],total:0,page:1,page_size:20}),
    listQuoteExports: () => result({items:[],total:0,page:1,page_size:20}),
    listDocumentVersionOptions: async () => [],
    getProcurementOverview: () => result({line_count:1,line_status_counts:{},project_code:'P-001'}),
    confirmProcurementLine: vi.fn(async () => result({...b,confirmation_status:'confirmed'})),
    discardConfirmProcurementLine: () => true,
    reopenProcurementLine: vi.fn(async () => result({...a,confirmation_status:'draft'})),
    discardReopenProcurementLine: () => true,
  } as unknown as ProcurementHttpRepository
}
it('工作区确认仅提交目标行 revision，不确认整张清单', async () => {
  const repo = liveRepository()
  render(<ProcurementWorkspace projectCode="P-001" repository={repo} customerCompany={{id:1,name:'客户'}} />)
  const row = (await screen.findByText('物料 B')).closest('tr')!
  fireEvent.click(within(row).getByRole('button',{name:'确认'}))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button',{name:'确认当前项'}))
  await waitFor(() => expect(repo.confirmProcurementLine).toHaveBeenCalledWith('P-001',1,2,{expected_revision:1}))
})
it('撤回表单保留当前项并要求填写原因后提交', async () => {
  const repo = liveRepository({...list,lines:[{...a,can_reopen:true,edit_block_reason:'此项已确认，请先撤回确认后编辑'},b]})
  render(<ProcurementWorkspace projectCode="P-REOPEN" repository={repo} customerCompany={{id:1,name:'客户'}} />)
  fireEvent.click(await screen.findByRole('button',{name:'撤回确认'}))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button',{name:/保\s*存/}))
  expect(await within(dialog).findByText('请填写撤回原因')).toBeTruthy()
  expect(repo.reopenProcurementLine).not.toHaveBeenCalled()
  fireEvent.change(within(dialog).getByLabelText('撤回原因'),{target:{value:'调整数量'}})
  fireEvent.click(within(dialog).getByRole('button',{name:/保\s*存/}))
  await waitFor(() => expect(repo.reopenProcurementLine).toHaveBeenCalledWith('P-REOPEN',1,1,{expected_revision:1,reason:'调整数量'}))
})
it('新采购单选择器不纳入待确认项', async () => {
  const hidden = {...a, id:3, name:'余量不可读物料', ordered_quantity:null} as unknown as ProcurementLineDto
  const repo = liveRepository({...list, lines:[a,b,hidden]})
  render(<ProcurementWorkspace projectCode="P-SELECT" repository={repo} customerCompany={{id:1,name:'客户'}} />)
  fireEvent.click(await screen.findByRole('tab',{name:/采购单/}))
  const create = await screen.findByRole('button',{name:/新建采购单/})
  await waitFor(() => expect(create).toBeEnabled())
  fireEvent.click(create)
  const dialog = await screen.findByRole('dialog')
  fireEvent.mouseDown(within(dialog).getByLabelText('采购物料'))
  expect(await screen.findByText(/物料 A · 部分确认清单/)).toBeTruthy()
  expect(screen.queryByText(/物料 B · 部分确认清单/)).toBeNull()
  expect(screen.queryByText(/余量不可读物料 · 部分确认清单/)).toBeNull()
})
it('没有采购单与导入权限时不显示相应页签', async () => {
  access.can = permission => !['procurement.orders.view', 'procurement.lines.import'].includes(permission)
  render(<ProcurementWorkspace projectCode="P-NO-ORDERS" repository={liveRepository()} customerCompany={{id:1,name:'客户'}} />)
  await screen.findByRole('button',{name:'查看清单 部分确认清单'})
  expect(screen.queryByRole('tab',{name:/采购单/})).toBeNull()
  expect(screen.queryByRole('tab',{name:'Excel 导入'})).toBeNull()
})
