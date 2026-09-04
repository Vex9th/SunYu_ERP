<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const heading = ref<HTMLHeadingElement | null>(null)

onMounted(() => heading.value?.focus())

function returnHome(): void {
  void router.replace({ name: 'home' })
}
</script>

<template>
  <main data-testid="not-found-page" class="not-found-page">
    <el-result icon="warning" title="页面不存在" sub-title="这个地址无效，或页面已经移动。">
      <template #title>
        <h1 ref="heading" tabindex="-1">页面不存在</h1>
      </template>
      <template #extra>
        <el-button data-testid="not-found-home" type="primary" @click="returnHome">返回首页</el-button>
      </template>
    </el-result>
  </main>
</template>

<style scoped>
.not-found-page {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
  background: var(--el-bg-color-page);
}

h1:focus { outline: none; }
</style>
