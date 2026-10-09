import { useEffect, useRef, useState } from 'react'
import type { CompanyRecord, PagedResult } from '../../domain/contracts'
import type { ProcurementListDetailDto, ProcurementListSummaryDto, ProcurementOverviewDto, PurchaseOrderDto } from '../../domain/operations-api'
import type { QuoteExportDto } from '../../domain/procurement-extensions'
import type { ProcurementHttpRepository, ProcurementOptions } from '../../repositories/procurement.live'
import { createHttpProjectRepository } from '../../repositories/project'
import type { DocumentVersionOption } from '../../repositories/project-operating.live'
import { errorText } from './ui'

export type Customer = { id: number; name: string }
const emptyPage = <T,>(): PagedResult<T> => ({ items: [], page: 1, page_size: 20, total: 0 })

export function useProcurementData(repository: ProcurementHttpRepository, projectCode: string, suppliedCustomer?: Customer) {
  const [lists, setLists] = useState<ProcurementListDetailDto[]>([])
  const [options, setOptions] = useState<ProcurementOptions | null>(null)
  const [listPage, setListPage] = useState(emptyPage<ProcurementListSummaryDto>)
  const [orders, setOrders] = useState(emptyPage<PurchaseOrderDto>)
  const [overview, setOverview] = useState<ProcurementOverviewDto | null>(null)
  const [companies, setCompanies] = useState<CompanyRecord[]>([])
  const [documents, setDocuments] = useState<DocumentVersionOption[]>([])
  const [quotes, setQuotes] = useState(emptyPage<QuoteExportDto>)
  const [customer, setCustomer] = useState<Customer | null>(suppliedCustomer ?? null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const state = useRef({ repository, projectCode, mounted: true, generation: 0, sequence: {} as Record<string, number> })
  state.current.repository = repository; state.current.projectCode = projectCode
  async function section<T>(key: string, request: () => Promise<T>, apply: (value: T) => void) {
    const generation = state.current.generation
    const sequence = (state.current.sequence[key] ?? 0) + 1
    state.current.sequence[key] = sequence
    const isCurrent = () => state.current.mounted && state.current.repository === repository && state.current.projectCode === projectCode && state.current.generation === generation && state.current.sequence[key] === sequence
    setLoading((previous) => ({ ...previous, [key]: true })); setErrors((previous) => ({ ...previous, [key]: '' }))
    try { const result = await request(); if (isCurrent()) apply(result) }
    catch (failure) { if (isCurrent()) setErrors((previous) => ({ ...previous, [key]: errorText(failure) })); throw failure }
    finally { if (isCurrent()) setLoading((previous) => ({ ...previous, [key]: false })) }
  }
  function loadLists(page = listPage.page, pageSize = listPage.page_size) {
    return section('采购清单', async () => {
      const result = await repository.listProcurementLists(projectCode, { page, page_size: pageSize })
      const details = await Promise.allSettled(result.data.items.map((item) => repository.getProcurementList(projectCode, item.id)))
      return { page: result.data, details: details.flatMap((item) => item.status === 'fulfilled' ? [item.value.data] : []), failures: details.filter((item) => item.status === 'rejected').length }
    }, (result) => {
      setListPage(result.page); setLists(result.details)
      if (result.failures) setErrors((previous) => ({ ...previous, 采购清单: `${result.failures} 份清单明细读取失败，当前只显示已载入内容` }))
    })
  }
  function loadOrders(page = orders.page, pageSize = orders.page_size) { return section('采购单', () => repository.listPurchaseOrders(projectCode, { page, page_size: pageSize }), (result) => setOrders(result.data)) }
  function loadOptions() {
    return repository.getProcurementOptions
      ? section('采购选料', () => repository.getProcurementOptions!(projectCode), result => setOptions(result.data))
      : Promise.resolve()
  }
  function loadQuotes(page = quotes.page, pageSize = quotes.page_size) { return section('报价历史', async () => repository.listQuoteExports ? (await repository.listQuoteExports(projectCode, { page, page_size: pageSize })).data : emptyPage<QuoteExportDto>(), setQuotes) }
  async function refresh() {
    const result = await Promise.allSettled([
      loadLists(), loadOrders(), loadQuotes(), loadOptions(),
      section('采购概览', () => repository.getProcurementOverview(projectCode), (value) => setOverview(value.data)),
      section('往来单位', () => repository.listSupplierCompanies(), (value) => setCompanies(value.data)),
      section('附件资料', () => repository.listDocumentVersionOptions?.(projectCode) ?? Promise.resolve([]), setDocuments),
      suppliedCustomer ? Promise.resolve(setCustomer(suppliedCustomer)) : section('项目客户', () => createHttpProjectRepository().getBaseDashboard(projectCode), (value) => setCustomer(value.data.company)),
    ])
    const failed = result.filter((item) => item.status === 'rejected')
    if (failed.length) throw new Error(`${failed.length} 个数据区块读取失败，详情见各区块提示`)
  }
  useEffect(() => {
    state.current.mounted = true; state.current.generation++; state.current.sequence = {}
    setOptions(null)
    setLists([]); setListPage(emptyPage()); setOrders(emptyPage()); setOverview(null); setCompanies([]); setDocuments([]); setQuotes(emptyPage()); setCustomer(suppliedCustomer ?? null); setErrors({}); setLoading({})
    const result = Promise.allSettled([
      loadLists(1, 20), loadOrders(1, 20), loadQuotes(1, 20), loadOptions(),
      section('采购概览', () => repository.getProcurementOverview(projectCode), (value) => setOverview(value.data)),
      section('往来单位', () => repository.listSupplierCompanies(), (value) => setCompanies(value.data)),
      section('附件资料', () => repository.listDocumentVersionOptions?.(projectCode) ?? Promise.resolve([]), setDocuments),
      suppliedCustomer ? Promise.resolve() : section('项目客户', () => createHttpProjectRepository().getBaseDashboard(projectCode), (value) => setCustomer(value.data.company)),
    ])
    void result
    return () => { state.current.mounted = false; state.current.generation++ }
  }, [repository, projectCode, suppliedCustomer?.id])
  const catalog: ProcurementOptions = repository.getProcurementOptions
    ? options ?? { lists: [], lines: [] }
    : { lists, lines: lists.flatMap(list => list.lines) }
  return { lists, catalog, listPage, orders, overview, companies, documents, quotes, customer, errors, loading, loadLists, loadOrders, loadQuotes, refresh }
}
