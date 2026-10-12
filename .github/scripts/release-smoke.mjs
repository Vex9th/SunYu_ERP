/** 仅用于隔离的成品包验证目录；seed 遇到已有密码立即失败。 */
import { randomInt, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const project = '/api/projects/RELEASE-SMOKE'
export class Client {
  constructor(base) { this.base = base; this.cookie = '' }
  async request(path, method = 'GET', body, expected = 200, headers = {}) {
    const response = await fetch(this.base + path, {
      method, headers: { Cookie: this.cookie, Origin: this.base, 'Idempotency-Key': randomUUID(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error',
    })
    const cookie = response.headers.get('set-cookie')
    if (cookie) this.cookie = cookie.split(';')[0]
    const text = await response.text()
    assert.equal(response.status, expected, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  post(path, body, expected = 201) { return this.request(path, 'POST', body, expected) }
}
export async function seed(client) {
  const password = String(randomInt(1000000)).padStart(6, '0')
  await client.post('/api/auth/setup', { password }, 204)
  await client.post('/api/auth/login', { password }, 204)
  const company = await client.post('/api/companies', { name: '发布验证供应商', taxpayer_id: null, registered_address: null, registered_phone: null, bank_name: null, bank_account: null, notes: null })
  await client.post('/api/projects', { project_code: 'RELEASE-SMOKE', company_id: company.id, name: '发布验证项目', description: '仅用于成品包自检' })
  let source = await client.post(`${project}/procurement-lists`, { name: '验证清单', notes: null })
  const line = await client.post(`${project}/procurement-lists/${source.id}/lines`, { sequence_no: 1, category: '电气', name: '验证物料', brand: null, model: 'TEST', specification: null, unit: 'PCS', quantity: '1.000', unit_cost_cents: 10000, quoted_unit_price_cents: 15000 })
  source = await client.post(`${project}/procurement-lists/${source.id}/confirm`, { expected_revision: line.list_revision }, 200)
  const order = await client.post(`${project}/purchase-orders`, { order_no: '', supplier_company_id: company.id, ordered_on: '2026-10-12', expected_delivery_on: null, tax_rate_bps: 1300, notes: null, document_version_ids: [], lines: [{ procurement_line_id: source.lines[0].id, quantity: '1.000', unit_cost_cents: 10000, overage_reason: null }] })
  assert.equal(order.order_no, 'PO_FBYZXM_20261012_FBYZGYS_001')
  const path = `${project}/purchase-orders/${order.id}`
  await client.post(`${path}/confirm`, { expected_revision: order.revision }, 200)
  const allocation = { purchase_order_line_id: order.lines[0].id, amount_cents: 5000 }
  await client.post(`${path}/supplier-payments`, { paid_on: '2026-10-12', payment_method: '银行转账', reference_no: null, notes: null, amount_cents: 5000, allocations: [allocation] })
  await client.post(`${path}/supplier-invoices`, { invoice_no: 'SMOKE_INV_001', invoiced_on: '2026-10-12', document_version_ids: [], amount_cents: 11300, allocations: [{ ...allocation, amount_cents: 11300 }] })
  await client.post(`${path}/goods-receipts`, { received_on: '2026-10-12', warehouse_name: '验证仓库', notes: null, lines: [{ purchase_order_line_id: order.lines[0].id, quantity: '1.000' }] })
  return { password, company_id: company.id, order_id: order.id, order_no: order.order_no }
}
export async function verify(client, state) {
  await client.post('/api/auth/login', { password: state.password }, 204)
  const order = await client.request(`${project}/purchase-orders/${state.order_id}`)
  const expected = { order_no: state.order_no, tax_rate_bps: 1300, net_amount_cents: 10000, tax_amount_cents: 1300, ordered_amount_cents: 11300, paid_amount_cents: 5000, invoiced_amount_cents: 11300, status: 'received' }
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, order[key]])), expected)
  const ledger = await client.request(`/api/companies/${state.company_id}/ledger`)
  assert.deepEqual(ledger.supplier.summary, { project_count: 1, order_count: 1, ordered_amount_cents: 11300, paid_amount_cents: 5000, unpaid_amount_cents: 6300, invoiced_amount_cents: 11300, uninvoiced_amount_cents: 0 })
  const overview = await client.request(`${project}/procurement-overview`)
  assert.equal(overview.procurement_received_cents, 11300)
}
async function main() {
  const [phase, statePath, base] = process.argv.slice(2)
  if (!['seed', 'verify'].includes(phase) || !statePath || !base) throw new Error('Usage: node release-smoke.mjs seed|verify <test-state.json> <http://127.0.0.1:port>')
  const url = new URL(base)
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/' || url.username || url.search || url.hash) throw new Error('Smoke tests require an explicit loopback URL')
  const client = new Client(url.origin)
  let state
  if (phase === 'seed') {
    await writeFile(statePath, '', { flag: 'wx', mode: 0o600 })
    state = await seed(client)
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
  } else state = JSON.parse(await readFile(statePath, 'utf8'))
  await verify(client, state)
  console.log(`Packaged business smoke ${phase}: PASS (number, tax, payment, invoice, receipt, ledger)`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1 })
