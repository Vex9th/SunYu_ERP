import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Button, Form, Input } from 'antd'
import PurchaseOrderTaxFields from '../procurement/PurchaseOrderTaxFields'
import { calculatePurchaseTax, taxRateToBps } from '../procurement/purchaseTax'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) })
})
afterEach(cleanup)

describe('采购税额整数计算', () => {
  it('含税报价按原报价乘数量，反算未税金额不产生再次加税的尾差', () => {
    expect(calculatePurchaseTax([{ quantity: '39', cost: '663.72', gross_cost: '750.00', price_basis: 'gross' }], 1300)).toEqual({ net: 2588496, tax: 336504, gross: 2925000 })
    expect(calculatePurchaseTax([{ quantity: '3', cost: '0.04', gross_cost: '0.05', price_basis: 'gross' }], 1300)).toEqual({ net: 13, tax: 2, gross: 15 })
  })

  it('单价未税，100 元加 13% 后应付 113 元', () => {
    expect(calculatePurchaseTax([{ quantity: '1', cost: '100' }], 1300)).toEqual({ net: 10000, tax: 1300, gross: 11300 })
  })
  it('逐行先四舍五入未税金额再计算税额，不先对含税单价舍入', () => {
    expect(calculatePurchaseTax([{ quantity: '0.5', cost: '0.01' }, { quantity: '0.5', cost: '0.01' }], 10000)).toEqual({ net: 2, tax: 2, gross: 4 })
    expect(calculatePurchaseTax([{ quantity: '3', cost: '0.05' }], 1300)).toEqual({ net: 15, tax: 2, gross: 17 })
  })
  it('未设置保持旧金额，零税率保留为明确的零', () => {
    expect(taxRateToBps('')).toBeNull()
    expect(taxRateToBps(undefined)).toBeNull()
    expect(taxRateToBps('0')).toBe(0)
    expect(taxRateToBps('1.25')).toBe(125)
    expect(taxRateToBps('100.00')).toBe(10000)
    expect(calculatePurchaseTax([{ quantity: '2', cost: '100' }], null)).toEqual({ net: 20000, tax: 0, gross: 20000 })
  })
  it.each(['-1', '100.01', '1.234', 'abc', '1e1'])('拒绝非法税率 %s', value => {
    expect(() => taxRateToBps(value)).toThrow('税率必须为 0 到 100 之间的数字，最多两位小数')
  })
  it('超出安全整数范围的合计不可展示成有效金额', () => {
    expect(() => calculatePurchaseTax([{ quantity: '99999999999999', cost: '100' }], 1300)).toThrow('金额超出可保存范围')
  })
})

function Harness({ onFinish, lines = [{ quantity: '1', cost: '100' }] }: { onFinish: (values: Record<string, unknown>) => void; lines?: Array<{ quantity: string; cost: string }> }) {
  const [form] = Form.useForm()
  return <Form form={form} initialValues={{ lines }} onFinish={onFinish}>
    <Form.List name="lines">{fields => fields.map(field => <div key={field.key}><Form.Item name={[field.name, 'quantity']} label="数量"><Input /></Form.Item><Form.Item name={[field.name, 'cost']} label="未税单价"><Input /></Form.Item></div>)}</Form.List>
    <PurchaseOrderTaxFields form={form} />
    <Button htmlType="submit">保存</Button>
  </Form>
}

describe('手动采购税率', () => {
  it.each([
    { lines: [] },
    { lines: [{ quantity: '', cost: '' }] },
    { lines: [{ quantity: '', cost: '100' }] },
    { lines: [{ quantity: '1', cost: '' }] },
  ])('初始未填写完整时展示中性说明：$lines', async ({ lines }) => {
    render(<Harness onFinish={vi.fn()} lines={lines} />)
    const preview = screen.getByRole('region', { name: '采购金额预览' })
    expect(await within(preview).findByText('填写采购数量和任一单价后显示金额')).toBeTruthy()
    expect(within(preview).queryByText(/数量必须|金额必须/)).toBeNull()
  })
  it('未填完整但已有非法输入时仍提示具体错误', async () => {
    render(<Harness onFinish={vi.fn()} lines={[{ quantity: '', cost: '' }]} />)
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '-1' } })
    expect(await screen.findByText('数量必须是最多三位小数的非负数')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('未税单价'), { target: { value: 'abc' } })
    expect(await screen.findByText('金额必须是最多两位小数的非负元金额')).toBeTruthy()
  })

  it('没有默认税率，快捷按钮和手动小数即时更新合计，清空后恢复未设置', async () => {
    render(<Harness onFinish={vi.fn()} />)
    const input = screen.getByLabelText('采购税率（%）') as HTMLInputElement
    expect(input.value).toBe('')
    expect(within(screen.getByRole('region', { name: '采购金额预览' })).getByText('未设置')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '13%' }))
    await waitFor(() => expect(input.value).toBe('13'))
    const preview = screen.getByRole('region', { name: '采购金额预览' })
    expect(await within(preview).findByText('¥113.00')).toBeTruthy()
    fireEvent.change(input, { target: { value: '1.25' } })
    await within(preview).findByText('¥101.25')
    fireEvent.change(screen.getByLabelText('未税单价'), { target: { value: '200' } })
    await within(preview).findByText('¥202.50')
    fireEvent.click(screen.getByRole('button', { name: '0%' }))
    await within(preview).findByText('¥0.00')
    expect(input.value).toBe('0')
    fireEvent.change(input, { target: { value: '' } })
    await within(preview).findByText('未设置')
  })
  it('非法税率阻止提交，不显示误导金额', async () => {
    const save = vi.fn()
    render(<Harness onFinish={save} />)
    fireEvent.change(screen.getByLabelText('采购税率（%）'), { target: { value: '101' } })
    fireEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))
    expect(await screen.findByText('税率必须为 0 到 100 之间的数字，最多两位小数')).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
    expect(within(screen.getByRole('region', { name: '采购金额预览' })).queryByText('¥100.00')).toBeNull()
  })
})
