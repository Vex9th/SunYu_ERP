import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProjectDashboard from '../components/ProjectDashboard.vue'

const canonicalProjectCode = 'Straße'
const requestedProjectCode = 'STRASSE'

const EmptyRoute = defineComponent({ template: '<div />' })
const PreviewStub = defineComponent({
  props: {
    projectCode: { type: String, required: true },
    documentId: { type: Number, required: true },
    versionId: { type: Number, default: null },
  },
  template: `
    <div data-testid="routed-document-preview">
      {{ projectCode }} / {{ documentId }} / {{ versionId }}
    </div>
  `,
})

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/projects/:projectCode', name: 'project', component: EmptyRoute },
      { path: '/projects/:projectCode/documents', name: 'project-documents', component: EmptyRoute },
      { path: '/projects/:projectCode/documents/:documentId', name: 'project-document', component: EmptyRoute },
    ],
  })
}

async function mountDashboard(router: Router) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/dashboard')) {
      return new Response(JSON.stringify({
        project: {
          id: 21,
          project_code: canonicalProjectCode,
          company_id: 1,
          company_name: '测试公司',
          name: '身份匹配项目',
          description: null,
          status: 'active',
          closure_type: null,
          archive_reason: null,
          archived_at: null,
          revision: 1,
          created_at: '2026-09-03T08:00:00+08:00',
          updated_at: '2026-09-03T08:00:00+08:00',
        },
        company: { id: 1, name: '测试公司' },
        contacts: [],
        documents: { document_count: 0, version_count: 0, categories: [] },
        stages: [],
        commercial: { accepted_quote: null, contracts: [] },
        costs: {},
        profit: {},
        receivables: {},
        todos: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/documents?')) {
      return new Response(JSON.stringify({ items: [], page: 1, page_size: 100, total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const wrapper = mount(ProjectDashboard, {
    attachTo: document.body,
    props: { projectCode: requestedProjectCode },
    global: {
      plugins: [ElementPlus, router],
      stubs: {
        ProjectOverviewPanel: true,
        ProjectRecordsPanel: true,
        ProjectDocumentPreview: PreviewStub,
        ProjectCommercialPanel: true,
        ProcurementWorkspace: true,
        WorkforceCenter: true,
        DeliveryWorkspace: true,
      },
    },
  })
  await vi.waitFor(() => expect(wrapper.find('[data-testid="project-workspace-tabs"]').exists()).toBe(true))
  return wrapper
}

describe('项目资料深链接身份匹配', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('以服务端 casefold 命中的规范项目编号替换路由后再挂载预览', async () => {
    const router = testRouter()
    await router.push('/projects/SEED/documents')
    await router.push(`/projects/${requestedProjectCode}/documents/12?version=31&from=todo#preview`)
    await router.isReady()

    const wrapper = await mountDashboard(router)

    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe(
        `/projects/${encodeURIComponent(canonicalProjectCode)}/documents/12?version=31&from=todo#preview`,
      )
      expect(wrapper.get('[data-testid="routed-document-preview"]').text())
        .toContain(`${canonicalProjectCode} / 12 / 31`)
    })
    router.back()
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe('/projects/SEED/documents')
    })
  })

  it.each([
    [`/projects/${requestedProjectCode}`, `/projects/${encodeURIComponent(canonicalProjectCode)}`],
    [
      `/projects/${requestedProjectCode}/documents`,
      `/projects/${encodeURIComponent(canonicalProjectCode)}/documents`,
    ],
  ])('服务端规范编号同样用于项目和资料列表路由', async (path, canonicalPath) => {
    const router = testRouter()
    await router.push(path)
    await router.isReady()

    await mountDashboard(router)

    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(canonicalPath))
  })
})
