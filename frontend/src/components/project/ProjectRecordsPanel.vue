<script setup lang="ts">
import type { ProjectDashboardData } from '../../types'

defineProps<{
  data: ProjectDashboardData
}>()

function statusLabel(status: ProjectDashboardData['project']['status']): string {
  return status === 'active' ? '在建' : '已归档'
}
</script>

<template>
  <el-space
    data-testid="project-records-panel"
    class="project-panel-stack"
    direction="vertical"
    alignment="stretch"
    fill
    :size="20"
  >
    <el-card class="data-card" shadow="never">
      <template #header><el-text tag="strong">项目资料</el-text></template>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="项目编号">{{ data.project.project_code }}</el-descriptions-item>
        <el-descriptions-item label="状态"><el-tag :type="data.project.status === 'active' ? 'success' : 'info'">{{ statusLabel(data.project.status) }}</el-tag></el-descriptions-item>
        <el-descriptions-item label="项目名称">{{ data.project.name }}</el-descriptions-item>
        <el-descriptions-item label="客户">{{ data.company.name }}</el-descriptions-item>
        <el-descriptions-item label="项目说明" :span="2">{{ data.project.description ?? '未录入' }}</el-descriptions-item>
        <el-descriptions-item label="归档原因">{{ data.project.archive_reason ?? '未归档' }}</el-descriptions-item>
        <el-descriptions-item label="归档时间">{{ data.project.archived_at ?? '未归档' }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card class="data-card" shadow="never">
      <template #header><el-text tag="strong">客户开票资料</el-text></template>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="公司名称" :span="2">{{ data.company.name }}</el-descriptions-item>
        <el-descriptions-item label="税号">{{ data.company.taxpayer_id ?? '未录入' }}</el-descriptions-item>
        <el-descriptions-item label="注册电话">{{ data.company.registered_phone ?? '未录入' }}</el-descriptions-item>
        <el-descriptions-item label="注册地址" :span="2">{{ data.company.registered_address ?? '未录入' }}</el-descriptions-item>
        <el-descriptions-item label="开户行">{{ data.company.bank_name ?? '未录入' }}</el-descriptions-item>
        <el-descriptions-item label="银行账号">{{ data.company.bank_account ?? '未录入' }}</el-descriptions-item>
        <el-descriptions-item label="备注" :span="2">{{ data.company.notes ?? '无' }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card class="data-card" shadow="never">
      <template #header><el-text tag="strong">客户联系人</el-text></template>
      <el-empty v-if="data.contacts.length === 0" data-testid="contacts-empty" description="暂无联系人" />
      <el-table v-else :data="data.contacts" row-key="id">
        <el-table-column prop="name" label="姓名" />
        <el-table-column prop="position" label="职务"><template #default="scope">{{ scope.row.position ?? '未录入' }}</template></el-table-column>
        <el-table-column prop="phone" label="电话"><template #default="scope">{{ scope.row.phone ?? '未录入' }}</template></el-table-column>
        <el-table-column prop="email" label="邮箱"><template #default="scope">{{ scope.row.email ?? '未录入' }}</template></el-table-column>
      </el-table>
    </el-card>
  </el-space>
</template>
