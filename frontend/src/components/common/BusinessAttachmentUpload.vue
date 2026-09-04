<script setup lang="ts">
import type { UploadFile, UploadFiles, UploadInstance, UploadProps, UploadRawFile, UploadUserFile } from 'element-plus'
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: File[]
  accept?: string
  disabled?: boolean
  busy?: boolean
  maxFiles?: number
  maxFileSizeBytes?: number
  testId?: string
}>(), {
  accept: '',
  disabled: false,
  busy: false,
  maxFiles: 20,
  maxFileSizeBytes: undefined,
  testId: 'business-attachment-upload',
})

const emit = defineEmits<{
  'update:modelValue': [files: File[]]
}>()

const upload = ref<UploadInstance>()
const validationError = ref<string | null>(null)
const unavailable = computed(() => props.disabled || props.busy)
const uploadFiles = computed<UploadUserFile[]>(() => props.modelValue.map((file, index) => ({
  name: file.name,
  size: file.size,
  raw: file as UploadRawFile,
  uid: index + 1,
})))
const acceptedFormatLabel = computed(() => {
  const labels: string[] = []
  for (const entry of props.accept.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)) {
    if (entry === 'image/*') labels.push('图片')
    else if (entry.startsWith('.')) labels.push(entry.slice(1).toUpperCase())
  }
  return [...new Set(labels)].join('、') || '指定格式'
})

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

function selectedFiles(files: UploadFiles): File[] {
  return files.flatMap((item) => item.raw ? [item.raw as File] : [])
}

function rejectFile(file: UploadFile, message: string): void {
  validationError.value = message
  upload.value?.handleRemove(file)
}

const handleChange: UploadProps['onChange'] = (file: UploadFile, files: UploadFiles) => {
  if (unavailable.value) return
  const next = selectedFiles(files)
  if (next.length > props.maxFiles) {
    rejectFile(file, `最多选择 ${props.maxFiles} 个文件，请先移除不需要的文件。`)
    return
  }
  const unsupported = files.find((item) => item.raw && !accepts(item.raw as File))
  if (unsupported) {
    rejectFile(unsupported, `${unsupported.name} 格式不支持，只支持 ${acceptedFormatLabel.value}。`)
    return
  }
  if (props.maxFileSizeBytes !== undefined) {
    const oversized = files.find((item) => item.raw && item.raw.size > props.maxFileSizeBytes!)
    if (oversized) {
      rejectFile(oversized, `${oversized.name} 超过限制，单个文件不能超过 ${formatFileSize(props.maxFileSizeBytes)}。`)
      return
    }
  }
  validationError.value = null
  emit('update:modelValue', next)
}

const handleExceed: UploadProps['onExceed'] = () => {
  if (!unavailable.value) {
    validationError.value = `最多选择 ${props.maxFiles} 个文件，请先移除不需要的文件。`
  }
}

function removeFile(index: number): void {
  if (unavailable.value) return
  validationError.value = null
  emit('update:modelValue', props.modelValue.filter((_, itemIndex) => itemIndex !== index))
}

watch(() => props.modelValue, () => {
  if (props.modelValue.length <= props.maxFiles) validationError.value = null
})
</script>

<template>
  <div class="business-attachment-upload" :data-testid="testId">
    <el-upload
      ref="upload"
      class="business-attachment-upload__control"
      drag
      multiple
      :auto-upload="false"
      :show-file-list="false"
      :file-list="uploadFiles"
      :accept="accept"
      :disabled="unavailable"
      :limit="maxFiles"
      :on-change="handleChange"
      :on-exceed="handleExceed"
    >
      <div class="el-upload__text">将文件拖到这里，或<em>点击选择</em></div>
      <template #tip>
        <el-text size="small" type="info">
          支持 {{ acceptedFormatLabel }}；最多 {{ maxFiles }} 个文件；{{ maxFileSizeBytes === undefined ? '单个文件大小以后端限制为准' : `单个文件不超过 ${formatFileSize(maxFileSizeBytes)}` }}。
        </el-text>
      </template>
    </el-upload>

    <el-alert
      v-if="validationError"
      :data-testid="`${testId}-error`"
      :title="validationError"
      type="error"
      :closable="false"
      show-icon
    />

    <el-space
      v-if="modelValue.length"
      :data-testid="`${testId}-list`"
      class="business-attachment-upload__list"
      direction="vertical"
      alignment="stretch"
      fill
    >
      <el-row v-for="(file, index) in modelValue" :key="`${file.name}-${file.size}-${file.lastModified}-${index}`" class="business-attachment-upload__row" justify="space-between" align="middle">
        <div class="business-attachment-upload__summary">
          <span
            :data-testid="`${testId}-name-${index}`"
            class="business-attachment-upload__name"
            :title="file.name"
          >{{ file.name }}</span>
          <el-tag class="business-attachment-upload__size" size="small" type="info">{{ formatFileSize(file.size) }}</el-tag>
        </div>
        <el-button
          :data-testid="`${testId}-remove-${index}`"
          class="business-attachment-upload__remove"
          link
          type="danger"
          :disabled="unavailable"
          @click="removeFile(index)"
        >移除</el-button>
      </el-row>
    </el-space>

    <el-text size="small" type="info">
      保存后系统按项目/业务类型/日期自动命名，原文件名仍保留可追溯。
    </el-text>
  </div>
</template>

<style scoped>
.business-attachment-upload,
.business-attachment-upload__control,
.business-attachment-upload__control :deep(.el-upload),
.business-attachment-upload__control :deep(.el-upload-dragger) {
  width: 100%;
}

.business-attachment-upload__list {
  width: 100%;
  max-height: 224px;
  overflow-y: auto;
  padding-inline-end: 4px;
}

.business-attachment-upload__list :deep(.el-space__item),
.business-attachment-upload__row {
  width: 100%;
  min-width: 0;
}

.business-attachment-upload__row {
  flex-wrap: nowrap;
  gap: 8px;
}

.business-attachment-upload__summary {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.business-attachment-upload__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.business-attachment-upload__size,
.business-attachment-upload__remove {
  flex: 0 0 auto;
}
</style>
