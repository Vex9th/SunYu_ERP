import { useEffect } from 'react'
import { Form, Input, type FormInstance } from 'antd'
import { centsToYuan, yuanToCents } from '../../domain/formatters'
import { purchaseUnitPrices, taxRateToBps, type PurchasePriceDraft } from './purchaseTax'
import { textValue } from './model'
import { TextField } from './ui'
import styles from './ProcurementWorkspace.module.css'

export default function PurchaseOrderPriceFields({ form, index }: { form: FormInstance; index: number }) {
  const line = Form.useWatch(['lines', index], { form, preserve: true }) as PurchasePriceDraft | undefined
  const rate = Form.useWatch('tax_rate', form)
  const grossBasis = line?.price_basis === 'gross'
  const primary = grossBasis ? line?.gross_cost : line?.cost

  function changePrice(field: 'cost' | 'gross_cost', value: string) {
    const basis = field === 'gross_cost' ? 'gross' : 'net'
    let counterpart = ''
    try {
      if (textValue(value)) {
        const prices = purchaseUnitPrices({ price_basis: basis, cost: value, gross_cost: value }, taxRateToBps(form.getFieldValue('tax_rate')))
        counterpart = centsToYuan(basis === 'gross' ? prices.net : prices.gross)
      }
    } catch { /* 主输入由表单校验。 */ }
    // 同步写入，紧接着按保存也能拿到完整价格，不依赖 effect 的执行时机。
    form.setFields([
      { name: ['lines', index, 'price_basis'], value: basis },
      { name: ['lines', index, field === 'cost' ? 'gross_cost' : 'cost'], value: counterpart },
    ])
  }

  useEffect(() => {
    // 初次回填和 Form.List 移动行时，watch 尚可能是上一帧，始终读取当前表单。
    const current = form.getFieldValue(['lines', index]) as PurchasePriceDraft | undefined
    if (!current) return
    const isGross = current.price_basis === 'gross'
    const counterpart = isGross ? 'cost' : 'gross_cost'
    let value = ''
    try {
      if (textValue(isGross ? current.gross_cost : current.cost)) {
        const prices = purchaseUnitPrices(current, taxRateToBps(form.getFieldValue('tax_rate')))
        value = centsToYuan(isGross ? prices.net : prices.gross)
      }
    } catch { /* 输入尚未完成时清空换算值，校验由表单负责。 */ }
    if (form.getFieldValue(['lines', index, counterpart]) !== value) form.setFieldValue(['lines', index, counterpart], value)
  }, [form, index, grossBasis, primary, rate])

  function formatPrice(field: 'cost' | 'gross_cost') {
    const path = ['lines', index, field]
    try { form.setFieldValue(path, centsToYuan(yuanToCents(textValue(form.getFieldValue(path))))) }
    catch { /* 保留无效输入，展示原始校验错误。 */ }
  }

  return <div className={styles.orderPricing}>
    <Form.Item name={[index, 'price_basis']} hidden><Input /></Form.Item>
    <TextField name={[index, 'quantity']} label="采购数量" required />
    {(['cost', 'gross_cost'] as const).map(field => <Form.Item key={field} name={[index, field]}
      label={field === 'cost' ? '未税成本单价（元）' : '含税成本单价（元）'}
      required rules={[{ validator: async (_rule, value) => {
        const active = form.getFieldValue(['lines', index, 'price_basis']) === 'gross' ? 'gross_cost' : 'cost'
        if (active === field) {
          if (!textValue(value)) throw new Error('请填写单价')
          yuanToCents(textValue(value))
        }
      } }]}>
      <Input inputMode="decimal" autoComplete="off" placeholder="0.00"
        onChange={event => changePrice(field, event.target.value)}
        onBlur={() => formatPrice(field)} />
    </Form.Item>)}
    <p className={styles.priceHint}>两种单价均可填写，按税率自动换算；当前按<strong>{grossBasis ? '含税' : '未税'}单价</strong>计价。</p>
  </div>
}
