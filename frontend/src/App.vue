<template>
  <el-container>
    <el-main>
      <el-card data-testid="development-status" shadow="never">
        <template #header>
          <el-space direction="vertical" alignment="start" :size="8">
            <el-tag effect="plain">SunYu ERP</el-tag>
            <el-text tag="h1" size="large">开发环境已就绪</el-text>
          </el-space>
        </template>

        <el-alert
          title="工程基座运行中"
          description="当前页面仅用于确认 Vue 3 与 Element Plus 开发入口，业务功能将在后续阶段接入。"
          type="success"
          show-icon
          :closable="false"
        />

        <el-divider />

        <el-steps :active="1" align-center>
          <el-step title="开发入口" description="已建立" />
          <el-step title="业务模块" description="开发中" />
          <el-step title="交付验证" description="待接入" />
        </el-steps>
      </el-card>
    </el-main>
  </el-container>
</template>
