<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import type { DocumentDetail, DocumentVersion } from '../../domain/contracts'
import { createPreviewProjectRepository } from '../../repositories/project.mock'

const props = defineProps<{
  projectCode: string
}>()

const documents = ref<DocumentDetail[]>([])
const loading = ref(true)
const demoNotice = ref('所有文档操作均为演示，不上传、归档或下载真实文件。')
const createVisible = ref(false)
const editVisible = ref(false)
const versionVisible = ref(false)
const archiveVisible = ref(false)
const selectedDocumentId = ref<number | null>(null)
const validationError = ref<string | null>(null)
const selectedCreateFile = ref<File | null>(null)
const selectedVersionFile = ref<File | null>(null)
const localVersionFiles = new Map<number, File>()
const documentCount = computed(() => documents.value.length)
const versionCount = computed(() => documents.value.reduce(
  (total, document) => total + document.versions.length,
  0,
))

const categories = [
  'planning_minutes',
  'site_survey',
  'quotation',
  'technical_agreement',
  'contract',
  'mechanical_design',
  'electrical_design',
  'procurement_list',
  'procurement_contract',
  'mechanical_signoff',
  'electrical_signoff',
  'construction',
  'commissioning',
  'acceptance',
  'invoice',
  'warranty',
  'after_sales',
  'other',
] as const

const categoryLabels: Record<(typeof categories)[number], string> = {
  planning_minutes: '项目策划纪要',
  site_survey: '现场勘查',
  quotation: '报价资料',
  technical_agreement: '技术协议',
  contract: '项目合同',
  mechanical_design: '机械设计',
  electrical_design: '电气设计',
  procurement_list: '采购清单',
  procurement_contract: '采购合同',
  mechanical_signoff: '机械会签',
  electrical_signoff: '电气会签',
  construction: '施工资料',
  commissioning: '调试资料',
  acceptance: '验收资料',
  invoice: '发票资料',
  warranty: '质保资料',
  after_sales: '售后资料',
  other: '其他',
}

function categoryLabel(category: string): string {
  return categoryLabels[category as keyof typeof categoryLabels] ?? category
}

const createForm = reactive({ category: 'other', title: '', notes: '' })
const editForm = reactive({ category: 'other', title: '', notes: '' })
const versionNotes = ref('')
const archiveReason = ref('')

onMounted(async () => {
  const result = await createPreviewProjectRepository().getDocumentLedger(props.projectCode)
  documents.value = result.data.items
  loading.value = false
})

function now(): string {
  return new Date().toISOString()
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function openCreate(): void {
  createForm.category = 'other'
  createForm.title = ''
  createForm.notes = ''
  selectedCreateFile.value = null
  validationError.value = null
  createVisible.value = true
}

function selectCreateFile(event: Event): void {
  selectedCreateFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

function openEdit(document: DocumentDetail): void {
  selectedDocumentId.value = document.id
  editForm.category = document.category
  editForm.title = document.title
  editForm.notes = document.notes ?? ''
  validationError.value = null
  editVisible.value = true
}

function saveEdit(): void {
  const document = documents.value.find((item) => item.id === selectedDocumentId.value)
  const title = editForm.title.trim()
  if (!document || !title) {
    validationError.value = '请填写文档标题'
    return
  }
  document.category = editForm.category
  document.title = title
  document.notes = nullable(editForm.notes)
  document.revision += 1
  document.updated_at = now()
  editVisible.value = false
  demoNotice.value = '演示文档信息已更新，不会修改真实文件。'
}

function saveCreate(): void {
  const title = createForm.title.trim()
  if (!title || !selectedCreateFile.value) {
    validationError.value = '请填写标题并选择文件'
    return
  }
  const createdAt = now()
  const id = Math.max(100, ...documents.value.map((document) => document.id)) + 1
  const versionId = id * 10
  documents.value.unshift({
    id,
    project_code: props.projectCode,
    category: createForm.category,
    title,
    notes: nullable(createForm.notes),
    latest_version_number: 1,
    archived_at: null,
    revision: 1,
    created_at: createdAt,
    updated_at: createdAt,
    versions: [createVersion(selectedCreateFile.value, 1, nullable(createForm.notes), versionId)],
  })
  localVersionFiles.set(versionId, selectedCreateFile.value)
  createVisible.value = false
  demoNotice.value = '演示文档已加入本地台账，不会上传真实文件。'
}

function openVersion(documentId: number): void {
  selectedDocumentId.value = documentId
  selectedVersionFile.value = null
  versionNotes.value = ''
  validationError.value = null
  versionVisible.value = true
}

function selectVersionFile(event: Event): void {
  selectedVersionFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

function saveVersion(): void {
  const document = documents.value.find((item) => item.id === selectedDocumentId.value)
  if (!document || !selectedVersionFile.value) {
    validationError.value = '请选择要追加的版本文件'
    return
  }
  const versionNumber = document.latest_version_number + 1
  const versionId = document.id * 10 + versionNumber
  document.versions.push(createVersion(
    selectedVersionFile.value,
    versionNumber,
    nullable(versionNotes.value),
    versionId,
  ))
  localVersionFiles.set(versionId, selectedVersionFile.value)
  document.latest_version_number = versionNumber
  document.revision += 1
  document.updated_at = now()
  versionVisible.value = false
  demoNotice.value = `已在演示台账中追加 V${versionNumber}，不会上传真实文件。`
}

function createVersion(file: File, versionNumber: number, notes: string | null, id: number): DocumentVersion {
  return {
    id,
    version_number: versionNumber,
    original_filename: file.name,
    content_type: file.type || 'application/octet-stream',
    size_bytes: file.size,
    sha256: `demo-${id}-${file.size}`,
    notes,
    created_at: now(),
  }
}

function showDownload(document: DocumentDetail): void {
  const version = document.versions[document.versions.length - 1]
  const file = version ? localVersionFiles.get(version.id) : null
  if (!version || !file || typeof URL.createObjectURL !== 'function') {
    demoNotice.value = `当前版本 ${version?.original_filename ?? '无文件'} 来自演示种子，真实下载等待后端文件接口。`
    return
  }
  const url = URL.createObjectURL(file)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = version.original_filename
  anchor.click()
  URL.revokeObjectURL(url)
  demoNotice.value = `已下载本次会话中的演示文件：${version.original_filename}`
}

function openArchive(documentId: number): void {
  selectedDocumentId.value = documentId
  archiveReason.value = ''
  validationError.value = null
  archiveVisible.value = true
}

function saveArchive(): void {
  const document = documents.value.find((item) => item.id === selectedDocumentId.value)
  if (!document || !archiveReason.value.trim()) {
    validationError.value = '请填写归档原因'
    return
  }
  document.archived_at = now()
  document.revision += 1
  document.updated_at = now()
  archiveVisible.value = false
  demoNotice.value = '演示文档已归档，版本历史仍然保留。'
}
</script>

<template>
  <el-space
    data-testid="project-documents-panel"
    class="project-panel-stack"
    direction="vertical"
    alignment="stretch"
    fill
    :size="16"
  >
    <el-row justify="space-between" align="middle">
      <el-text data-testid="document-demo-notice" type="info">{{ demoNotice }}</el-text>
      <el-tag type="warning" effect="plain">演示数据</el-tag>
    </el-row>

    <el-card class="data-card" shadow="never">
      <template #header>
        <el-row justify="space-between" align="middle">
          <div>
            <el-text tag="strong" size="large">项目资料台账</el-text>
            <p data-testid="document-ledger-summary" class="section-note">
              {{ documentCount }} 份资料 · {{ versionCount }} 个历史版本。资料数量不代表审批完成或项目进度。
            </p>
            <p class="section-note">归档只停止继续使用，不删除磁盘文件或版本历史。</p>
          </div>
          <el-button data-testid="document-create-open" type="primary" @click="openCreate">新建并上传首版</el-button>
        </el-row>
      </template>
      <el-skeleton v-if="loading" :rows="5" animated />
      <el-empty v-else-if="documents.length === 0" description="暂无文档" />
      <el-table v-else :data="documents" row-key="id">
        <el-table-column label="类别" min-width="150"><template #default="scope">{{ categoryLabel(scope.row.category) }}</template></el-table-column>
        <el-table-column prop="title" label="标题" min-width="190" />
        <el-table-column label="最新版本" width="100">
          <template #default="scope">V{{ scope.row.latest_version_number }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="scope">
            <el-tag :type="scope.row.archived_at ? 'info' : 'success'">{{ scope.row.archived_at ? '已归档' : '使用中' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="updated_at" label="更新时间" min-width="180" />
        <el-table-column label="操作" min-width="250" fixed="right">
          <template #default="scope">
            <el-space :data-testid="`document-row-${scope.row.id}`">
              <el-tag type="info">V{{ scope.row.latest_version_number }}</el-tag>
              <el-button :data-testid="`document-download-${scope.row.id}`" link @click="showDownload(scope.row)">下载</el-button>
              <el-button
                v-if="!scope.row.archived_at"
                :data-testid="`document-edit-open-${scope.row.id}`"
                link
                @click="openEdit(scope.row)"
              >编辑信息</el-button>
              <el-button
                v-if="!scope.row.archived_at"
                :data-testid="`document-version-open-${scope.row.id}`"
                link
                type="primary"
                @click="openVersion(scope.row.id)"
              >追加版本</el-button>
              <el-button
                v-if="!scope.row.archived_at"
                :data-testid="`document-archive-open-${scope.row.id}`"
                link
                type="danger"
                @click="openArchive(scope.row.id)"
              >归档</el-button>
              <span v-else>已归档</span>
            </el-space>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="createVisible" title="新建逻辑文档 · 演示" :teleported="false" width="min(92vw, 560px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveCreate">
        <el-form-item label="类别" required>
          <el-select v-model="createForm.category">
            <el-option v-for="category in categories" :key="category" :label="categoryLabels[category]" :value="category" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" required><el-input data-testid="document-create-title" v-model="createForm.title" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="createForm.notes" type="textarea" /></el-form-item>
        <el-form-item label="文件" required><input data-testid="document-create-file" type="file" @change="selectCreateFile" /></el-form-item>
        <el-button data-testid="document-create-save" type="primary" native-type="submit">加入演示台账</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="editVisible" title="编辑文档信息 · 演示" :teleported="false" width="min(92vw, 540px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveEdit">
        <el-form-item label="类别" required>
          <el-select v-model="editForm.category" style="width: 100%">
            <el-option v-for="category in categories" :key="category" :label="categoryLabels[category]" :value="category" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" required><el-input data-testid="document-edit-title" v-model="editForm.title" /></el-form-item>
        <el-form-item label="备注"><el-input data-testid="document-edit-notes" v-model="editForm.notes" type="textarea" /></el-form-item>
        <el-button data-testid="document-edit-save" type="primary" native-type="submit">保存演示信息</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="versionVisible" title="追加文档版本 · 演示" :teleported="false" width="min(92vw, 520px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveVersion">
        <el-form-item label="文件" required><input data-testid="document-version-file" type="file" @change="selectVersionFile" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="versionNotes" type="textarea" /></el-form-item>
        <el-button data-testid="document-version-save" type="primary" native-type="submit">追加演示版本</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="archiveVisible" title="归档逻辑文档 · 演示" :teleported="false" width="min(92vw, 500px)">
      <el-alert v-if="validationError" :title="validationError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveArchive">
        <el-form-item label="归档原因" required><el-input data-testid="document-archive-reason" v-model="archiveReason" type="textarea" /></el-form-item>
        <el-button data-testid="document-archive-save" type="danger" native-type="submit">确认演示归档</el-button>
      </el-form>
    </el-dialog>
  </el-space>
</template>
