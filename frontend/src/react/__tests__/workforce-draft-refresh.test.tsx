import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installProjectDom } from './project-fixtures'
import WorkforceWorkspace from '../workforce/WorkforceWorkspace'
import { MockWorkforceRepository } from '../../repositories/workforce'
import { reloadBlockReason } from '../pendingUnload'
import { localISODate } from '../../domain/dates'

beforeAll(installProjectDom)
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('劳务草稿的更新刷新保护', () => {
  it('零选择或清空输入的草稿可明确放弃，取消保留，其他日期仍受保护', async () => {
    const repository = new MockWorkforceRepository()
    vi.spyOn(repository, 'getWorkforcePreview').mockResolvedValue({ source: 'demo', data: {
      project_code: 'DRAFT-DISCARD', workers: [], crew_assignments: [], labor_entries: [], site_daily_reports: [], material_advances: [],
    } })
    const save = vi.spyOn(repository, 'saveLaborEntriesBatch')
    render(<ConfigProvider theme={{ token: { motion: false } }}><WorkforceWorkspace projectCode="DRAFT-DISCARD" repository={repository} /></ConfigProvider>)
    const summary = await screen.findByLabelText('统一工作内容')
    await waitFor(() => expect((summary as HTMLInputElement).disabled).toBe(false))
    fireEvent.change(summary, { target: { value: '暂时填写' } })
    fireEvent.change(summary, { target: { value: '' } })
    expect(reloadBlockReason()).toEqual(expect.stringMatching(/未保存/))
    fireEvent.click(screen.getByRole('button', { name: '放弃当前日期草稿' }))
    fireEvent.click(await screen.findByRole('button', { name: '继续填写' }))
    expect(reloadBlockReason()).toEqual(expect.stringMatching(/未保存/))
    expect(screen.getByText('有未保存的上工填写')).toBeTruthy()
    fireEvent.change(summary, { target: { value: '第一天仍要保留' } })

    const date = localISODate()
    const dateInput = screen.getByDisplayValue(date)
    fireEvent.change(dateInput, { target: { value: '2020-01-01' } })
    fireEvent.keyDown(dateInput, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect((summary as HTMLInputElement).value).toBe(''))
    fireEvent.change(summary, { target: { value: '第二天待放弃' } })
    fireEvent.click(screen.getByRole('button', { name: '放弃当前日期草稿' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认放弃' }))
    await waitFor(() => expect((summary as HTMLInputElement).value).toBe(''))
    expect(screen.queryByText('有未保存的上工填写')).toBeNull()
    expect(reloadBlockReason()).toEqual(expect.stringMatching(/未保存/))

    fireEvent.change(dateInput, { target: { value: date } })
    fireEvent.keyDown(dateInput, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect((summary as HTMLInputElement).value).toBe('第一天仍要保留'))
    fireEvent.click(screen.getByRole('button', { name: '放弃当前日期草稿' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认放弃' }))
    await waitFor(() => expect(reloadBlockReason()).toBeNull())
    expect((summary as HTMLInputElement).value).toBe('')
    expect(save).not.toHaveBeenCalled()
  })
})
