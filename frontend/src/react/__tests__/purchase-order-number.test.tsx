import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Form, Input } from 'antd'
import PurchaseOrderNumberField from '../procurement/PurchaseOrderNumberField'
import type { ProcurementHttpRepository } from '../../repositories/procurement.live'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) })
})
afterEach(cleanup)

type Preview = ProcurementHttpRepository['previewPurchaseOrderNumber']
function Harness({ preview }: { preview: Preview }) {
  const [form] = Form.useForm()
  const repository = { previewPurchaseOrderNumber: preview } as ProcurementHttpRepository
  return <Form form={form} initialValues={{ number_mode: 'auto', supplier_company_id: 1, ordered_on: '2026-10-11' }}>
    <Form.Item name="supplier_company_id" label="供应商 ID"><Input /></Form.Item>
    <Form.Item name="ordered_on" label="下单日期"><Input /></Form.Item>
    <PurchaseOrderNumberField form={form} projectCode="P-1" repository={repository} disabled={false} />
  </Form>
}

describe('采购编号预览', () => {
  it('更换供应商后清除旧号码，较晚返回的旧请求不能覆盖新号码', async () => {
    let resolveOld!: (value: { order_no: string }) => void
    const preview = vi.fn<Preview>().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValue({ order_no: 'PO_NEW_002' })
    render(<Harness preview={preview} />)
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1))
    const oldSignal = preview.mock.calls[0]![3]
    fireEvent.change(screen.getByLabelText('供应商 ID'), { target: { value: '2' } })
    await screen.findByDisplayValue('PO_NEW_002')
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => resolveOld({ order_no: 'PO_OLD_001' }))
    expect(screen.queryByDisplayValue('PO_OLD_001')).toBeNull()
    expect((screen.getByLabelText('采购单号') as HTMLInputElement).value).toBe('PO_NEW_002')
    fireEvent.change(screen.getByLabelText('供应商 ID'), { target: { value: '' } })
    await waitFor(() => expect((screen.getByLabelText('采购单号') as HTMLInputElement).value).toBe(''))
  })

  it('手动编号不被进行中的自动预览覆盖', async () => {
    let finish!: (value: { order_no: string }) => void
    const preview = vi.fn<Preview>(() => new Promise(resolve => { finish = resolve }))
    render(<Harness preview={preview} />)
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('radio', { name: '手动填写' }))
    await waitFor(() => expect((screen.getByLabelText('采购单号') as HTMLInputElement).readOnly).toBe(false))
    fireEvent.change(screen.getByLabelText('采购单号'), { target: { value: 'OLD_123' } })
    await act(async () => finish({ order_no: 'PO_AUTO_001' }))
    expect((screen.getByLabelText('采购单号') as HTMLInputElement).value).toBe('OLD_123')
    expect(preview.mock.calls[0]![3]?.aborted).toBe(true)
  })

  it('预览失败可重试，重试使用当前日期而不是旧日期', async () => {
    const preview = vi.fn<Preview>().mockRejectedValueOnce(new Error('网络暂时不可用')).mockResolvedValue({ order_no: 'PO_RECOVERED_001' })
    render(<Harness preview={preview} />)
    await screen.findByText('编号预览暂不可用')
    fireEvent.click(screen.getByRole('button', { name: '重试预览' }))
    await screen.findByDisplayValue('PO_RECOVERED_001')
    expect(screen.queryByText('编号预览暂不可用')).toBeNull()
    fireEvent.change(screen.getByLabelText('下单日期'), { target: { value: '2026-10-12' } })
    await waitFor(() => expect(preview.mock.calls[preview.mock.calls.length - 1]?.slice(0, 3)).toEqual(['P-1', 1, '2026-10-12']))
  })
})
