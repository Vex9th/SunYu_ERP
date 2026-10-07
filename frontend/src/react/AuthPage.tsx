import { Button, Form, Input, Space } from 'antd'
import {
  ArrowRightOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
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

export function AuthPage({
  passwordConfigured,
  busy,
  error,
  onSubmit,
}: {
  passwordConfigured: boolean
  busy: boolean
  error: string | null
  onSubmit: (password: string) => unknown
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
          <h2>{passwordConfigured ? '回到你的工作台' : '开始管理你的项目'}</h2>
          <p>
            {passwordConfigured
              ? '输入本机访问密码，继续处理项目。'
              : '为当前主机设置一个 6 位数字访问密码。'}
          </p>
          <Space orientation="vertical" size={20} style={{ width: '100%' }}>
            <ErrorNotice error={error} />
            <Form
              key={String(passwordConfigured)}
              layout="vertical"
              onFinish={(values: { password: string }) =>
                void onSubmit(values.password)
              }
              disabled={busy}
              requiredMark={false}
            >
              <Form.Item
                name="password"
                label="访问密码"
                rules={[
                  { required: true, message: '请输入访问密码' },
                  { pattern: /^[0-9]{6}$/, message: '密码必须是 6 位数字' },
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder="输入 6 位数字"
                  autoComplete={
                    passwordConfigured ? 'current-password' : 'new-password'
                  }
                  inputMode="numeric"
                  maxLength={6}
                  size="large"
                  autoFocus
                />
              </Form.Item>
              {!passwordConfigured && (
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
                    placeholder="再次输入 6 位数字"
                    autoComplete="new-password"
                    inputMode="numeric"
                    maxLength={6}
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
                  passwordConfigured ? '进入工作台' : '创建密码并进入'
                }
                icon={<ArrowRightOutlined aria-hidden />}
                iconPlacement="end"
              >
                {passwordConfigured ? '进入工作台' : '创建密码并进入'}
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
