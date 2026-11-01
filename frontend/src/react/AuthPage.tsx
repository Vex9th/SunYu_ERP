import { Button, Form, Input, Space } from 'antd'
import {
  ArrowRightOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { ErrorNotice } from './shared'
import styles from './Workspace.module.css'

export function Brand() {
  return (
    <div className={styles.brand}>
      <span className={styles.brandMark}>SY</span>
      <div>
        <span className={styles.brandName}>SunYu ERP</span>
        <span className={styles.brandCaption}>工业项目管理</span>
      </div>
    </div>
  )
}

export interface AuthCredentials { username: string; password: string; display_name?: string; legacy_password?: string }

export function AuthPage({
  passwordConfigured,
  bootstrapRequired = !passwordConfigured,
  busy,
  error,
  onSubmit,
}: {
  passwordConfigured: boolean
  bootstrapRequired?: boolean
  busy: boolean
  error: string | null
  onSubmit: (credentials: AuthCredentials) => unknown
}) {
  return (
    <main className={styles.auth}>
      <section className={styles.authStory}>
        <Brand />
        <div className={styles.authEditorial}>
          <div className={styles.eyebrow}>PROJECTS, IN ORDER.</div>
          <h1>
            每一个项目，
            <br />
            都有清晰的下一步。
          </h1>
          <div className={styles.authLine} />
          <p>
            连接资料、采购、施工与交付，
            <br />
            把项目进度与每一笔收支，放在同一个工作台。
          </p>
          <div className={styles.authStages}>
            <span>规划</span>
            <ArrowRightOutlined />
            <span>采购</span>
            <ArrowRightOutlined />
            <span>施工</span>
            <ArrowRightOutlined />
            <span>交付</span>
          </div>
        </div>
        <footer className={styles.authFooter}>
          SUNYU · INDUSTRIAL PROJECT MANAGEMENT
        </footer>
      </section>
      <section className={styles.authFormSide}>
        <div className={styles.authForm}>
          <div className={styles.eyebrow}>欢迎使用 SUNYU</div>
          <h2>{bootstrapRequired ? '创建本机主账号' : '回到你的工作台'}</h2>
          <p>
            {bootstrapRequired ? (passwordConfigured ? '本机需要升级为独立账号登录。请验证原共享密码，创建主账号；原有业务资料会保留。' : '首次使用请在服务本机创建主账号，之后可为同事分配工作组和权限。') : '输入登录名和账号密码，继续处理获准项目。'}
          </p>
          <Space orientation="vertical" size={20} style={{ width: '100%' }}>
            <ErrorNotice error={error} />
            <Form
              key={String(bootstrapRequired)}
              layout="vertical"
              onFinish={(values: AuthCredentials & { confirm?: string }) => { const { confirm: _confirm, ...credentials } = values; void onSubmit(credentials) }}
              disabled={busy}
              requiredMark={false}
            >
              <Form.Item name="username" label="登录名" rules={[{ required: true, whitespace: true, message: '请输入登录名' }]}><Input prefix={<UserOutlined />} autoComplete="username" size="large" maxLength={64} autoFocus /></Form.Item>
              {bootstrapRequired && <Form.Item name="display_name" label="备注名" rules={[{ required: true, whitespace: true, message: '请输入备注名' }]}><Input maxLength={100} size="large" /></Form.Item>}
              {bootstrapRequired && passwordConfigured && <Form.Item name="legacy_password" label="原共享密码" rules={[{ required: true, message: '请输入原共享密码' }]}><Input.Password autoComplete="off" inputMode="numeric" maxLength={6} size="large" /></Form.Item>}
              <Form.Item
                name="password"
                label="账号密码"
                rules={[
                  { required: true, message: '请输入账号密码' },
                  ...(bootstrapRequired ? [{ min: 8, max: 128, message: '密码为 8～128 个字符' }] : []),
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder="输入账号密码"
                  autoComplete={
                    bootstrapRequired ? 'new-password' : 'current-password'
                  }
                  maxLength={128}
                  size="large"
                />
              </Form.Item>
              {bootstrapRequired && (
                <Form.Item
                  name="confirm"
                  label="再次输入密码"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: '请再次输入密码' },
                    ({ getFieldValue }) => ({
                      validator: (_, value: string) =>
                        value === getFieldValue('password')
                          ? Promise.resolve()
                          : Promise.reject(new Error('两次输入的密码不一致')),
                    }),
                  ]}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    placeholder="再次输入账号密码"
                    autoComplete="new-password"
                    maxLength={128}
                    size="large"
                  />
                </Form.Item>
              )}
              <Button
                block
                type="primary"
                htmlType="submit"
                size="large"
                loading={busy}
                aria-label={
                  bootstrapRequired ? '创建主账号并进入' : '进入工作台'
                }
                icon={<ArrowRightOutlined aria-hidden />}
                iconPlacement="end"
              >
                {bootstrapRequired ? '创建主账号并进入' : '进入工作台'}
              </Button>
            </Form>
          </Space>
          <div className={styles.authPrivacy}>
            <SafetyCertificateOutlined /> 数据保存在当前主机
          </div>
        </div>
      </section>
    </main>
  )
}
