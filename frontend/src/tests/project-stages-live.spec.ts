import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDialog, ElMessageBox } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProjectStagesPanel from '../components/project/ProjectStagesPanel.vue'
import type { ProjectStage } from '../domain/contracts'
import type { RepositoryResult } from '../repositories/common'
import type { ProjectStageRepository } from '../repositories/project'

function stage(
  stageCode: string,
  status: ProjectStage['status'] = 'pending',
  revision = 1,
): ProjectStage {
  return {
    stage_code: stageCode,
    status,
    status_reason: null,
    planned_start_on: null,
    planned_end_on: null,
    started_at: null,
    blocked_at: null,
    completed_at: null,
    notes: null,
    revision,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mountPanel(props: {
  projectCode?: string
  stages: ProjectStage[]
  repository?: ProjectStageRepository
  readonly?: boolean
  onChanged?: (stages: ProjectStage[]) => void
}): VueWrapper {
  return mount(ProjectStagesPanel, {
    attachTo: document.body,
    props,
    global: { plugins: [ElementPlus] },
  })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

describe('项目阶段真实读取', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('默认仓储读取当前项目阶段并覆盖初始阶段', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([stage('planning', 'in_progress', 4)]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountPanel({
      projectCode: 'SY 2026/001',
      stages: [stage('planning')],
    })
    await settle()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/SY%202026%2F001/stages',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    )
    expect(wrapper.get('[data-testid="stage-row-planning"]').text()).toContain('进行中')
    expect(wrapper.text()).not.toContain('演示')
  })

  it('完整流程只在页头提供当前阶段操作，不为十八个阶段重复堆按钮', async () => {
    const stages = [
      stage('planning', 'completed'),
      stage('site_survey', 'in_progress'),
      stage('quotation', 'pending'),
    ]
    const repository: ProjectStageRepository = {
      listProjectStages: vi.fn(async () => ({ source: 'live' as const, data: stages })),
      updateStageSchedule: vi.fn(),
      transitionStage: vi.fn(),
    }
    const wrapper = mountPanel({ projectCode: 'SY-A', stages, repository })
    await settle()

    expect(wrapper.findAll('.stage-row__actions')).toHaveLength(0)
    expect(wrapper.get('[data-testid="stage-schedule-site_survey"]').text()).toContain('维护排期')
    expect(wrapper.get('[data-testid="stage-transition-site_survey"]').text()).toContain('更新当前阶段')
    expect(wrapper.find('[data-testid="stage-schedule-planning"]').exists()).toBe(false)
  })

  it('归档项目的阶段页不显示维护按钮', async () => {
    const repository: ProjectStageRepository = {
      listProjectStages: vi.fn(async () => ({ source: 'live' as const, data: [stage('planning', 'in_progress')] })),
      updateStageSchedule: vi.fn(),
      transitionStage: vi.fn(),
    }
    const wrapper = mountPanel({ projectCode: 'SY-A', stages: [], repository, readonly: true })
    await settle()

    expect(wrapper.find('[data-testid="stage-schedule-planning"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stage-transition-planning"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('项目已归档，仅供查看')
  })

  it('项目编号变化时重新读取并显示新项目阶段', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([stage('planning', 'in_progress')]))
      .mockResolvedValueOnce(jsonResponse([stage('planning', 'completed', 2)]))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountPanel({ projectCode: 'SY-A', stages: [stage('planning')] })
    await settle()

    await wrapper.setProps({ projectCode: 'SY-B' })
    await settle()

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/projects/SY-B/stages',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    )
    expect(wrapper.get('[data-testid="stage-row-planning"]').text()).toContain('已完成')
  })

  it('A 项目读取晚于 B 返回时不得覆盖 B 项目阶段', async () => {
    const projectA = deferred<Response>()
    const projectB = deferred<Response>()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      return String(input).includes('SY-A') ? projectA.promise : projectB.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountPanel({ projectCode: 'SY-A', stages: [stage('planning')] })

    await wrapper.setProps({ projectCode: 'SY-B' })
    projectB.resolve(jsonResponse([stage('planning', 'completed', 3)]))
    await settle()
    expect(wrapper.get('[data-testid="stage-row-planning"]').text()).toContain('已完成')

    projectA.resolve(jsonResponse([stage('planning', 'blocked', 2)]))
    await settle()

    expect(wrapper.get('[data-testid="stage-row-planning"]').text()).toContain('已完成')
    expect(wrapper.get('[data-testid="stage-row-planning"]').text()).not.toContain('阻塞')
  })

  it('读取期间明确显示加载状态', async () => {
    let resolveResponse!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(response))

    const wrapper = mountPanel({ projectCode: 'SY-A', stages: [stage('planning')] })

    expect(wrapper.get('[data-testid="project-stages-loading"]').text()).toContain('正在读取项目阶段')

    resolveResponse(jsonResponse([stage('planning')]))
    await settle()
  })

  it('读取失败时明确进入只读状态并保留初始阶段供查看', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ detail: 'Project operation failed' }, 500),
    ))

    const wrapper = mountPanel({
      projectCode: 'SY-ERROR',
      stages: [stage('planning', 'blocked')],
    })
    await settle()

    const error = wrapper.get('[data-testid="project-stages-load-error"]')
    expect(error.text()).toContain('项目阶段读取失败')
    expect(error.text()).toContain('只读')
    expect(wrapper.get('[data-testid="stage-row-planning"]').text()).toContain('阻塞')
    expect(wrapper.get('[data-testid="stage-schedule-planning"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="stage-transition-planning"]').attributes('disabled')).toBeDefined()
  })

  it('切换项目后忽略旧项目晚到的排期响应并关闭旧弹窗', async () => {
    const oldWrite = deferred<RepositoryResult<ProjectStage>>()
    const repository: ProjectStageRepository = {
      listProjectStages: vi.fn(async (projectCode) => ({
        source: 'live' as const,
        data: [stage('planning', projectCode === 'SY-A' ? 'in_progress' : 'completed', 1)],
      })),
      updateStageSchedule: vi.fn(async (projectCode) => {
        if (projectCode === 'SY-A') return oldWrite.promise
        return { source: 'live' as const, data: stage('planning', 'completed', 2) }
      }),
      transitionStage: vi.fn(),
    }
    const wrapper = mountPanel({
      projectCode: 'SY-A',
      stages: [stage('planning')],
      repository,
    })
    await settle()

    await wrapper.get('[data-testid="stage-schedule-planning"]').trigger('click')
    await wrapper.get('[data-testid="stage-schedule-notes"]').setValue('A 项目排期')
    await wrapper.get('[data-testid="stage-schedule-save"]').trigger('click')
    expect(repository.updateStageSchedule).toHaveBeenCalledWith(
      'SY-A',
      'planning',
      expect.objectContaining({ notes: 'A 项目排期' }),
    )

    await wrapper.setProps({ projectCode: 'SY-B' })
    await settle()
    expect(wrapper.get('[aria-label="编辑阶段排期"]').isVisible()).toBe(false)

    oldWrite.resolve({
      source: 'live',
      data: { ...stage('planning', 'in_progress', 2), notes: 'A 项目排期' },
    })
    await settle()

    const current = wrapper.get('[data-testid="stage-row-planning"]')
    expect(current.text()).toContain('已完成')
    expect(current.text()).not.toContain('A 项目排期')
    expect(wrapper.emitted('changed')).toBeUndefined()
  })

  it('组件卸载后忽略晚到的排期响应且不再发出变更事件', async () => {
    const oldWrite = deferred<RepositoryResult<ProjectStage>>()
    const changed = vi.fn()
    let responseReadCount = 0
    const lateStage = new Proxy(stage('planning', 'completed', 2), {
      get(target, property, receiver) {
        if (property === 'stage_code') responseReadCount += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const repository: ProjectStageRepository = {
      listProjectStages: vi.fn(async () => ({
        source: 'live' as const,
        data: [stage('planning', 'in_progress', 1)],
      })),
      updateStageSchedule: vi.fn(async () => oldWrite.promise),
      transitionStage: vi.fn(),
    }
    const wrapper = mountPanel({
      projectCode: 'SY-A',
      stages: [stage('planning')],
      repository,
      onChanged: changed,
    })
    await settle()

    await wrapper.get('[data-testid="stage-schedule-planning"]').trigger('click')
    await wrapper.get('[data-testid="stage-schedule-save"]').trigger('click')
    expect(repository.updateStageSchedule).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="stage-schedule-cancel"]').attributes('disabled')).toBeDefined()

    wrapper.unmount()
    oldWrite.resolve({ source: 'live', data: lateStage })
    await settle()

    expect(responseReadCount).toBe(0)
    expect(changed).not.toHaveBeenCalled()
    expect(wrapper.emitted('changed')).toBeUndefined()
  })

  it('真实阶段为空时显示明确空态而不是空白时间线', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([])))

    const wrapper = mountPanel({ projectCode: 'SY-EMPTY', stages: [stage('planning')] })
    await settle()

    expect(wrapper.get('[data-testid="project-stages-empty"]').text()).toContain('当前项目没有阶段记录')
    expect(wrapper.find('.stage-timeline').exists()).toBe(false)
  })

  it('注入阶段仓储时由注入对象承担读取和写入', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const listProjectStages = vi.fn(async (): Promise<RepositoryResult<ProjectStage[]>> => ({
      source: 'demo',
      data: [stage('planning', 'completed')],
    }))
    const repository = {
      listProjectStages,
      updateStageSchedule: vi.fn(),
      transitionStage: vi.fn(),
    }

    const wrapper = mountPanel({
      projectCode: 'SY-INJECTED',
      stages: [stage('planning')],
      repository,
    })
    await settle()

    expect(listProjectStages).toHaveBeenCalledWith('SY-INJECTED')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="stage-row-planning"]').text()).toContain('已完成')
  })

  it('阻塞阶段显示解决阻塞与跳过两种合法动作，并强制填写处理说明', async () => {
    const blocked = {
      ...stage('planning', 'blocked', 3),
      status_reason: '等待客户提供接口资料',
      started_at: '2026-09-01T00:00:00Z',
      blocked_at: '2026-09-02T00:00:00Z',
    }
    const transitionStage = vi.fn(async () => ({
      source: 'live' as const,
      data: { ...blocked, status: 'in_progress' as const, status_reason: '资料已收到', revision: 4 },
    }))
    const repository: ProjectStageRepository = {
      listProjectStages: vi.fn(async () => ({ source: 'live' as const, data: [blocked] })),
      updateStageSchedule: vi.fn(),
      transitionStage,
    }
    const wrapper = mountPanel({ projectCode: 'SY-A', stages: [blocked], repository })
    await settle()

    expect(wrapper.get('[data-testid="stage-transition-planning"]').text()).toContain('处理阻塞')
    await wrapper.get('[data-testid="stage-transition-planning"]').trigger('click')
    const dialog = wrapper.get('[aria-label="处理阶段阻塞"]')
    expect(dialog.text()).toContain('解决阻塞')
    expect(dialog.text()).toContain('跳过本阶段')
    expect(dialog.text()).toContain('不会删除原阻塞记录')
    expect(dialog.get('[data-testid="stage-transition-save"]').attributes('disabled')).toBeDefined()

    await dialog.get('[data-testid="stage-transition-reason"]').setValue('资料已收到')
    expect(dialog.get('[data-testid="stage-transition-save"]').attributes('disabled')).toBeUndefined()
    await dialog.get('[data-testid="stage-transition-save"]').trigger('click')
    await settle()

    expect(transitionStage).toHaveBeenCalledWith('SY-A', 'planning', expect.objectContaining({
      to_status: 'in_progress',
      reason: '资料已收到',
      expected_revision: 3,
    }))
  })

  it('阶段排期和状态弹窗干净直接关闭，改动后才确认放弃', async () => {
    const stages = [stage('planning', 'in_progress', 2)]
    const repository: ProjectStageRepository = {
      listProjectStages: vi.fn(async () => ({ source: 'live' as const, data: stages })),
      updateStageSchedule: vi.fn(),
      transitionStage: vi.fn(),
    }
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountPanel({ projectCode: 'SY-A', stages, repository })
    await settle()

    await wrapper.get('[data-testid="stage-schedule-planning"]').trigger('click')
    await wrapper.get('[data-testid="stage-schedule-cancel"]').trigger('click')
    await settle()
    expect(confirm).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="编辑阶段排期"]').isVisible()).toBe(false)

    await wrapper.get('[data-testid="stage-schedule-planning"]').trigger('click')
    await wrapper.get('[data-testid="stage-schedule-notes"]').setValue('项目排期已调整')
    await wrapper.get('[data-testid="stage-schedule-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[aria-label="编辑阶段排期"]').isVisible()).toBe(false)

    await wrapper.get('[data-testid="stage-transition-planning"]').trigger('click')
    await wrapper.get('[data-testid="stage-transition-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[aria-label="变更阶段状态"]').isVisible()).toBe(false)

    await wrapper.get('[data-testid="stage-transition-planning"]').trigger('click')
    await wrapper.get('[data-testid="stage-transition-reason"]').setValue('状态调整原因')
    const transitionDialog = wrapper.findAllComponents(ElDialog)
      .find((candidate) => candidate.props('title') === '变更阶段状态')
    if (!transitionDialog) throw new Error('未找到阶段状态弹窗')
    const beforeClose = transitionDialog.props('beforeClose')
    if (typeof beforeClose !== 'function') throw new Error('阶段状态弹窗缺少 beforeClose')
    const done = vi.fn()
    beforeClose(done)
    await settle()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('已完成和已跳过的历史阶段提供独立重开入口并保留纠错原因', async () => {
    const completed = { ...stage('planning', 'completed', 4), completed_at: '2026-09-01T00:00:00Z' }
    const skipped = {
      ...stage('site_survey', 'skipped', 2),
      status_reason: '沿用客户图纸',
      completed_at: '2026-09-01T00:00:00Z',
    }
    const current = { ...stage('quotation', 'in_progress', 2), started_at: '2026-09-02T00:00:00Z' }
    const transitionStage = vi.fn(async () => ({
      source: 'live' as const,
      data: { ...completed, status: 'in_progress' as const, status_reason: '报价依据遗漏', revision: 5 },
    }))
    const repository: ProjectStageRepository = {
      listProjectStages: vi.fn(async () => ({ source: 'live' as const, data: [completed, skipped, current] })),
      updateStageSchedule: vi.fn(),
      transitionStage,
    }
    const wrapper = mountPanel({ projectCode: 'SY-A', stages: [], repository })
    await settle()

    expect(wrapper.get('[data-testid="stage-reopen-planning"]').text()).toContain('重新打开')
    expect(wrapper.get('[data-testid="stage-reopen-site_survey"]').text()).toContain('重新打开')
    await wrapper.get('[data-testid="stage-reopen-planning"]').trigger('click')
    const dialog = wrapper.get('[aria-label="重新打开阶段"]')
    expect(dialog.text()).toContain('原完成记录会保留')
    expect(dialog.get('[data-testid="stage-transition-save"]').attributes('disabled')).toBeDefined()
    await dialog.get('[data-testid="stage-transition-reason"]').setValue('报价依据遗漏')
    await dialog.get('[data-testid="stage-transition-save"]').trigger('click')
    await settle()

    expect(transitionStage).toHaveBeenCalledWith('SY-A', 'planning', expect.objectContaining({
      to_status: 'in_progress',
      reason: '报价依据遗漏',
      expected_revision: 4,
    }))
  })

  it('阶段写入结果未知时锁定原请求并以同一幂等键原样重试', async () => {
    const requests: Array<[string, RequestInit | undefined]> = []
    let transitionAttempt = 0
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (init?.method !== 'POST') return jsonResponse([stage('planning')])
      transitionAttempt += 1
      if (transitionAttempt === 1) return jsonResponse({ detail: '暂时不可用' }, 503)
      return jsonResponse({ ...stage('planning', 'in_progress', 2), started_at: '2026-09-03T00:00:00Z' })
    }))
    const wrapper = mountPanel({ projectCode: 'SY-A', stages: [stage('planning')] })
    await settle()

    await wrapper.get('[data-testid="stage-transition-planning"]').trigger('click')
    const dialog = wrapper.get('[aria-label="变更阶段状态"]')
    await dialog.get('[data-testid="stage-transition-save"]').trigger('click')
    await settle()

    expect(dialog.text()).toContain('结果未知')
    expect(dialog.get('[data-testid="stage-transition-status"] .el-select__wrapper').classes()).toContain('is-disabled')
    expect(dialog.get('[data-testid="stage-transition-cancel"]').attributes('disabled')).toBeDefined()
    expect(dialog.get('[data-testid="stage-transition-original-retry"]').attributes('disabled')).toBeUndefined()
    await dialog.get('[data-testid="stage-transition-original-retry"]').trigger('click')
    await vi.waitFor(() => {
      expect(requests.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
    })

    const posts = requests.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0]?.[1]?.body).toBe(posts[1]?.[1]?.body)
    expect((posts[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
      .toBe((posts[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
  })

  it('阶段写入收到 2xx 非法 JSON 时锁定原请求并以同一幂等键重试', async () => {
    const requests: Array<[string, RequestInit | undefined]> = []
    let transitionAttempt = 0
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (init?.method !== 'POST') return jsonResponse([stage('planning')])
      transitionAttempt += 1
      if (transitionAttempt === 1) {
        return new Response('{malformed', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return jsonResponse({ ...stage('planning', 'in_progress', 2), started_at: '2026-09-03T00:00:00Z' })
    }))
    const wrapper = mountPanel({ projectCode: 'SY-A', stages: [stage('planning')] })
    await settle()

    await wrapper.get('[data-testid="stage-transition-planning"]').trigger('click')
    const dialog = wrapper.get('[aria-label="变更阶段状态"]')
    await dialog.get('[data-testid="stage-transition-save"]').trigger('click')
    await settle()

    expect(dialog.text()).toContain('结果未知')
    await dialog.get('[data-testid="stage-transition-original-retry"]').trigger('click')
    await vi.waitFor(() => {
      expect(requests.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
    })

    const posts = requests.filter(([, init]) => init?.method === 'POST')
    expect(posts[0]?.[1]?.body).toBe(posts[1]?.[1]?.body)
    expect((posts[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
      .toBe((posts[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
  })

  it('切换阶段仓储后忽略旧仓储迟到的状态响应', async () => {
    const oldWrite = deferred<RepositoryResult<ProjectStage>>()
    const oldRepository: ProjectStageRepository = {
      listProjectStages: vi.fn(async () => ({ source: 'live' as const, data: [stage('planning', 'in_progress', 2)] })),
      updateStageSchedule: vi.fn(),
      transitionStage: vi.fn(async () => oldWrite.promise),
    }
    const nextRepository: ProjectStageRepository = {
      listProjectStages: vi.fn(async () => ({ source: 'live' as const, data: [stage('planning', 'completed', 7)] })),
      updateStageSchedule: vi.fn(),
      transitionStage: vi.fn(),
    }
    const wrapper = mountPanel({ projectCode: 'SY-A', stages: [], repository: oldRepository })
    await settle()

    await wrapper.get('[data-testid="stage-transition-planning"]').trigger('click')
    await wrapper.get('[data-testid="stage-transition-status"] .el-select__wrapper').trigger('click')
    await settle()
    Array.from(document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item'))
      .find((item) => item.textContent?.includes('已完成'))?.click()
    await wrapper.get('[data-testid="stage-transition-save"]').trigger('click')
    await wrapper.setProps({ repository: nextRepository })
    await settle()

    oldWrite.resolve({ source: 'live', data: stage('planning', 'completed', 3) })
    await settle()
    expect(wrapper.get('[data-testid="stage-row-planning"]').text()).toContain('已完成')
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(nextRepository.transitionStage).not.toHaveBeenCalled()
  })
})
