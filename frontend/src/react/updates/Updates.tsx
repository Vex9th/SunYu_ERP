import { Alert, Button, Collapse, Descriptions, Progress, Space, Switch, Tag, Typography, Upload } from 'antd'
import { CloudDownloadOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { RouterButton } from '../RouterButton'
import { LoadingBlock, Section } from '../shared'
import { isRunningJob, type InstallBlockReason, type UpdateComponent, type UpdateJobStatus } from './types'
import { useUpdates } from './UpdateProvider'
import { isNewerVersion } from './version'
export { UpdatesProvider } from './UpdateProvider'

const statusNames: Record<UpdateJobStatus, string> = {
  checking: '正在检查', downloading: '正在下载', verifying: '正在校验', backing_up: '正在备份',
  installing: '正在安装', restarting: '正在重启', cleaning: '正在清理',
  success: '已完成', failed: '更新失败', manual_recovery: '需要恢复',
}
const installBlockMessages: Record<InstallBlockReason, { title: string; description: string }> = {
  unsupported_runtime: { title: '当前运行方式不支持更新', description: '请通过完整安装目录中的 SunYu_ERP.exe 启动。' },
  not_supervised: { title: '当前服务未通过正式启动器运行', description: '请先保存工作，再通过完整安装目录中的 SunYu_ERP.exe 启动服务后重试。' },
  client_unavailable: { title: '暂时无法确认此连接是否来自本机', description: '请在运行服务的电脑上直接访问 127.0.0.1，并检查本机代理设置。' },
  non_loopback_peer: { title: '当前连接未被识别为本机连接', description: '请在运行服务的电脑上使用 127.0.0.1 直接访问，并检查代理是否接管本机请求。' },
  non_loopback_host: { title: '当前访问地址不是本机地址', description: '请在运行服务的电脑上使用 127.0.0.1 或 localhost 访问后重试。' },
}
const unknownInstallBlock = { title: '此连接暂不允许修改更新', description: '请在运行服务的本机，通过完整安装目录中的 SunYu_ERP.exe 启动，并使用 127.0.0.1 或 localhost 访问。' }
const components: readonly UpdateComponent[] = ['application', 'frontend', 'backend']

export function UpdateNotice() {
  const updates = useUpdates()
  if (!updates?.state?.supported) return null
  const { state, pageVersion } = updates
  const frontendChanged = pageVersion !== 'dev' && Boolean(state.frontend_version) && state.frontend_version !== pageVersion
  const version = frontendChanged ? state.frontend_version : state.latest?.version
  const available = components.some(component => isNewerVersion(state.latest?.components[component]?.version, state.current[component]))
  const show = frontendChanged || (available && state.preferences.auto_check && state.preferences.ignored_version !== version)
  const noticeKey = `${frontendChanged ? 'frontend' : 'release'}:${version}`
  if (!show || !version || updates.dismissed === noticeKey) return null
  return <div style={{ marginBottom: 16 }}>
    <Alert showIcon type="info" title={frontendChanged ? `新前端 ${version} 已就绪` : `发现可选更新 ${version}`}
      description={frontendChanged ? '当前页面继续可用，保存工作后可刷新使用新版本。' : '可在系统设置中一键更新，也可继续使用当前版本。'}
      action={<Space wrap>
        {frontendChanged
          ? <Button size="small" disabled={updates.uncertain || isRunningJob(state.job)} icon={<ReloadOutlined aria-hidden />} onClick={updates.refreshPage}>刷新使用新版本</Button>
          : <RouterButton size="small" to="/settings">查看更新</RouterButton>}
        <Button size="small" type="text" onClick={() => updates.dismiss(noticeKey)}>稍后</Button>
      </Space>} />
    {updates.refreshError && <Alert type="warning" showIcon title={updates.refreshError} style={{ marginTop: 8 }} />}
  </div>
}

export function UpdatesSection() {
  const updates = useUpdates()
  if (!updates) return null
  const { state } = updates
  const available = state && components.some(component => isNewerVersion(state.latest?.components[component]?.version, state.current[component]))
  const installBlock = state?.install_block_reason ? installBlockMessages[state.install_block_reason] ?? unknownInstallBlock : unknownInstallBlock
  const showDeferredRefresh = state?.frontend_version && updates.pageVersion !== 'dev' && state.frontend_version !== updates.pageVersion && updates.dismissed === `frontend:${state.frontend_version}`
  const running = isRunningJob(state?.job)
  const blocked = updates.busy || updates.uncertain || running || state?.job?.status === 'manual_recovery' || Boolean(updates.connectionError)
  const job = state?.job
  const progress = typeof job?.progress === 'number' && Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : undefined
  return <Section title="版本与更新" description="自动检查只提醒。由你决定何时更新。">
    {updates.loading && !state && <LoadingBlock />}
    {updates.connectionError && <Alert type="warning" showIcon title="暂时无法读取更新状态，正在恢复连接"
      description="重启时连接会短暂中断，恢复后自动核对任务结果，请勿重复更新。"
      action={<Button size="small" onClick={() => void updates.read()}>重新查询</Button>} style={{ marginBottom: 12 }} />}
    {updates.actionError && <Alert type="warning" showIcon title={updates.actionError} style={{ marginBottom: 12 }} />}
    {state && <Space vertical size={16} style={{ width: '100%' }}>
      <Descriptions size="small" column={{ xs: 1, sm: 3 }} items={[
        { key: 'backend', label: '服务版本', children: state.current.backend ?? '开发版本' },
        { key: 'frontend', label: '已安装前端', children: state.current.frontend ?? '开发版本' },
        { key: 'page', label: '当前页面', children: updates.pageVersion === 'dev' ? '开发版本' : updates.pageVersion },
      ]} />
      {!state.supported ? <Typography.Text type="secondary">当前为开发运行环境，更新在通过启动器运行的正式目录包中可用。</Typography.Text> : <>
        {!state.can_install && <Alert type="info" showIcon title={installBlock.title} description={`${installBlock.description} 此连接仍可查看状态和检查更新。`} />}
        <Space wrap size={12}>
          {state.can_install && <Button type="primary" aria-label="一键更新" icon={<CloudDownloadOutlined aria-hidden />} loading={updates.busy || running} disabled={blocked} onClick={() => void updates.update()}>一键更新</Button>}
          <Button icon={<ReloadOutlined aria-hidden />} disabled={blocked} onClick={() => void updates.check()}>检查更新</Button>
          <Typography.Text type="secondary">自动下载、校验、备份并安装；服务更新时会短暂重启。</Typography.Text>
        </Space>
        {job && <div role="status" aria-live="polite">
          <Alert showIcon type={job.status === 'failed' || job.status === 'manual_recovery' ? 'error' : job.status === 'success' ? 'success' : 'info'}
            title={<Space wrap><span>{job.message || statusNames[job.status]}</span><Tag>{statusNames[job.status]}</Tag></Space>}
            description={job.error || job.status === 'manual_recovery' ? <Space vertical>
              {job.error && <Typography.Text style={{ overflowWrap: 'anywhere' }}>{job.error}</Typography.Text>}
              {job.status === 'manual_recovery' && <Typography.Text>已停止安装，请保留更新日志和备份，在服务主机上运行升级助手恢复。</Typography.Text>}
            </Space> : undefined} />
          {running && progress !== undefined && <Progress percent={progress} size="small" status="active" style={{ marginTop: 8 }} />}
        </div>}
        {showDeferredRefresh && <>
          <Space wrap><Typography.Text>新前端 {state.frontend_version} 已就绪，保存工作后可刷新。</Typography.Text><Button disabled={blocked} icon={<ReloadOutlined aria-hidden />} onClick={updates.refreshPage}>刷新使用新版本</Button></Space>
          {updates.refreshError && <Alert type="warning" showIcon title={updates.refreshError} />}
        </>}
        {state.latest ? <div>
          <Space wrap style={{ marginBottom: 8 }}><Typography.Text strong>{available ? '可用版本' : '发布版本'} {state.latest.version}</Typography.Text>
            {available && state.preferences.ignored_version === state.latest.version && <Tag>已忽略提醒</Tag>}
            {available && state.can_install && <Button size="small" type="link" disabled={blocked} onClick={() => void updates.preferences({ ignored_version: state.preferences.ignored_version === state.latest!.version ? null : state.latest!.version })}>
              {state.preferences.ignored_version === state.latest.version ? '恢复此版本提醒' : '忽略此版本'}
            </Button>}
          </Space>
          {!available && <Typography.Paragraph type="secondary">线上暂无比当前已安装组件更高的版本。</Typography.Paragraph>}
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto', marginBottom: 0 }}>{state.latest.notes || '此版本未提供更新说明。'}</Typography.Paragraph>
        </div> : <Typography.Text type="secondary">一键更新会先检查最新版本，无需提前下载更新包。</Typography.Text>}
        {state.can_install && <>
          <Space wrap><Switch aria-label="自动检查更新" checked={state.preferences.auto_check} disabled={blocked} onChange={auto_check => void updates.preferences({ auto_check })} /><Typography.Text>自动检查更新并提醒</Typography.Text><Typography.Text type="secondary">每 6 小时检查一次</Typography.Text></Space>
          <Collapse ghost items={[{ key: 'offline', label: '无法在线更新时', children: <Space vertical>
            <Typography.Text type="secondary">选择官方 ZIP 更新包后自动校验并安装。完全离线时，需先在本机成功检查过对应版本，以取得官方校验信息。</Typography.Text>
            <Upload accept=".zip" showUploadList={false} disabled={blocked} beforeUpload={file => { void updates.importPackage(file); return false }}>
              <Button icon={<UploadOutlined aria-hidden />} disabled={blocked}>选择离线包并更新</Button>
            </Upload>
          </Space> }]} />
        </>}
      </>}
    </Space>}
  </Section>
}
