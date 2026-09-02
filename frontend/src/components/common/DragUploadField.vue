<script setup lang="ts">
import type {
  UploadFile,
  UploadFiles,
  UploadInstance,
  UploadProps,
} from 'element-plus'
import { computed, nextTick, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: File | null
  accept?: string
  disabled?: boolean
  busy?: boolean
  testId?: string
  inputTestId?: string
  title?: string
  hint?: string
}>(), {
  accept: '',
  disabled: false,
  busy: false,
  testId: 'drag-upload',
  inputTestId: '',
  title: '将文件拖到这里，或点击选择',
  hint: '',
})

const emit = defineEmits<{
  'update:modelValue': [file: File | null]
}>()

const upload = ref<UploadInstance>()
const field = ref<HTMLElement>()
const validationError = ref<string | null>(null)
const unavailable = computed(() => props.disabled || props.busy)

const acceptLabel = computed(() => {
  const extensions = props.accept
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('.'))
    .map((item) => item.slice(1).toUpperCase())
  return [...new Set(extensions)].join('、') || '指定格式'
})

const fileType = computed(() => {
  const file = props.modelValue
  if (!file) return ''
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toUpperCase() : ''
  return extension || file.type || '未知类型'
})

const fileSize = computed(() => formatFileSize(props.modelValue?.size ?? 0))

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${trimDecimal(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${trimDecimal(bytes / 1024 ** 2)} MB`
  return `${trimDecimal(bytes / 1024 ** 3)} GB`
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, '')
}

function accepts(file: File): boolean {
  if (!props.accept.trim()) return true
  const filename = file.name.toLowerCase()
  const mime = file.type.toLowerCase()
  return props.accept.split(',').some((entry) => {
    const rule = entry.trim().toLowerCase()
    if (!rule) return false
    if (rule.startsWith('.')) return filename.endsWith(rule)
    if (rule.endsWith('/*')) return mime.startsWith(rule.slice(0, -1))
    return mime === rule
  })
}

function selectFile(file: File): void {
  if (unavailable.value) return
  if (!accepts(file)) {
    validationError.value = `文件格式不正确，只支持 ${acceptLabel.value}`
    upload.value?.clearFiles()
    return
  }
  validationError.value = null
  emit('update:modelValue', file)
}

const handleChange: UploadProps['onChange'] = (uploadFile: UploadFile, _uploadFiles: UploadFiles) => {
  if (uploadFile.raw) selectFile(uploadFile.raw)
}

const handleExceed: UploadProps['onExceed'] = (files) => {
  const replacement = files[files.length - 1]
  if (!replacement) return
  upload.value?.clearFiles()
  selectFile(replacement)
}

function removeFile(): void {
  if (unavailable.value) return
  upload.value?.clearFiles()
  validationError.value = null
  emit('update:modelValue', null)
}

function syncInputTestId(): void {
  const input = field.value?.querySelector('input[type="file"]')
  if (props.inputTestId) input?.setAttribute('data-testid', props.inputTestId)
  else input?.removeAttribute('data-testid')
}

onMounted(() => {
  syncInputTestId()
})

watch(() => props.inputTestId, () => {
  void nextTick(syncInputTestId)
})

watch(() => props.modelValue, (file) => {
  if (!file) {
    upload.value?.clearFiles()
    validationError.value = null
  }
})
</script>

<template>
  <div ref="field" class="drag-upload-field" :data-testid="testId">
    <el-upload
      ref="upload"
      drag
      action="#"
      :auto-upload="false"
      :accept="accept"
      :disabled="unavailable"
      :limit="1"
      :show-file-list="false"
      :on-change="handleChange"
      :on-exceed="handleExceed"
    >
      <div class="upload-callout">
        <strong>{{ busy ? '正在处理文件…' : title }}</strong>
        <span>{{ modelValue ? '再次选择或拖入即可替换当前文件' : (hint || `单次选择 1 个文件${accept ? ` · 支持 ${acceptLabel}` : ''}`) }}</span>
      </div>
    </el-upload>

    <div v-if="modelValue" class="selected-file" data-testid="drag-upload-selected-file">
      <div class="file-summary">
        <strong :data-testid="`${testId}-file-name`">{{ modelValue.name }}</strong>
        <span :data-testid="`${testId}-file-meta`">{{ fileType }} · {{ fileSize }}</span>
      </div>
      <el-button
        :data-testid="`${testId}-remove`"
        type="danger"
        text
        :disabled="unavailable"
        @click="removeFile"
      >移除</el-button>
    </div>

    <p
      v-if="validationError"
      :data-testid="`${testId}-error`"
      class="upload-error"
      role="alert"
    >{{ validationError }}</p>
  </div>
</template>

<style scoped>
.drag-upload-field {
  display: grid;
  width: 100%;
  gap: 10px;
}

.drag-upload-field :deep(.el-upload),
.drag-upload-field :deep(.el-upload-dragger) {
  width: 100%;
}

.drag-upload-field :deep(.el-upload-dragger) {
  padding: 22px 18px;
  border-color: var(--el-border-color);
  background: var(--el-fill-color-extra-light);
}

.drag-upload-field :deep(.el-upload-dragger:hover) {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.upload-callout,
.file-summary {
  display: grid;
  gap: 6px;
}

.upload-callout strong {
  color: var(--el-text-color-primary);
  font-size: 15px;
}

.upload-callout span,
.file-summary span {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.selected-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color-page);
}

.file-summary {
  min-width: 0;
}

.file-summary strong {
  overflow: hidden;
  color: var(--el-text-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-error {
  margin: 0;
  color: var(--el-color-danger);
  font-size: 13px;
}
</style>
