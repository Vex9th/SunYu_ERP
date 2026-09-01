import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
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
})
