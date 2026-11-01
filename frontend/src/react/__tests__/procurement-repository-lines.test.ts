import { expect, it } from 'vitest'
import { MockProcurementRepository } from '../../repositories/procurement'

it('演示仓库逐项确认，已确认项不会锁住同清单追加和修改', async () => {
  const repository = new MockProcurementRepository()
  const project = 'LINE-DEMO'
  await repository.createProcurementList(project, { name:'独立清单', notes:null })
  let list = (await repository.getProjectWorkspace(project)).data.procurement_lists[0]!
  const input = { sequence_no:1, category:'元件', name:'A', specification:'', brand:'', model:'',quantity:'1.000',unit:'件',unit_cost_cents:100,quoted_unit_price_cents:200 }
  await repository.createProcurementLine(project,list.id,input)
  await repository.createProcurementLine(project,list.id,{...input,sequence_no:2,name:'B'})
  list = (await repository.getProjectWorkspace(project)).data.procurement_lists[0]!
  await repository.confirmProcurementLine(project,list.id,list.lines[0]!.id,list.lines[0]!.revision)
  await repository.updateProcurementLine(project,list.id,list.lines[1]!.id,list.lines[1]!.revision,{...input,sequence_no:2,name:'修改B'})
  const changed = (await repository.getProjectWorkspace(project)).data.procurement_lists[0]!
  expect(changed.lines[0]!.confirmation_status).toBe('confirmed')
  expect(changed.lines[1]!.confirmation_status).toBe('draft')
  expect(changed.lines[1]!.name).toBe('修改B')
  await repository.reopenProcurementLine(project,list.id,changed.lines[0]!.id,changed.lines[0]!.revision,'调整')
  expect((await repository.getProjectWorkspace(project)).data.procurement_lists[0]!.lines[0]!.confirmation_status).toBe('draft')
})
