<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import type { DocumentDetail, DocumentSummary, DocumentVersion } from '../../domain/contracts'
import { formatChineseDateTime } from '../../domain/dates'
import { managedDocumentFilename, traceableDocumentFilename } from '../../domain/document-filenames'
import type { ProjectOperatingRepository } from '../../repositories/project-operating.live'

type PreviewKind = 'text' | 'image' | 'pdf' | 'unsupported'

const props = defineProps<{
  projectCode: string
  documentId: number
  versionId?: number | null
  documents: DocumentSummary[]
  repository: ProjectOperatingRepository
}>()

const emit = defineEmits<{
  close: []
  navigate: [documentId: number, versionId: number | null]
  'resolved-version': [versionId: number]
}>()

const TEXT_PREVIEW_LIMIT = 5 * 1024 * 1024
const BINARY_PREVIEW_LIMIT = 100 * 1024 * 1024
const imageMimeByExtension: Record<string, string> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

const detail = ref<DocumentDetail | null>(null)
const dialogVisible = ref(true)
const selectedVersionId = ref<number | null>(null)
const loading = ref(true)
const previewLoading = ref(false)
const loadError = ref<string | null>(null)
const previewError = ref<string | null>(null)
const previewText = ref('')
const previewObjectUrl = ref<string | null>(null)
const previewBlob = ref<Blob | null>(null)
const previewBlobVersionId = ref<number | null>(null)
const previewTooLarge = ref(false)
const downloadBusy = ref(false)
const copyNotice = ref<string | null>(null)
const copyNoticeType = ref<'success' | 'error'>('success')
const searchText = ref('')
const activeSearchMatch = ref(0)
const imageScale = ref(1)
const imageRotation = ref(0)
let documentGeneration = 0
let previewGeneration = 0
let previewAbortController: AbortController | null = null
let manualDownloadGeneration = 0
let manualDownloadAbortController: AbortController | null = null
let mounted = true

const currentVersion = computed(() => detail.value?.versions.find(
  (version) => version.id === selectedVersionId.value,
) ?? null)
const previewKind = computed<PreviewKind>(() => (
  currentVersion.value ? classifyVersion(currentVersion.value, detail.value?.category ?? '') : 'unsupported'
))
const sortedVersions = computed(() => [...(detail.value?.versions ?? [])].sort(
  (left, right) => right.version_number - left.version_number,
))
const searchMatchCount = computed(() => {
  const needle = searchText.value.trim().toLocaleLowerCase()
  if (!needle) return 0
  const haystack = previewText.value.toLocaleLowerCase()
  let count = 0
  let position = 0
  while ((position = haystack.indexOf(needle, position)) >= 0) {
    count += 1
    position += Math.max(needle.length, 1)
  }
  return count
})
const highlightedText = computed(() => {
  const needle = searchText.value.trim()
  if (!needle) return [{ text: previewText.value, match: false, index: -1 }]
  const loweredNeedle = needle.toLocaleLowerCase()
  const loweredText = previewText.value.toLocaleLowerCase()
  const segments: Array<{ text: string; match: boolean; index: number }> = []
  let cursor = 0
  let matchIndex = 0
  while (cursor < previewText.value.length) {
    const found = loweredText.indexOf(loweredNeedle, cursor)
    if (found < 0) {
      segments.push({ text: previewText.value.slice(cursor), match: false, index: -1 })
      break
    }
    if (found > cursor) segments.push({ text: previewText.value.slice(cursor, found), match: false, index: -1 })
    segments.push({ text: previewText.value.slice(found, found + needle.length), match: true, index: matchIndex })
    matchIndex += 1
    cursor = found + needle.length
  }
  return segments
})
const imageTransform = computed(() => ({
  transform: `scale(${imageScale.value}) rotate(${imageRotation.value}deg)`,
}))

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '文件预览失败'
}

function extension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot + 1).toLocaleLowerCase() : ''
}

function classifyVersion(version: DocumentVersion, category: string): PreviewKind {
  const suffix = extension(managedDocumentFilename(version))
  if (['txt', 'md', 'log', 'csv'].includes(suffix)) return 'text'
  if (suffix in imageMimeByExtension) return 'image'
  if (suffix === 'pdf') return 'pdf'
  if (category === 'planning_minutes' && !suffix) return 'text'
  return 'unsupported'
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function cleanupPreviewUrl(): void {
  if (previewObjectUrl.value && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(previewObjectUrl.value)
  }
  previewObjectUrl.value = null
  previewBlob.value = null
  previewBlobVersionId.value = null
}

function cancelPreviewDownload(): void {
  previewAbortController?.abort()
  previewAbortController = null
}

function cancelManualDownload(): void {
  manualDownloadAbortController?.abort()
  manualDownloadAbortController = null
}

function resetPreviewState(): void {
  previewGeneration += 1
  manualDownloadGeneration += 1
  cancelPreviewDownload()
  cancelManualDownload()
  cleanupPreviewUrl()
  previewLoading.value = false
  downloadBusy.value = false
  previewError.value = null
  previewText.value = ''
  previewTooLarge.value = false
  copyNotice.value = null
  copyNoticeType.value = 'success'
  searchText.value = ''
  activeSearchMatch.value = 0
  imageScale.value = 1
  imageRotation.value = 0
}

function focusSearchMatch(index: number): void {
  if (searchMatchCount.value === 0) return
  activeSearchMatch.value = (index + searchMatchCount.value) % searchMatchCount.value
  void nextTick(() => {
    document.querySelector<HTMLElement>(`[data-search-match="${activeSearchMatch.value}"]`)?.scrollIntoView?.({ block: 'center' })
  })
}

watch(searchText, () => {
  activeSearchMatch.value = 0
  if (searchMatchCount.value > 0) focusSearchMatch(0)
})

function preferredVersion(document: DocumentDetail): DocumentVersion | null {
  const requested = props.versionId === null || props.versionId === undefined
    ? null
    : document.versions.find((version) => version.id === props.versionId)
  return requested ?? [...document.versions].sort(
    (left, right) => right.version_number - left.version_number,
  )[0] ?? null
}

async function loadDocument(): Promise<void> {
  const generation = ++documentGeneration
  resetPreviewState()
  detail.value = null
  selectedVersionId.value = null
  loadError.value = null
  loading.value = true
  try {
    const document = await props.repository.getDocument(props.projectCode, props.documentId)
    if (generation !== documentGeneration) return
    detail.value = document
    selectedVersionId.value = preferredVersion(document)?.id ?? null
    if (
      selectedVersionId.value !== null
      && document.versions.every((version) => version.id !== props.versionId)
    ) {
      emit('resolved-version', selectedVersionId.value)
    }
    await loadPreview()
  } catch (error) {
    if (generation === documentGeneration) loadError.value = errorMessage(error)
  } finally {
    if (generation === documentGeneration) loading.value = false
  }
}

async function readBlob(blob: Blob, mode: 'text' | 'buffer'): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (mode === 'text') resolve(String(reader.result ?? ''))
      else if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('文件内容无法读取'))
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('文件内容无法读取')))
    if (mode === 'text') reader.readAsText(blob, 'utf-8')
    else reader.readAsArrayBuffer(blob)
  })
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

async function validatedMime(blob: Blob, version: DocumentVersion): Promise<string | null> {
  const suffix = extension(managedDocumentFilename(version))
  const prefix = new Uint8Array(await readBlob(blob.slice(0, 16), 'buffer') as ArrayBuffer)
  if (suffix === 'pdf') {
    return startsWith(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d]) ? 'application/pdf' : null
  }
  if (suffix === 'png') return startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? 'image/png' : null
  if (suffix === 'jpg' || suffix === 'jpeg') return startsWith(prefix, [0xff, 0xd8, 0xff]) ? 'image/jpeg' : null
  if (suffix === 'gif') return startsWith(prefix, [0x47, 0x49, 0x46, 0x38]) ? 'image/gif' : null
  if (suffix === 'bmp') return startsWith(prefix, [0x42, 0x4d]) ? 'image/bmp' : null
  if (suffix === 'webp') {
    const riff = startsWith(prefix, [0x52, 0x49, 0x46, 0x46])
    const webp = startsWith(prefix.slice(8), [0x57, 0x45, 0x42, 0x50])
    return riff && webp ? 'image/webp' : null
  }
  return null
}

async function loadPreview(): Promise<void> {
  const version = currentVersion.value
  const document = detail.value
  const generation = ++previewGeneration
  manualDownloadGeneration += 1
  cancelPreviewDownload()
  cancelManualDownload()
  cleanupPreviewUrl()
  previewLoading.value = false
  downloadBusy.value = false
  previewError.value = null
  previewText.value = ''
  previewTooLarge.value = false
  copyNotice.value = null
  copyNoticeType.value = 'success'
  searchText.value = ''
  imageScale.value = 1
  imageRotation.value = 0
  if (!version || !document || previewKind.value === 'unsupported') return

  const limit = previewKind.value === 'text' ? TEXT_PREVIEW_LIMIT : BINARY_PREVIEW_LIMIT
  if (version.size_bytes > limit) {
    previewTooLarge.value = true
    return
  }

  previewLoading.value = true
  const controller = new AbortController()
  previewAbortController = controller
  try {
    const blob = await props.repository.downloadDocumentVersion(
      props.projectCode,
      document.id,
      version.id,
      controller.signal,
    )
    if (generation !== previewGeneration) return
    previewBlob.value = blob
    previewBlobVersionId.value = version.id
    if (previewKind.value === 'text') {
      const text = await readBlob(blob, 'text') as string
      if (generation === previewGeneration) previewText.value = text
      return
    }
    const safeMime = await validatedMime(blob, version)
    if (generation !== previewGeneration) return
    if (!safeMime) {
      previewBlob.value = null
      previewBlobVersionId.value = null
      previewError.value = '文件内容与扩展名不匹配，已阻止网页预览。'
      return
    }
    previewObjectUrl.value = URL.createObjectURL(blob.slice(0, blob.size, safeMime))
  } catch (error) {
    if (generation === previewGeneration) previewError.value = errorMessage(error)
  } finally {
    if (previewAbortController === controller) previewAbortController = null
    if (generation === previewGeneration) previewLoading.value = false
  }
}

function selectDocument(index: string): void {
  const documentId = Number(index)
  if (!Number.isInteger(documentId) || documentId === props.documentId) return
  emit('navigate', documentId, null)
}

function selectVersion(value: string | number): void {
  const versionId = Number(value)
  if (!Number.isInteger(versionId)) return
  if (versionId === selectedVersionId.value) return
  selectedVersionId.value = versionId
  emit('navigate', props.documentId, versionId)
  void loadPreview()
}

async function downloadCurrent(): Promise<void> {
  const version = currentVersion.value
  const document = detail.value
  if (!version || !document || downloadBusy.value) return
  const generation = ++manualDownloadGeneration
  const projectCode = props.projectCode
  const documentId = document.id
  const versionId = version.id
  const repository = props.repository
  const controller = new AbortController()
  cancelManualDownload()
  manualDownloadAbortController = controller
  downloadBusy.value = true
  const isCurrent = () => mounted
    && generation === manualDownloadGeneration
    && projectCode === props.projectCode
    && documentId === props.documentId
    && versionId === selectedVersionId.value
    && repository === props.repository
  try {
    const blob = previewBlobVersionId.value === version.id && previewBlob.value
      ? previewBlob.value
      : await repository.downloadDocumentVersion(
        projectCode,
        documentId,
        versionId,
        controller.signal,
      )
    if (!isCurrent()) return
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = managedDocumentFilename(version)
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    if (isCurrent() && !(error instanceof DOMException && error.name === 'AbortError')) {
      previewError.value = errorMessage(error)
    }
  } finally {
    if (manualDownloadAbortController === controller) {
      manualDownloadAbortController = null
    }
    if (isCurrent()) downloadBusy.value = false
  }
}

async function copyText(): Promise<void> {
  if (!previewText.value) return
  try {
    await navigator.clipboard.writeText(previewText.value)
    copyNotice.value = '纪要已复制'
    copyNoticeType.value = 'success'
  } catch {
    copyNotice.value = '复制失败，请手动选中文字'
    copyNoticeType.value = 'error'
  }
}

function printText(): void {
  window.print()
}

function zoomImage(delta: number): void {
  imageScale.value = Math.min(3, Math.max(0.25, imageScale.value + delta))
}

function rotateImage(): void {
  imageRotation.value = (imageRotation.value + 90) % 360
}

function requestClose(): void {
  emit('close')
}

watch(
  [() => props.projectCode, () => props.documentId, () => props.repository],
  () => { void loadDocument() },
  { immediate: true },
)

watch(() => props.versionId, (versionId) => {
  if (!detail.value) return
  const next = versionId === null || versionId === undefined
    ? preferredVersion(detail.value)
    : detail.value.versions.find((version) => version.id === versionId)
  if (!next || next.id === selectedVersionId.value) return
  selectedVersionId.value = next.id
  void loadPreview()
})

onBeforeUnmount(() => {
  mounted = false
  documentGeneration += 1
  previewGeneration += 1
  manualDownloadGeneration += 1
  cancelPreviewDownload()
  cancelManualDownload()
  cleanupPreviewUrl()
})
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    append-to-body
    fullscreen
    class="document-preview-dialog"
    modal-class="document-preview-overlay"
    title="项目资料预览"
    :show-close="false"
    :close-on-click-modal="false"
    :before-close="requestClose"
  >
    <template #header="{ titleId, titleClass }">
      <header class="document-preview__header">
        <el-button data-testid="document-preview-close" @click="requestClose">返回资料列表</el-button>
        <div :id="titleId" :class="[titleClass, 'document-preview__identity']">
          <el-text type="info">{{ projectCode }}</el-text>
          <strong>{{ detail?.title ?? '正在读取文档' }}</strong>
        </div>
        <el-space class="document-preview__header-actions" wrap>
          <el-select
            data-testid="document-preview-version-select"
            :model-value="selectedVersionId"
            aria-label="选择文档版本"
            placeholder="选择版本"
            :disabled="sortedVersions.length === 0"
            @change="selectVersion"
          >
            <el-option
              v-for="version in sortedVersions"
              :key="version.id"
              :value="version.id"
              :label="`V${version.version_number} · ${traceableDocumentFilename(version)}`"
            />
          </el-select>
          <el-select
            data-testid="document-preview-document-select"
            :model-value="documentId"
            aria-label="选择项目资料"
            placeholder="选择资料"
            filterable
            @change="selectDocument"
          >
            <el-option v-for="document in documents" :key="document.id" :value="document.id" :label="document.title" />
          </el-select>
          <el-button
            data-testid="document-preview-download"
            type="primary"
            :loading="downloadBusy"
            :disabled="!currentVersion || downloadBusy"
            @click="downloadCurrent"
          >下载原文件</el-button>
        </el-space>
      </header>
    </template>
    <section class="document-preview" data-testid="document-preview-workbench">
      <div class="document-preview__body">
      <aside class="document-preview__documents">
        <p class="pane-title">项目资料</p>
        <el-menu :default-active="String(documentId)" @select="selectDocument">
          <el-menu-item v-for="document in documents" :key="document.id" :index="String(document.id)">
            <div class="document-menu-item">
              <strong>{{ document.title }}</strong>
              <small>V{{ document.latest_version_number }}</small>
            </div>
          </el-menu-item>
        </el-menu>
      </aside>

      <main class="document-preview__stage">
        <el-skeleton v-if="loading" :rows="8" animated />
        <el-result v-else-if="loadError" icon="error" title="文档读取失败" :sub-title="loadError">
          <template #extra><el-button type="primary" @click="loadDocument">重新读取</el-button></template>
        </el-result>
        <el-skeleton v-else-if="previewLoading" :rows="10" animated />
        <el-result v-else-if="previewError" icon="error" title="无法预览" :sub-title="previewError">
          <template #extra><el-button type="primary" :loading="downloadBusy" :disabled="downloadBusy" @click="downloadCurrent">下载原文件</el-button></template>
        </el-result>
        <el-result
          v-else-if="previewTooLarge"
          data-testid="document-preview-too-large"
          icon="warning"
          title="文件过大，不在网页中自动加载"
          :sub-title="currentVersion ? `${traceableDocumentFilename(currentVersion)} · ${formatBytes(currentVersion.size_bytes)}` : ''"
        >
          <template #extra><el-button type="primary" :loading="downloadBusy" :disabled="downloadBusy" @click="downloadCurrent">下载后查看</el-button></template>
        </el-result>

        <template v-else-if="previewKind === 'text'">
          <div class="document-preview__toolbar">
            <el-input
              v-model="searchText"
              data-testid="document-preview-search"
              clearable
              placeholder="搜索纪要内容"
            />
            <el-text data-testid="document-preview-search-summary" type="info">
              {{ searchText.trim() ? (searchMatchCount ? `${searchMatchCount} 处 · 当前第 ${activeSearchMatch + 1} 处` : '0 处') : '输入关键词搜索' }}
            </el-text>
            <el-button :disabled="searchMatchCount === 0" aria-label="上一个搜索结果" @click="focusSearchMatch(activeSearchMatch - 1)">上一个</el-button>
            <el-button :disabled="searchMatchCount === 0" aria-label="下一个搜索结果" @click="focusSearchMatch(activeSearchMatch + 1)">下一个</el-button>
            <el-button data-testid="document-preview-copy" @click="copyText">复制全文</el-button>
            <el-button data-testid="document-preview-print" @click="printText">打印</el-button>
          </div>
          <el-alert v-if="copyNotice" :title="copyNotice" :type="copyNoticeType" :closable="false" />
          <article data-testid="document-preview-text" class="document-preview__paper">
            <pre><template v-for="(segment, index) in highlightedText" :key="`${index}-${segment.index}`"><mark v-if="segment.match" :data-search-match="segment.index" :class="{ 'is-active': segment.index === activeSearchMatch }">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></pre>
          </article>
        </template>

        <template v-else-if="previewKind === 'image' && previewObjectUrl">
          <div class="document-preview__toolbar">
            <el-button @click="zoomImage(-0.25)">缩小</el-button>
            <el-text>{{ Math.round(imageScale * 100) }}%</el-text>
            <el-button @click="zoomImage(0.25)">放大</el-button>
            <el-button @click="rotateImage">旋转 90°</el-button>
          </div>
          <div class="document-preview__canvas">
            <img
              data-testid="document-preview-image"
              :src="previewObjectUrl"
              :alt="detail?.title ?? (currentVersion ? managedDocumentFilename(currentVersion) : '')"
              :style="imageTransform"
            >
          </div>
        </template>

        <iframe
          v-else-if="previewKind === 'pdf' && previewObjectUrl"
          data-testid="document-preview-pdf"
          class="document-preview__pdf"
          :src="previewObjectUrl"
          title="PDF 文件预览"
        />

        <el-result
          v-else
          data-testid="document-preview-unsupported"
          icon="info"
          title="当前格式不支持网页预览"
          :sub-title="currentVersion ? `${traceableDocumentFilename(currentVersion)} · ${formatBytes(currentVersion.size_bytes)}` : '当前文档没有可用版本'"
        >
          <template #extra><el-button v-if="currentVersion" type="primary" :loading="downloadBusy" :disabled="downloadBusy" @click="downloadCurrent">下载原文件</el-button></template>
        </el-result>
      </main>

      <aside class="document-preview__versions">
        <p class="pane-title">版本记录</p>
        <el-timeline v-if="sortedVersions.length">
          <el-timeline-item
            v-for="version in sortedVersions"
            :key="version.id"
            :timestamp="formatChineseDateTime(version.created_at)"
            :type="version.id === selectedVersionId ? 'primary' : undefined"
          >
            <el-button
              :type="version.id === selectedVersionId ? 'primary' : 'default'"
              :plain="version.id !== selectedVersionId"
              @click="selectVersion(version.id)"
            >V{{ version.version_number }} · {{ traceableDocumentFilename(version) }}</el-button>
            <p>{{ version.notes ?? '无版本说明' }}</p>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无版本" />
      </aside>
      </div>
    </section>
  </el-dialog>
</template>

<style scoped>
.document-preview-dialog {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
}
:global(.document-preview-dialog .el-dialog__header) { margin: 0; padding: 0; }
:global(.document-preview-dialog .el-dialog__body) { min-height: 0; overflow: hidden; padding: 0; }
.document-preview {
  height: 100%;
  background: var(--sunyu-bg, #eef1f4);
}
.document-preview__header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--sunyu-line);
  background: #fff;
}
.document-preview__identity { min-width: 0; display: grid; gap: 2px; }
.document-preview__identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-preview__header-actions :deep(.el-select) { width: min(250px, 29vw); }
.document-preview__body { height: 100%; min-height: 0; display: grid; grid-template-columns: 240px minmax(0, 1fr) 300px; }
.document-preview__documents,
.document-preview__versions { min-height: 0; overflow: auto; padding: 16px 12px; background: #fff; }
.document-preview__documents { border-right: 1px solid var(--sunyu-line); }
.document-preview__versions { border-left: 1px solid var(--sunyu-line); }
.pane-title { margin: 0 8px 12px; color: var(--sunyu-muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; }
.document-preview__documents :deep(.el-menu) { border-right: 0; }
.document-preview__documents :deep(.el-menu-item) { height: auto; min-height: 56px; padding: 8px 12px; line-height: 1.35; }
.document-menu-item { min-width: 0; display: grid; gap: 4px; }
.document-menu-item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-menu-item small { color: var(--sunyu-muted); }
.document-preview__stage { min-width: 0; min-height: 0; overflow: auto; display: grid; align-content: start; }
.document-preview__toolbar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--sunyu-line); background: rgba(255, 255, 255, .96); }
.document-preview__toolbar :deep(.el-input) { width: min(420px, 45vw); }
.document-preview__paper { width: min(920px, calc(100% - 48px)); min-height: calc(100vh - 160px); margin: 24px auto; padding: 48px 56px; background: #fff; box-shadow: 0 10px 30px rgba(20, 32, 51, .1); }
.document-preview__paper pre { margin: 0; color: var(--sunyu-ink); font: inherit; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; }
.document-preview__paper mark { padding: 0 2px; background: var(--el-color-warning-light-5); color: inherit; }
.document-preview__paper mark.is-active { background: var(--el-color-warning); outline: 2px solid var(--el-color-primary); }
.document-preview__canvas { min-height: calc(100vh - 130px); display: grid; place-items: center; overflow: auto; padding: 24px; }
.document-preview__canvas img { display: block; max-width: 100%; max-height: calc(100vh - 180px); transform-origin: center; transition: transform .16s ease; }
.document-preview__pdf { width: 100%; height: 100%; min-height: calc(100vh - 74px); border: 0; background: #fff; }
.document-preview__versions :deep(.el-timeline) { padding-left: 8px; }
.document-preview__versions :deep(.el-button) { max-width: 100%; height: auto; padding: 8px 10px; white-space: normal; text-align: left; }
.document-preview__versions p { margin: 7px 0 0; color: var(--sunyu-muted); font-size: 12px; line-height: 1.5; }
@media (max-width: 1100px) {
  .document-preview__body { grid-template-columns: 210px minmax(0, 1fr); }
  .document-preview__versions { display: none; }
}
@media (max-width: 720px) {
  .document-preview__header { grid-template-columns: auto minmax(0, 1fr); }
  .document-preview__header > :last-child { grid-column: 1 / -1; justify-content: flex-end; }
  .document-preview__header-actions { width: 100%; }
  .document-preview__header-actions :deep(.el-select) { width: min(100%, 320px); flex: 1; }
  .document-preview__body { display: block; overflow: auto; }
  .document-preview__documents { display: none; }
  .document-preview__stage { min-height: 100%; }
  .document-preview__toolbar { flex-wrap: wrap; padding: 10px 12px; }
  .document-preview__toolbar :deep(.el-input) { width: 100%; }
  .document-preview__paper { width: 100%; min-height: calc(100vh - 190px); margin: 0; padding: 28px 20px; box-shadow: none; }
}
@media print {
  :global(body > #app) { display: none !important; }
  :global(body > .document-preview-overlay) {
    position: static !important;
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }
  :global(.document-preview-overlay .el-overlay-dialog) {
    position: static !important;
    overflow: visible !important;
  }
  :global(.document-preview-dialog.el-dialog.is-fullscreen) {
    position: static !important;
    display: block !important;
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
  }
  :global(.document-preview-dialog.el-dialog.is-fullscreen .el-dialog__body) {
    height: auto !important;
    overflow: visible !important;
  }
  :global(.document-preview-dialog .el-dialog__header),
  .document-preview__documents,
  .document-preview__versions,
  .document-preview__toolbar,
  .document-preview :deep(.el-alert) { display: none; }
  .document-preview { height: auto; overflow: visible; }
  .document-preview__body,
  .document-preview__stage { display: block; overflow: visible; }
  .document-preview__paper { width: 100%; min-height: auto; margin: 0; padding: 0; box-shadow: none; }
}
</style>
