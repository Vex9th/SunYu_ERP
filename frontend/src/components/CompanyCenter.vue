<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'

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
let companyDialogVersion = 0
let companyMutationVersion = 0
let contactDialogVersion = 0
let contactMutationVersion = 0
let companyDeleteVersion = 0
let contactDeleteVersion = 0

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
let companyLoadVersion = 0

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
  const version = ++companyLoadVersion
  loading.value = true
  listError.value = null
  try {
    const response = await requestJson<CompanySummary[]>('/api/companies')
    if (version === companyLoadVersion) companies.value = response
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (version !== companyLoadVersion) return
    companies.value = []
    if (!isSessionError) listError.value = errorMessage(error)
  } finally {
    if (version === companyLoadVersion) loading.value = false
  }
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
  companyDialogVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
  actionError.value = null
  editingCompanyId.value = null
  resetCompanyForm()
  companyDialogVisible.value = true
}

function openCompanyEdit(company: CompanySummary): void {
  companyDialogVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
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
  const dialogVersion = companyDialogVersion
  const mutationVersion = ++companyMutationVersion
  const companyId = editingCompanyId.value
  companyBusy.value = true
  actionError.value = null
  try {
    const path = companyId === null
      ? '/api/companies'
      : `/api/companies/${companyId}`
    await requestJson<CompanyDetail>(path, {
      method: companyId === null ? 'POST' : 'PUT',
      body: payload,
    })
    if (dialogVersion === companyDialogVersion) companyDialogVisible.value = false
    await loadCompanies()
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === companyDialogVersion) {
      actionError.value = errorMessage(error)
    }
  } finally {
    if (mutationVersion === companyMutationVersion) companyBusy.value = false
  }
}

function beforeCompanyClose(done: () => void): void {
  if (!companyBusy.value) done()
}

function beforeDetailClose(done: () => void): void {
  if (!contactBusy.value) done()
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
  contactDialogVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
  actionError.value = null
  editingContactId.value = null
  resetContactForm()
  contactDialogVisible.value = true
}

function openContactEdit(selected: Contact): void {
  contactDialogVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
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

async function refreshDetailAndSummary(companyId: number, refreshDetail: boolean): Promise<void> {
  if (refreshDetail && selectedDetailCompanyId.value === companyId) await loadDetail(companyId)
  await loadCompanies()
}

async function saveContact(): Promise<void> {
  if (contactBusy.value || !detail.value) return
  const payload = contactPayload()
  if (!payload) return
  const dialogVersion = contactDialogVersion
  const mutationVersion = ++contactMutationVersion
  contactBusy.value = true
  actionError.value = null
  const companyId = detail.value.id
  const contactId = editingContactId.value
  try {
    const path = contactId === null
      ? `/api/companies/${companyId}/contacts`
      : `/api/companies/${companyId}/contacts/${contactId}`
    await requestJson<Contact>(path, {
      method: contactId === null ? 'POST' : 'PUT',
      body: payload,
    })
    const isCurrentDialog = dialogVersion === contactDialogVersion
    if (isCurrentDialog) contactDialogVisible.value = false
    await refreshDetailAndSummary(companyId, isCurrentDialog)
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === contactDialogVersion) {
      actionError.value = errorMessage(error)
    }
  } finally {
    if (mutationVersion === contactMutationVersion) contactBusy.value = false
  }
}

function openCompanyDelete(company: CompanySummary): void {
  companyDeleteVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
  companyDeleteTarget.value = company
  companyDeleteVisible.value = true
  actionError.value = null
}

async function deleteCompany(): Promise<void> {
  if (companyBusy.value || !companyDeleteTarget.value) return
  const dialogVersion = companyDeleteVersion
  const mutationVersion = ++companyMutationVersion
  const companyId = companyDeleteTarget.value.id
  companyBusy.value = true
  actionError.value = null
  try {
    await requestVoid(`/api/companies/${companyId}`, { method: 'DELETE' })
    if (dialogVersion === companyDeleteVersion) companyDeleteVisible.value = false
    await loadCompanies()
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === companyDeleteVersion) {
      actionError.value = errorMessage(error)
    }
  } finally {
    if (mutationVersion === companyMutationVersion) companyBusy.value = false
  }
}

function openContactDelete(selected: Contact): void {
  contactDeleteVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
  contactDeleteTarget.value = selected
  contactDeleteVisible.value = true
  actionError.value = null
}

async function deleteContact(): Promise<void> {
  if (contactBusy.value || !detail.value || !contactDeleteTarget.value) return
  const dialogVersion = contactDeleteVersion
  const mutationVersion = ++contactMutationVersion
  const companyId = detail.value.id
  const contactId = contactDeleteTarget.value.id
  contactBusy.value = true
  actionError.value = null
  try {
    await requestVoid(
      `/api/companies/${companyId}/contacts/${contactId}`,
      { method: 'DELETE' },
    )
    const isCurrentDialog = dialogVersion === contactDeleteVersion
    if (isCurrentDialog) contactDeleteVisible.value = false
    await refreshDetailAndSummary(companyId, isCurrentDialog)
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === contactDeleteVersion) {
      actionError.value = errorMessage(error)
    }
  } finally {
    if (mutationVersion === contactMutationVersion) contactBusy.value = false
  }
}

function beforeCompanyDeleteClose(done: () => void): void {
  if (!companyBusy.value) done()
}

function beforeContactDeleteClose(done: () => void): void {
  if (!contactBusy.value) done()
}

watch(companyDialogVisible, (visible) => {
  if (visible) return
  companyDialogVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
})

watch(contactDialogVisible, (visible) => {
  if (visible) return
  contactDialogVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
  actionError.value = null
  contactValidationError.value = null
})

watch(companyDeleteVisible, (visible) => {
  if (visible) return
  companyDeleteVersion += 1
  companyMutationVersion += 1
  companyBusy.value = false
  companyDeleteTarget.value = null
})

watch(contactDeleteVisible, (visible) => {
  if (visible) return
  contactDeleteVersion += 1
  contactMutationVersion += 1
  contactBusy.value = false
  contactDeleteTarget.value = null
})

onMounted(loadCompanies)
</script>

<template>
  <el-space class="page-stack" direction="vertical" alignment="stretch" fill :size="20">
    <section class="page-heading">
      <div>
        <h1>公司联系人</h1>
        <p>公司资料和联系人统一维护。</p>
      </div>
      <el-button data-testid="company-create-open" type="primary" size="large" @click="openCompanyCreate">
        新增公司
      </el-button>
    </section>

    <el-card class="data-card" shadow="never">
      <template #header>
        <el-text tag="strong" size="large">合作公司</el-text>
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
      <div v-else class="company-list-content">
      <div class="company-table-scroll">
      <el-table class="company-table" :data="companies" row-key="id">
        <el-table-column prop="name" label="公司名称" min-width="180" />
        <el-table-column prop="taxpayer_id" label="税号" min-width="160">
          <template #default="scope">{{ scope.row.taxpayer_id ?? '未录入' }}</template>
        </el-table-column>
        <el-table-column prop="registered_phone" label="联系电话" min-width="140">
          <template #default="scope">{{ scope.row.registered_phone ?? '未录入' }}</template>
        </el-table-column>
        <el-table-column prop="contact_count" label="联系人" width="90" />
        <el-table-column label="操作" width="260">
          <template #default="scope">
            <el-space>
              <el-button :data-testid="`company-detail-${scope.row.id}`" link type="primary" @click="openDetail(scope.row.id)">详情</el-button>
              <el-button :data-testid="`company-edit-${scope.row.id}`" link @click="openCompanyEdit(scope.row)">编辑</el-button>
              <el-button :data-testid="`company-delete-${scope.row.id}`" link type="danger" @click="openCompanyDelete(scope.row)">删除</el-button>
            </el-space>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <div class="company-mobile-list">
        <el-card v-for="company in companies" :key="company.id" shadow="never" class="company-mobile-item">
          <strong>{{ company.name }}</strong>
          <span>电话：{{ company.registered_phone ?? '未录入' }}</span>
          <span>联系人：{{ company.contact_count }} 人</span>
          <div class="mobile-actions">
            <el-button type="primary" plain size="small" @click="openDetail(company.id)">详情</el-button>
            <el-button plain size="small" @click="openCompanyEdit(company)">编辑</el-button>
            <el-button type="danger" plain size="small" @click="openCompanyDelete(company)">删除</el-button>
          </div>
        </el-card>
      </div>
      </div>
    </el-card>

    <el-drawer
      v-model="companyDialogVisible"
      data-testid="company-form-drawer"
      :teleported="false"
      :title="editingCompanyId === null ? '新增公司' : '编辑公司'"
      size="min(92vw, 520px)"
      :before-close="beforeCompanyClose"
      :close-on-click-modal="!companyBusy"
      :close-on-press-escape="!companyBusy"
      :show-close="!companyBusy"
    >
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

    <el-drawer
      v-model="detailVisible"
      data-testid="company-detail-drawer"
      :teleported="false"
      title="客户详情"
      size="min(100vw, 760px)"
      :before-close="beforeDetailClose"
      :close-on-click-modal="!contactBusy"
      :close-on-press-escape="!contactBusy"
      :show-close="!contactBusy"
      @close="closeDetail"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-skeleton v-if="detailLoading" :rows="6" animated />
      <el-result v-else-if="detailError" data-testid="company-detail-error" icon="error" title="详情读取失败" :sub-title="detailError">
        <template #extra><el-button data-testid="company-detail-retry" type="primary" @click="retryDetail">重试</el-button></template>
      </el-result>
      <el-space
        v-else-if="detail"
        data-testid="company-detail-content"
        class="company-detail-content"
        direction="vertical"
        alignment="stretch"
        fill
        :size="16"
      >
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
        <div v-else class="contact-list-content">
        <div class="company-contact-table-scroll">
        <el-table data-testid="company-contact-table" class="company-contact-table" :data="detail.contacts" row-key="id">
          <el-table-column prop="name" label="姓名" min-width="110" />
          <el-table-column prop="phone" label="电话" min-width="150">
            <template #default="scope"><span :data-testid="`contact-phone-value-${scope.row.id}`" class="contact-phone-value">{{ scope.row.phone ?? '未录入' }}</span></template>
          </el-table-column>
          <el-table-column prop="position" label="职务" min-width="110"><template #default="scope">{{ scope.row.position ?? '未录入' }}</template></el-table-column>
          <el-table-column label="操作" width="140">
            <template #default="scope">
              <el-button :data-testid="`contact-edit-${scope.row.id}`" link @click="openContactEdit(scope.row)">编辑</el-button>
              <el-button :data-testid="`contact-delete-${scope.row.id}`" link type="danger" @click="openContactDelete(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        </div>
        <div class="contact-mobile-list">
          <el-card v-for="contact in detail.contacts" :key="contact.id" shadow="never" class="contact-mobile-item">
            <div><strong>{{ contact.name }}</strong><span>{{ contact.position ?? '未录入职务' }}</span></div>
            <span class="contact-phone-value">{{ contact.phone ?? '未录入电话' }}</span>
            <div class="mobile-actions">
              <el-button plain size="small" @click="openContactEdit(contact)">编辑</el-button>
              <el-button type="danger" plain size="small" @click="openContactDelete(contact)">删除</el-button>
            </div>
          </el-card>
        </div>
        </div>
      </el-space>
    </el-drawer>

    <el-dialog
      v-model="contactDialogVisible"
      data-testid="contact-dialog"
      :teleported="false"
      :title="editingContactId === null ? '新增联系人' : '编辑联系人'"
      width="min(92vw, 520px)"
      :before-close="beforeContactClose"
      :close-on-click-modal="!contactBusy"
      :close-on-press-escape="!contactBusy"
      :show-close="!contactBusy"
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

    <el-dialog
      v-model="companyDeleteVisible"
      data-testid="company-delete-dialog"
      :teleported="false"
      title="确认删除公司"
      width="min(92vw, 460px)"
      :before-close="beforeCompanyDeleteClose"
      :close-on-click-modal="!companyBusy"
      :close-on-press-escape="!companyBusy"
      :show-close="!companyBusy"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert :title="`即将删除「${companyDeleteTarget?.name ?? ''}」及其联系人。`" type="warning" show-icon :closable="false" />
      <template #footer>
        <el-button :disabled="companyBusy" @click="companyDeleteVisible = false">取消</el-button>
        <el-button data-testid="company-delete-confirm" type="danger" :loading="companyBusy" :disabled="companyBusy" @click="deleteCompany">确认删除</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="contactDeleteVisible"
      data-testid="contact-delete-dialog"
      :teleported="false"
      title="确认删除联系人"
      width="min(92vw, 460px)"
      :before-close="beforeContactDeleteClose"
      :close-on-click-modal="!contactBusy"
      :close-on-press-escape="!contactBusy"
      :show-close="!contactBusy"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-text>即将删除「{{ contactDeleteTarget?.name }}」。</el-text>
      <template #footer>
        <el-button :disabled="contactBusy" @click="contactDeleteVisible = false">取消</el-button>
        <el-button data-testid="contact-delete-confirm" type="danger" :loading="contactBusy" :disabled="contactBusy" @click="deleteContact">确认删除</el-button>
      </template>
    </el-dialog>
  </el-space>
</template>

<style scoped>
.company-table-scroll,
.company-contact-table-scroll { width: 100%; min-width: 0; max-width: 100%; overflow-x: auto; }
.company-table { width: 100%; min-width: 850px; }
.company-contact-table { width: 100%; min-width: 560px; }
.company-mobile-list,
.contact-mobile-list { display: none; }
.contact-phone-value { display: inline-block; min-width: 11em; white-space: nowrap; font-variant-numeric: tabular-nums; }
.company-detail-content,
.company-detail-content > :deep(.el-space__item) { width: 100%; min-width: 0 !important; max-width: 100%; }
@media (max-width: 520px) {
  .company-table-scroll,
  .company-contact-table-scroll { display: none; }
  .company-mobile-list,
  .contact-mobile-list { display: grid; gap: 10px; }
  .company-mobile-item :deep(.el-card__body),
  .contact-mobile-item :deep(.el-card__body) { display: grid; gap: 8px; padding: 14px; }
  .company-mobile-item span,
  .contact-mobile-item span { color: var(--sunyu-muted); }
  .contact-mobile-item > :deep(.el-card__body > div:first-child) { display: flex; justify-content: space-between; gap: 12px; }
  .mobile-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .contact-mobile-item .mobile-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mobile-actions :deep(.el-button) { width: 100%; margin-left: 0; }
}
</style>
