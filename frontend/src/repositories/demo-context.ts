import { MockProcurementRepository } from './procurement'
import { MockWorkforceRepository } from './workforce'

export interface DemoBusinessContext {
  procurement: MockProcurementRepository
  workforce: MockWorkforceRepository
}

export function createDemoBusinessContext(): DemoBusinessContext {
  return {
    procurement: new MockProcurementRepository(),
    workforce: new MockWorkforceRepository(),
  }
}

let activeContext = createDemoBusinessContext()

export function useDemoBusinessContext(): DemoBusinessContext {
  return activeContext
}

export function resetDemoBusinessContext(): DemoBusinessContext {
  activeContext = createDemoBusinessContext()
  return activeContext
}
