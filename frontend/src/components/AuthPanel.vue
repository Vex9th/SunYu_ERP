<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  passwordConfigured: boolean
  busy: boolean
  requestError: string | null
}>()

const emit = defineEmits<{
  submit: [password: string]
}>()

const password = ref('')
const confirmPassword = ref('')
const validationError = ref<string | null>(null)
const isSetup = computed(() => !props.passwordConfigured)

watch(
  () => props.passwordConfigured,
  () => {
    password.value = ''
    confirmPassword.value = ''
    validationError.value = null
  },
)

function submit(): void {
  validationError.value = null
  if (!/^[0-9]{6}$/.test(password.value)) {
    validationError.value = '密码必须是 6 位数字'
    return
  }
  if (isSetup.value && confirmPassword.value !== password.value) {
    validationError.value = '两次输入的密码不一致'
    return
  }
  emit('submit', password.value)
}
</script>

<template>
  <el-container class="auth-shell">
    <el-main data-testid="auth-form-side" class="auth-main">
      <div class="auth-brand">
        <div class="brand-mark">SY</div>
        <div>
          <div class="brand-name">SunYu ERP</div>
          <div class="brand-caption">工业项目工作台</div>
        </div>
      </div>

      <el-card class="auth-card" shadow="never">
          <el-text class="page-eyebrow">本机访问</el-text>
          <h2 data-testid="auth-title">{{ isSetup ? '首次设置' : '密码登录' }}</h2>
          <el-text class="auth-description">
            {{ isSetup ? '设置本机唯一的 6 位数字访问密码。' : '输入 6 位数字密码，继续处理你的项目。' }}
          </el-text>

          <el-alert
            title="数据保存在当前主机，未登录前不会读取业务资料。"
            type="info"
            :closable="false"
          />

          <el-alert
            v-if="requestError"
            data-testid="request-error"
            :title="requestError"
            type="error"
            show-icon
            :closable="false"
          />
          <el-alert
            v-if="validationError"
            :title="validationError"
            type="error"
            show-icon
            :closable="false"
          />

          <el-form label-position="top" @submit.prevent="submit">
            <el-form-item label="六位访问密码">
              <el-input
                :data-testid="isSetup ? 'setup-password' : 'login-password'"
                v-model="password"
                type="password"
                inputmode="numeric"
                :autocomplete="isSetup ? 'new-password' : 'current-password'"
                maxlength="6"
                size="large"
                show-password
                :disabled="busy"
                aria-label="六位数字访问密码"
                @keyup.enter="submit"
              />
            </el-form-item>

            <el-form-item v-if="isSetup" label="再次输入">
              <el-input
                data-testid="setup-confirm"
                v-model="confirmPassword"
                type="password"
                inputmode="numeric"
                autocomplete="new-password"
                maxlength="6"
                size="large"
                show-password
                :disabled="busy"
                aria-label="再次输入六位数字访问密码"
                @keyup.enter="submit"
              />
            </el-form-item>

            <el-button
              data-testid="auth-submit"
              class="auth-submit"
              native-type="submit"
              type="primary"
              size="large"
              :loading="busy"
              :disabled="busy"
            >
              {{ isSetup ? '完成设置并进入' : '进入总工作台' }}
            </el-button>
          </el-form>
      </el-card>
      <p class="auth-footnote">本地数据 · 单人使用 · 项目资料集中管理</p>
    </el-main>
  </el-container>
</template>
