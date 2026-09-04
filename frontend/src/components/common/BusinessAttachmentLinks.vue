<script setup lang="ts">
import { computed } from 'vue'

interface AttachmentOption {
  value: number
  label: string
}

const props = withDefaults(defineProps<{
  projectCode: string
  versionIds: readonly number[]
  options?: readonly AttachmentOption[]
  testId?: string
}>(), {
  options: () => [],
  testId: 'business-attachment-links',
})

const optionLabels = computed(() => new Map(
  props.options.map((option) => [option.value, option.label]),
))

function attachmentLabel(versionId: number, index: number): string {
  return optionLabels.value.get(versionId) ?? `附件 ${index + 1}`
}

function downloadUrl(versionId: number): string {
  return `/api/projects/${encodeURIComponent(props.projectCode)}/document-versions/${versionId}/download`
}
</script>

<template>
  <el-space v-if="versionIds.length" class="business-attachment-links" wrap>
    <el-link
      v-for="(versionId, index) in versionIds"
      :key="versionId"
      :data-testid="`${testId}-${versionId}`"
      :href="downloadUrl(versionId)"
      :download="attachmentLabel(versionId, index)"
      type="primary"
    >下载：{{ attachmentLabel(versionId, index) }}</el-link>
  </el-space>
  <el-text v-else size="small" type="info">无附件</el-text>
</template>

<style scoped>
.business-attachment-links {
  max-width: 100%;
}

.business-attachment-links :deep(.el-link__inner) {
  max-width: min(420px, 70vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
