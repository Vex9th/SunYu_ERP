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
  <el-container direction="vertical">
    <el-header>
      <el-row justify="center" align="middle">
        <el-col :xs="24" :sm="18" :md="12" :lg="8">
          <el-space>
            <el-tag type="warning" effect="dark">SY</el-tag>
            <el-text tag="strong" size="large">SunYu ERP</el-text>
          </el-space>
        </el-col>
      </el-row>
    </el-header>

    <el-main>
      <el-row justify="center">
        <el-col :xs="24" :sm="18" :md="12" :lg="8">
          <el-card shadow="never">
            <template #header>
              <el-space direction="vertical" alignment="start" :size="4">
                <el-text data-testid="auth-title" tag="h1" size="large">
                  {{ isSetup ? '首次设置' : '密码登录' }}
                </el-text>
                <el-text type="info">
                  {{ isSetup ? '请设置本机唯一的 6 位数字访问密码' : '请输入 6 位数字密码进入经营工作台' }}
                </el-text>
              </el-space>
            </template>

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
              <el-form-item label="访问密码">
                <el-input
                  :data-testid="isSetup ? 'setup-password' : 'login-password'"
                  v-model="password"
                  type="password"
                  inputmode="numeric"
                  :autocomplete="isSetup ? 'new-password' : 'current-password'"
                  maxlength="6"
                  show-password
                  :disabled="busy"
                  aria-label="六位数字访问密码"
                  @keyup.enter="submit"
                />
              </el-form-item>

              <el-form-item v-if="isSetup" label="确认密码">
                <el-input
                  data-testid="setup-confirm"
                  v-model="confirmPassword"
                  type="password"
                  inputmode="numeric"
                  autocomplete="new-password"
                  maxlength="6"
                  show-password
                  :disabled="busy"
                  aria-label="再次输入六位数字访问密码"
                  @keyup.enter="submit"
                />
              </el-form-item>

              <el-button
                data-testid="auth-submit"
                native-type="submit"
                type="primary"
                :loading="busy"
                :disabled="busy"
              >
                {{ isSetup ? '设置并进入' : '进入工作台' }}
              </el-button>
            </el-form>
          </el-card>
        </el-col>
      </el-row>
    </el-main>
  </el-container>
</template>
