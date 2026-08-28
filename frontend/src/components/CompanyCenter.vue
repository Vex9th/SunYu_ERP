<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

import { ApiError, requestJson, requestVoid } from '../api'
import type {
  CompanyDetail,
  CompanyPayload,
  CompanySummary,
  Contact,
  ContactPayload,
} from '../types'

const emit = defineEmits<{
  'session-expired': [message: string]
}>()

const companies = ref<CompanySummary[]>([])
const loading = ref(true)
const listError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const companyBusy = ref(false)
const contactBusy = ref(false)

const companyDialogVisible = ref(false)
const editingCompanyId = ref<number | null>(null)
const companyValidationError = ref<string | null>(null)
const companyForm = reactive({
  name: '',
  taxpayer_id: '',
  registered_address: '',
  registered_phone: '',
  bank_name: '',
  bank_account: '',
  notes: '',
})

const detailVisible = ref(false)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)
const detail = ref<CompanyDetail | null>(null)
const selectedDetailCompanyId = ref<number | null>(null)
let detailLoadVersion = 0

const contactDialogVisible = ref(false)
const editingContactId = ref<number | null>(null)
const contactValidationError = ref<string | null>(null)
const contactForm = reactive({
  name: '',
  phone: '',
  email: '',
  position: '',
  notes: '',
})

const companyDeleteVisible = ref(false)
const companyDeleteTarget = ref<CompanySummary | null>(null)
const contactDeleteVisible = ref(false)
const contactDeleteTarget = ref<Contact | null>(null)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

function handleSessionError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  emit('session-expired', error.message)
  return true
}

function optional(value: string): string | null {
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function companyPayload(): CompanyPayload | null {
  const name = companyForm.name.trim()
  if (!name) {
    companyValidationError.value = '请输入公司名称'
    return null
  }
  companyValidationError.value = null
  return {
    name,
    taxpayer_id: optional(companyForm.taxpayer_id),
    registered_address: optional(companyForm.registered_address),
    registered_phone: optional(companyForm.registered_phone),
    bank_name: optional(companyForm.bank_name),
    bank_account: optional(companyForm.bank_account),
    notes: optional(companyForm.notes),
  }
}

function contactPayload(): ContactPayload | null {
  const name = contactForm.name.trim()
  if (!name) {
    contactValidationError.value = '请输入联系人姓名'
    return null
  }
  contactValidationError.value = null
  return {
    name,
    phone: optional(contactForm.phone),
    email: optional(contactForm.email),
    position: optional(contactForm.position),
    notes: optional(contactForm.notes),
  }
}

async function loadCompanies(): Promise<void> {
  if (loading.value) return
  loading.value = true
  listError.value = null
  try {
    companies.value = await requestJson<CompanySummary[]>('/api/companies')
  } catch (error) {
    companies.value = []
    if (!handleSessionError(error)) listError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function initialLoad(): Promise<void> {
  loading.value = false
  await loadCompanies()
}

function resetCompanyForm(): void {
  companyForm.name = ''
  companyForm.taxpayer_id = ''
  companyForm.registered_address = ''
  companyForm.registered_phone = ''
  companyForm.bank_name = ''
  companyForm.bank_account = ''
  companyForm.notes = ''
  companyValidationError.value = null
}

function openCompanyCreate(): void {
  actionError.value = null
  editingCompanyId.value = null
  resetCompanyForm()
  companyDialogVisible.value = true
}

function openCompanyEdit(company: CompanySummary): void {
  actionError.value = null
  editingCompanyId.value = company.id
  companyForm.name = company.name
  companyForm.taxpayer_id = company.taxpayer_id ?? ''
  companyForm.registered_address = company.registered_address ?? ''
  companyForm.registered_phone = company.registered_phone ?? ''
  companyForm.bank_name = company.bank_name ?? ''
  companyForm.bank_account = company.bank_account ?? ''
  companyForm.notes = company.notes ?? ''
  companyValidationError.value = null
  companyDialogVisible.value = true
}

async function saveCompany(): Promise<void> {
  if (companyBusy.value) return
  const payload = companyPayload()
  if (!payload) return
  companyBusy.value = true
  actionError.value = null
  try {
    const path = editingCompanyId.value === null
      ? '/api/companies'
      : `/api/companies/${editingCompanyId.value}`
    await requestJson<CompanyDetail>(path, {
      method: editingCompanyId.value === null ? 'POST' : 'PUT',
      body: payload,
    })
    companyDialogVisible.value = false
    await loadCompanies()
  } catch (error) {
    if (!handleSessionError(error)) actionError.value = errorMessage(error)
  } finally {
    companyBusy.value = false
  }
}

async function loadDetail(companyId: number): Promise<void> {
  const version = ++detailLoadVersion
  detailLoading.value = true
  detailError.value = null
  try {
    const response = await requestJson<CompanyDetail>(`/api/companies/${companyId}`)
    if (version === detailLoadVersion) detail.value = response
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (version !== detailLoadVersion) return
    if (!isSessionError) detailError.value = errorMessage(error)
  } finally {
    if (version === detailLoadVersion) detailLoading.value = false
  }
}

async function openDetail(companyId: number): Promise<void> {
  actionError.value = null
  detail.value = null
  selectedDetailCompanyId.value = companyId
  detailVisible.value = true
  await loadDetail(companyId)
}

async function retryDetail(): Promise<void> {
  if (selectedDetailCompanyId.value === null) return
  await loadDetail(selectedDetailCompanyId.value)
}

function closeDetail(): void {
  detailLoadVersion += 1
  selectedDetailCompanyId.value = null
  detail.value = null
  detailError.value = null
  detailLoading.value = false
  actionError.value = null
}

function resetContactForm(): void {
  contactForm.name = ''
  contactForm.phone = ''
  contactForm.email = ''
  contactForm.position = ''
  contactForm.notes = ''
  contactValidationError.value = null
}

function openContactCreate(): void {
  actionError.value = null
  editingContactId.value = null
  resetContactForm()
  contactDialogVisible.value = true
}

function openContactEdit(selected: Contact): void {
  actionError.value = null
  editingContactId.value = selected.id
  contactForm.name = selected.name
  contactForm.phone = selected.phone ?? ''
  contactForm.email = selected.email ?? ''
  contactForm.position = selected.position ?? ''
  contactForm.notes = selected.notes ?? ''
  contactValidationError.value = null
  contactDialogVisible.value = true
}

function beforeContactClose(done: () => void): void {
  if (!contactBusy.value) done()
}

function clearContactDialogState(): void {
  actionError.value = null
  contactValidationError.value = null
}

async function refreshDetailAndSummary(): Promise<void> {
  if (!detail.value) return
  const companyId = detail.value.id
  await loadDetail(companyId)
  await loadCompanies()
}

async function saveContact(): Promise<void> {
  if (contactBusy.value || !detail.value) return
  const payload = contactPayload()
  if (!payload) return
  contactBusy.value = true
  actionError.value = null
  const companyId = detail.value.id
  try {
    const path = editingContactId.value === null
      ? `/api/companies/${companyId}/contacts`
      : `/api/companies/${companyId}/contacts/${editingContactId.value}`
    await requestJson<Contact>(path, {
      method: editingContactId.value === null ? 'POST' : 'PUT',
      body: payload,
    })
    contactDialogVisible.value = false
    await refreshDetailAndSummary()
  } catch (error) {
    if (!handleSessionError(error)) actionError.value = errorMessage(error)
  } finally {
    contactBusy.value = false
  }
}

function openCompanyDelete(company: CompanySummary): void {
  companyDeleteTarget.value = company
  companyDeleteVisible.value = true
  actionError.value = null
}

async function deleteCompany(): Promise<void> {
  if (companyBusy.value || !companyDeleteTarget.value) return
  companyBusy.value = true
  actionError.value = null
  try {
    await requestVoid(`/api/companies/${companyDeleteTarget.value.id}`, { method: 'DELETE' })
    companyDeleteVisible.value = false
    companyDeleteTarget.value = null
    await loadCompanies()
  } catch (error) {
    if (!handleSessionError(error)) actionError.value = errorMessage(error)
  } finally {
    companyBusy.value = false
  }
}

function openContactDelete(selected: Contact): void {
  contactDeleteTarget.value = selected
  contactDeleteVisible.value = true
  actionError.value = null
}

async function deleteContact(): Promise<void> {
  if (contactBusy.value || !detail.value || !contactDeleteTarget.value) return
  contactBusy.value = true
  actionError.value = null
  try {
    await requestVoid(
      `/api/companies/${detail.value.id}/contacts/${contactDeleteTarget.value.id}`,
      { method: 'DELETE' },
    )
    contactDeleteVisible.value = false
    contactDeleteTarget.value = null
    await refreshDetailAndSummary()
  } catch (error) {
    if (!handleSessionError(error)) actionError.value = errorMessage(error)
  } finally {
    contactBusy.value = false
  }
}

onMounted(initialLoad)
</script>

<template>
  <el-space direction="vertical" alignment="stretch" fill :size="16">
    <el-card shadow="never">
      <template #header>
        <el-row justify="space-between" align="middle">
          <el-space direction="vertical" alignment="start" :size="2">
            <el-text tag="strong" size="large">客户与联系人</el-text>
            <el-text type="info">维护开票资料和一对多联系人</el-text>
          </el-space>
          <el-button data-testid="company-create-open" type="primary" @click="openCompanyCreate">
            新增公司
          </el-button>
        </el-row>
      </template>

      <el-alert
        v-if="actionError"
        data-testid="company-action-error"
        :title="actionError"
        type="error"
        show-icon
        :closable="false"
      />

      <el-skeleton v-if="loading" data-testid="companies-loading" :rows="5" animated>
        <template #template><el-text>正在读取客户资料</el-text></template>
      </el-skeleton>
      <el-result
        v-else-if="listError"
        data-testid="companies-error"
        icon="error"
        title="客户资料读取失败"
        :sub-title="listError"
      >
        <template #extra>
          <el-button data-testid="companies-retry" type="primary" @click="loadCompanies">重新读取</el-button>
        </template>
      </el-result>
      <el-empty v-else-if="companies.length === 0" data-testid="companies-empty" description="暂无客户，可以先新增公司" />
      <el-table v-else :data="companies" row-key="id">
        <el-table-column prop="name" label="公司名称" min-width="180" />
        <el-table-column prop="taxpayer_id" label="税号" min-width="160">
          <template #default="scope">{{ scope.row.taxpayer_id ?? '未录入' }}</template>
        </el-table-column>
        <el-table-column prop="registered_phone" label="联系电话" min-width="140">
          <template #default="scope">{{ scope.row.registered_phone ?? '未录入' }}</template>
        </el-table-column>
        <el-table-column prop="contact_count" label="联系人" width="90" />
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="scope">
            <el-space>
              <el-button :data-testid="`company-detail-${scope.row.id}`" link type="primary" @click="openDetail(scope.row.id)">详情</el-button>
              <el-button :data-testid="`company-edit-${scope.row.id}`" link @click="openCompanyEdit(scope.row)">编辑</el-button>
              <el-button :data-testid="`company-delete-${scope.row.id}`" link type="danger" @click="openCompanyDelete(scope.row)">删除</el-button>
            </el-space>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-drawer v-model="companyDialogVisible" :teleported="false" :title="editingCompanyId === null ? '新增公司' : '编辑公司'" size="520px">
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert v-if="companyValidationError" :title="companyValidationError" type="error" show-icon :closable="false" />
      <el-form label-position="top" @submit.prevent="saveCompany">
        <el-form-item label="公司名称" required><el-input data-testid="company-name" v-model="companyForm.name" :disabled="companyBusy" /></el-form-item>
        <el-form-item label="纳税人识别号"><el-input data-testid="company-taxpayer-id" v-model="companyForm.taxpayer_id" :disabled="companyBusy" /></el-form-item>
        <el-form-item label="注册地址"><el-input data-testid="company-address" v-model="companyForm.registered_address" :disabled="companyBusy" /></el-form-item>
        <el-form-item label="注册电话"><el-input data-testid="company-phone" v-model="companyForm.registered_phone" :disabled="companyBusy" /></el-form-item>
        <el-form-item label="开户行"><el-input data-testid="company-bank-name" v-model="companyForm.bank_name" :disabled="companyBusy" /></el-form-item>
        <el-form-item label="银行账号"><el-input data-testid="company-bank-account" v-model="companyForm.bank_account" :disabled="companyBusy" /></el-form-item>
        <el-form-item label="备注"><el-input data-testid="company-notes" v-model="companyForm.notes" type="textarea" :disabled="companyBusy" /></el-form-item>
        <el-button data-testid="company-save" type="primary" native-type="submit" :loading="companyBusy" :disabled="companyBusy">保存</el-button>
      </el-form>
    </el-drawer>

    <el-drawer v-model="detailVisible" data-testid="company-detail-drawer" :teleported="false" title="客户详情" size="720px" @close="closeDetail">
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-skeleton v-if="detailLoading" :rows="6" animated />
      <el-result v-else-if="detailError" data-testid="company-detail-error" icon="error" title="详情读取失败" :sub-title="detailError">
        <template #extra><el-button data-testid="company-detail-retry" type="primary" @click="retryDetail">重试</el-button></template>
      </el-result>
      <el-space v-else-if="detail" direction="vertical" alignment="stretch" fill :size="16">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="公司名称">{{ detail.name }}</el-descriptions-item>
          <el-descriptions-item label="税号">{{ detail.taxpayer_id ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="注册地址">{{ detail.registered_address ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="注册电话">{{ detail.registered_phone ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="开户行">{{ detail.bank_name ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="银行账号">{{ detail.bank_account ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ detail.notes ?? '无' }}</el-descriptions-item>
        </el-descriptions>
        <el-row justify="space-between" align="middle">
          <el-text tag="strong">联系人</el-text>
          <el-button data-testid="contact-create-open" type="primary" @click="openContactCreate">新增联系人</el-button>
        </el-row>
        <el-empty v-if="detail.contacts.length === 0" description="暂无联系人" />
        <el-table v-else :data="detail.contacts" row-key="id">
          <el-table-column prop="name" label="姓名" />
          <el-table-column prop="phone" label="电话"><template #default="scope">{{ scope.row.phone ?? '未录入' }}</template></el-table-column>
          <el-table-column prop="position" label="职务"><template #default="scope">{{ scope.row.position ?? '未录入' }}</template></el-table-column>
          <el-table-column label="操作" width="140">
            <template #default="scope">
              <el-button :data-testid="`contact-edit-${scope.row.id}`" link @click="openContactEdit(scope.row)">编辑</el-button>
              <el-button :data-testid="`contact-delete-${scope.row.id}`" link type="danger" @click="openContactDelete(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-space>
    </el-drawer>

    <el-dialog
      v-model="contactDialogVisible"
      data-testid="contact-dialog"
      :teleported="false"
      :title="editingContactId === null ? '新增联系人' : '编辑联系人'"
      width="520px"
      :before-close="beforeContactClose"
      :close-on-click-modal="!contactBusy"
      :close-on-press-escape="!contactBusy"
      :show-close="!contactBusy"
      @closed="clearContactDialogState"
    >
      <el-alert v-if="actionError" data-testid="contact-action-error" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert v-if="contactValidationError" :title="contactValidationError" type="error" show-icon :closable="false" />
      <el-form label-position="top" @submit.prevent="saveContact">
        <el-form-item label="姓名" required><el-input data-testid="contact-name" v-model="contactForm.name" :disabled="contactBusy" /></el-form-item>
        <el-form-item label="电话"><el-input data-testid="contact-phone" v-model="contactForm.phone" :disabled="contactBusy" /></el-form-item>
        <el-form-item label="邮箱"><el-input data-testid="contact-email" v-model="contactForm.email" :disabled="contactBusy" /></el-form-item>
        <el-form-item label="职务"><el-input data-testid="contact-position" v-model="contactForm.position" :disabled="contactBusy" /></el-form-item>
        <el-form-item label="备注"><el-input data-testid="contact-notes" v-model="contactForm.notes" type="textarea" :disabled="contactBusy" /></el-form-item>
        <el-button data-testid="contact-save" type="primary" native-type="submit" :loading="contactBusy" :disabled="contactBusy">保存</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="companyDeleteVisible" data-testid="company-delete-dialog" :teleported="false" title="确认删除公司" width="460px">
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert :title="`即将删除「${companyDeleteTarget?.name ?? ''}」及其联系人。`" type="warning" show-icon :closable="false" />
      <template #footer>
        <el-button @click="companyDeleteVisible = false">取消</el-button>
        <el-button data-testid="company-delete-confirm" type="danger" :loading="companyBusy" :disabled="companyBusy" @click="deleteCompany">确认删除</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="contactDeleteVisible" :teleported="false" title="确认删除联系人" width="460px">
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-text>即将删除「{{ contactDeleteTarget?.name }}」。</el-text>
      <template #footer>
        <el-button @click="contactDeleteVisible = false">取消</el-button>
        <el-button data-testid="contact-delete-confirm" type="danger" :loading="contactBusy" :disabled="contactBusy" @click="deleteContact">确认删除</el-button>
      </template>
    </el-dialog>
  </el-space>
</template>
