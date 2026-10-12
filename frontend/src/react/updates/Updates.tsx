import { Alert, App, Button, Descriptions, Space, Switch, Tag, Typography, Upload } from 'antd'
import { CloudDownloadOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { RouterButton } from '../RouterButton'
import { LoadingBlock, Section } from '../shared'
import { isRunningJob, type UpdateComponent, type UpdateJobStatus } from './types'
import { useUpdates } from './UpdateProvider'
export { UpdatesProvider } from './UpdateProvider'

const componentNames: Record<UpdateComponent, string> = { frontend: '前端', backend: '后端' }
const statusNames: Record<UpdateJobStatus, string> = {
  checking: '正在检查', downloading: '正在下载', ready: '已校验，待安装', installing: '正在安装',
  success: '更新已完成', failed: '更新失败', manual_recovery: '需要人工处理',
}

export function UpdateNotice() {
  const updates = useUpdates()
  if (!updates?.state?.supported) return null
  const { state, pageVersion } = updates
  const frontendChanged = pageVersion !== 'dev' && Boolean(state.frontend_version) && state.frontend_version !== pageVersion
  const version = frontendChanged ? state.frontend_version : state.latest?.version
  const available = state.latest && Object.entries(state.latest.components).some(([key, value]) => value && value.version !== state.current[key as UpdateComponent])
  const show = frontendChanged || (available && state.preferences.auto_check && state.preferences.ignored_version !== version)
  const noticeKey = `${frontendChanged ? 'frontend' : 'release'}:${version}`
  if (!show || !version || updates.dismissed === noticeKey) return null
  return <div style={{ marginBottom: 16 }}>
    <Alert showIcon type="info" title={frontendChanged ? `新前端 ${version} 已就绪` : `发现可选更新 ${version}`}
      description={frontendChanged ? '当前页面继续可用，保存工作后可刷新使用新版本。' : '可在系统设置查看详情，自行选择下载和安装。'}
      action={<Space wrap>
        {frontendChanged
          ? <Button size="small" disabled={updates.uncertain} icon={<ReloadOutlined aria-hidden />} onClick={updates.refreshPage}>刷新使用新版本</Button>
          : <RouterButton size="small" to="/settings">查看更新</RouterButton>}
        <Button size="small" type="text" onClick={() => updates.dismiss(noticeKey)}>稍后</Button>
      </Space>} />
    {updates.refreshError && <Alert type="warning" showIcon title={updates.refreshError} style={{ marginTop: 8 }} />}
  </div>
}

export function UpdatesSection() {
  const updates = useUpdates()
  const { modal } = App.useApp()
  if (!updates) return null
  const { state } = updates
  const showDeferredRefresh = state?.frontend_version && updates.pageVersion !== 'dev' && state.frontend_version !== updates.pageVersion && updates.dismissed === `frontend:${state.frontend_version}`
  const blocked = updates.busy || updates.uncertain || isRunningJob(state?.job) || state?.job?.status === 'manual_recovery' || Boolean(updates.connectionError)
  function confirmInstall(component: UpdateComponent) {
    modal.confirm({
      title: `安装${componentNames[component]}更新？`,
      content: component === 'backend' ? '后端将短暂重启。请先完成正在进行的业务操作，安装期间暂时无法提交新数据。页面会继续查询任务结果。' : '安装后当前页面保持不变，保存工作后再点击刷新使用新版本。',
      okText: '确认安装', cancelText: '暂不安装',
      onOk: () => updates?.install(component),
    })
  }
  return <Section title="版本与更新" description="检查更新不会自动下载或安装，可继续使用当前版本。"
    extra={state?.supported && <Button icon={<ReloadOutlined aria-hidden />} loading={updates.busy || state.job?.status === 'checking'} disabled={blocked || state.job?.status === 'ready'} onClick={() => void updates.check()}>检查更新</Button>}>
    {updates.loading && !state && <LoadingBlock />}
    {updates.connectionError && <Alert type="warning" showIcon title="暂时无法读取更新状态，正在恢复连接"
      description="连接中断不代表安装失败或成功，恢复后会继续核对后台任务。"
      action={<Button size="small" onClick={() => void updates.read()}>重新查询</Button>} style={{ marginBottom: 12 }} />}
    {updates.actionError && <Alert type="warning" showIcon title={updates.actionError} style={{ marginBottom: 12 }} />}
    {state && <>
      <Descriptions size="small" column={{ xs: 1, sm: 3 }} items={[
        { key: 'backend', label: '后端版本', children: state.current.backend ?? '开发版本' },
        { key: 'frontend', label: '已安装前端', children: state.current.frontend ?? '开发版本' },
        { key: 'page', label: '当前页面', children: updates.pageVersion === 'dev' ? '开发版本' : updates.pageVersion },
      ]} />
      {!state.supported ? <Typography.Text type="secondary">当前为开发运行环境，模块更新在通过启动器运行的正式目录包中可用。</Typography.Text> : <Space vertical size={16} style={{ width: '100%' }}>
        {showDeferredRefresh && <>
          <Space wrap><Typography.Text>新前端 {state.frontend_version} 已就绪，保存工作后可刷新。</Typography.Text><Button disabled={updates.uncertain} icon={<ReloadOutlined aria-hidden />} onClick={updates.refreshPage}>刷新使用新版本</Button></Space>
          {updates.refreshError && <Alert type="warning" showIcon title={updates.refreshError} />}
        </>}
        {!state.can_install && <Alert type="info" showIcon title="请在运行服务的本机登录后下载、安装或导入更新。此连接可查看状态和检查更新。" />}
        {state.job && <Alert showIcon type={state.job.status === 'failed' || state.job.status === 'manual_recovery' ? 'error' : state.job.status === 'success' ? 'success' : 'info'}
          title={<Space wrap><span>{state.job.message || statusNames[state.job.status]}</span><Tag>{statusNames[state.job.status]}</Tag></Space>}
          description={state.job.status === 'manual_recovery' ? '已停止自动安装。请保留更新日志与备份，在服务主机上检查并恢复。' : state.job.component && `${componentNames[state.job.component]} ${state.job.version ?? ''}`} />}
        {state.job?.status === 'ready' && <Typography.Text type="secondary">已有校验通过的更新包，请先安装当前更新包或重新选择更新包；暂不检查其他更新。</Typography.Text>}
        {state.latest ? <div>
          <Space wrap style={{ marginBottom: 8 }}><Typography.Text strong>可用版本 {state.latest.version}</Typography.Text>
            {state.preferences.ignored_version === state.latest.version && <Tag>已忽略提醒</Tag>}
            {state.can_install && <Button size="small" type="link" disabled={blocked} onClick={() => void updates.preferences({ ignored_version: state.preferences.ignored_version === state.latest!.version ? null : state.latest!.version })}>
              {state.preferences.ignored_version === state.latest.version ? '恢复此版本提醒' : '忽略此版本'}
            </Button>}
          </Space>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto' }}>{state.latest.notes || '此版本未提供更新说明。'}</Typography.Paragraph>
          {state.can_install && <Space wrap>{(['frontend', 'backend'] as const).map(component => {
            const candidate = state.latest!.components[component]
            if (!candidate || candidate.version === state.current[component]) return null
            const ready = state.job?.status === 'ready' && state.job.component === component && state.job.version === candidate.version
            return <Button key={component} disabled={blocked} icon={ready ? undefined : <CloudDownloadOutlined aria-hidden />} onClick={() => ready ? confirmInstall(component) : void updates.download(component)}>
              {ready ? '安装' : '下载'}{componentNames[component]}
            </Button>
          })}</Space>}
        </div> : state.job?.status !== 'ready' && <Typography.Text type="secondary">尚无可用更新信息，可点击检查更新。</Typography.Text>}
        {state.can_install && state.job?.status === 'ready' && state.job.component && state.latest?.components[state.job.component]?.version !== state.job.version &&
          <Button disabled={blocked} onClick={() => confirmInstall(state.job!.component!)}>安装{componentNames[state.job.component]}</Button>}
        {state.can_install && <>
          <Space wrap><Switch aria-label="自动检查更新" checked={state.preferences.auto_check} disabled={blocked} onChange={auto_check => void updates.preferences({ auto_check })} /><Typography.Text>自动检查更新并提醒</Typography.Text><Typography.Text type="secondary">每 6 小时检查一次</Typography.Text></Space>
          <Space wrap>
            <Upload accept=".zip" showUploadList={false} disabled={blocked} beforeUpload={file => { void updates.importPackage(file); return false }}>
              <Button icon={<UploadOutlined aria-hidden />} disabled={blocked}>导入离线更新包</Button>
            </Upload><Typography.Text type="secondary">仅选择可信发布的 ZIP 更新包，导入校验后再安装。</Typography.Text>
          </Space>
        </>}
      </Space>}
    </>}
  </Section>
}
