import { Button, Form, Input, type FormInstance, type InputProps } from 'antd'
import { formatMoney, yuanToCents } from '../../domain/formatters'
import { calculatePurchaseTax, taxRateToBps } from './purchaseTax'
import { positiveQuantity, textValue } from './model'
import styles from './ProcurementWorkspace.module.css'

const commonRates = ['0', '1', '3', '6', '9', '13']
function TaxRateInput({ value = '', onChange, disabled, ...inputProps }: Omit<InputProps, 'value' | 'onChange'> & { value?: string; onChange?: (value: string) => void }) {
  return <div className={styles.taxControl}>
    <Input {...inputProps} value={value} onChange={event => onChange?.(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="手动填写，例如 13" suffix="%" disabled={disabled} />
    <div className={styles.taxShortcuts} aria-label="常用税率">
      <span>快捷选择</span>{commonRates.map(rate => <Button key={rate} size="small" type={value === rate ? 'primary' : 'default'} disabled={disabled} onClick={() => onChange?.(rate)}>{rate}%</Button>)}
    </div>
  </div>
}

export default function PurchaseOrderTaxFields({ form, disabled = false }: { form: FormInstance; disabled?: boolean }) {
  const rateValue = Form.useWatch('tax_rate', form)
  const lines = Form.useWatch('lines', { form, preserve: true }) as Array<{ quantity?: unknown; cost?: unknown }> | undefined
  let totals: ReturnType<typeof calculatePurchaseTax> | undefined
  let rate: number | null = null
  let error = ''
  try {
    rate = taxRateToBps(rateValue)
    let incomplete = !lines?.length
    for (const line of lines ?? []) {
      const quantity = textValue(line.quantity)
      const cost = textValue(line.cost)
      if (quantity) positiveQuantity(quantity)
      else incomplete = true
      if (cost) yuanToCents(cost)
      else incomplete = true
    }
    if (incomplete) error = '填写采购数量和未税单价后显示金额'
    else totals = calculatePurchaseTax(lines ?? [], rate)
  } catch (failure) { error = failure instanceof Error ? failure.message : '请检查采购金额' }
  return <section className={styles.taxSection} aria-label="采购税率与金额">
    <Form.Item name="tax_rate" label="采购税率（%）" extra="按未税单价加税，适用于本单全部物料；留空不加税。" rules={[{ validator: async (_rule, value) => { taxRateToBps(value) } }]}>
      <TaxRateInput disabled={disabled} />
    </Form.Item>
    <div className={styles.orderTotals} role="region" aria-label="采购金额预览" aria-live="polite">
      <div><span>未税合计</span><strong>{totals ? formatMoney(totals.net) : '—'}</strong></div>
      <div><span>税额</span><strong>{totals ? rate === null ? '未设置' : formatMoney(totals.tax) : '—'}</strong></div>
      <div className={styles.totalPayable}><span>{rate === null ? '采购合计' : '含税合计'}</span><strong>{totals ? formatMoney(totals.gross) : '—'}</strong></div>
      {error && <p className={styles.taxPreviewHint}>{error.startsWith('税率') ? '请修正税率后查看合计' : error}</p>}
    </div>
  </section>
}
