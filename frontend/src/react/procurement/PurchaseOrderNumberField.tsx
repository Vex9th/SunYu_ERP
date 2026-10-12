import { useEffect, useId, useState } from 'react'
import { Alert, Button, Form, Input, Radio, Space, Spin, type FormInstance } from 'antd'
import type { ProcurementHttpRepository } from '../../repositories/procurement.live'
import { errorText, TextField } from './ui'
import styles from './ProcurementWorkspace.module.css'

type Preview = { key: string; number: string; error: string; loading: boolean }

export default function PurchaseOrderNumberField({ form, projectCode, repository, disabled }: {
  form: FormInstance
  projectCode: string
  repository: ProcurementHttpRepository
  disabled: boolean
}) {
  const mode = Form.useWatch('number_mode', form) ?? 'auto'
  const supplier = Number(Form.useWatch('supplier_company_id', form))
  const date = String(Form.useWatch('ordered_on', form) ?? '')
  const [attempt, setAttempt] = useState(0)
  const [preview, setPreview] = useState<Preview | null>(null)
  const inputId = useId()
  const ready = Number.isSafeInteger(supplier) && supplier > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)
  const key = `${projectCode}:${supplier}:${date}`

  useEffect(() => {
    if (mode !== 'auto' || !ready) return
    let current = true
    const controller = new AbortController()
    setPreview({ key, number: '', error: '', loading: true })
    void repository.previewPurchaseOrderNumber(projectCode, supplier, date, controller.signal)
      .then((result) => {
        if (current) setPreview({ key, number: result.order_no, error: '', loading: false })
      })
      .catch((failure) => {
        if (current) setPreview({ key, number: '', error: errorText(failure), loading: false })
      })
    return () => { current = false; controller.abort() }
  }, [mode, ready, key, projectCode, supplier, date, repository, attempt])

  const active = ready && preview?.key === key ? preview : null
  return <div className={styles.numberingGrid}>
    <Form.Item name="number_mode" label="编号方式">
      <Radio.Group options={[{ label: '自动生成', value: 'auto' }, { label: '手动填写', value: 'manual' }]} />
    </Form.Item>
    {mode === 'manual' ? <TextField name="order_no" label="采购单号" required /> :
      <Form.Item label="采购单号" htmlFor={inputId} extra="按项目、下单日期和供应商生成；预览不占号，最终编号在保存时确认。">
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input id={inputId} readOnly value={active?.number ?? ''} placeholder={ready ? '保存时自动生成' : '请选择供应商并填写下单日期'} suffix={active?.loading ? <Spin size="small" /> : null} />
          {active?.error && <Alert type="warning" showIcon title="编号预览暂不可用" description={`${active.error}。仍可保存，由系统分配编号。`}
            action={<Button size="small" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>重试预览</Button>} />}
        </Space>
      </Form.Item>}
  </div>
}
