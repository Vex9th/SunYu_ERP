import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  App as AntApp,
  Breadcrumb,
  Button,
  ConfigProvider,
  Drawer,
  Menu,
  Result,
  Space,
} from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  ApartmentOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  LogoutOutlined,
  MenuOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import {
  requestJson,
  requestVoid,
  subscribeProtectedSessionExpired,
} from '../api'
import type { SessionState } from '../types'
import { AuthPage, Brand } from './AuthPage'
import { errorText, LoadingBlock } from './shared'
import styles from './Workspace.module.css'
import { WorkspaceNavigationProvider } from './navigationState'

const HomePage = lazy(() => import('./HomePage'))
const ProjectsPage = lazy(() => import('./ProjectsPage'))
const CompaniesPage = lazy(() => import('./CompaniesPage'))
const SettingsPage = lazy(() => import('./SettingsPage'))
const ProjectPage = lazy(() => import('./ProjectPage'))
const InventoryWorkspace = lazy(() => import('./inventory/InventoryWorkspace'))

const navigation = [
  { key: '/', label: '工作台', icon: <AppstoreOutlined /> },
  { key: '/projects', label: '项目中心', icon: <ApartmentOutlined /> },
  { key: '/companies', label: '公司与联系人', icon: <TeamOutlined /> },
  { key: '/inventory', label: '库存管理', icon: <DatabaseOutlined /> },
  { key: '/settings', label: '系统设置', icon: <SettingOutlined /> },
]

class ScreenBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  render() {
    return this.state.error ? (
      <Result
        status="error"
        title="页面暂时无法显示"
        subTitle={this.state.error}
        extra={
          <Button onClick={() => window.location.reload()}>重新加载页面</Button>
        }
      />
    ) : (
      this.props.children
    )
  }
}

export function Application() {
  const [session, setSession] = useState<SessionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const sessionEpoch = useRef(0)
  const { message } = AntApp.useApp()
  async function readSession() {
    setLoading(true)
    setError(null)
    const epoch = ++sessionEpoch.current
    try {
      const current = await requestJson<SessionState>('/api/auth/session')
      if (epoch === sessionEpoch.current) setSession(current)
    } catch (cause) {
      if (epoch === sessionEpoch.current) setError(errorText(cause))
    } finally {
      if (epoch === sessionEpoch.current) setLoading(false)
    }
  }
  useEffect(() => {
    void readSession()
    return () => {
      sessionEpoch.current += 1
    }
  }, [])
  useEffect(() => {
    if (!session?.authenticated) return
    return subscribeProtectedSessionExpired((event) => {
      sessionEpoch.current += 1
      setSession({ authenticated: false, password_configured: true })
      setError(event.message)
    })
  }, [session?.authenticated])
  async function authenticate(password: string) {
    if (busyRef.current || !session) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      if (!session.password_configured) {
        await requestVoid('/api/auth/setup', {
          method: 'POST',
          body: { password },
        })
        setSession({ authenticated: false, password_configured: true })
      }
      await requestVoid('/api/auth/login', {
        method: 'POST',
        body: { password },
      })
      setSession({ authenticated: true, password_configured: true })
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  async function logout() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await requestVoid('/api/auth/logout', { method: 'POST' })
      sessionEpoch.current += 1
      setSession({ authenticated: false, password_configured: true })
      setError(null)
    } catch (cause) {
      void message.error(errorText(cause))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  if (loading)
    return (
      <div className={styles.content}>
        <Brand />
        <LoadingBlock />
      </div>
    )
  if (!session)
    return (
      <Result
        status="warning"
        title="暂时无法连接本机服务"
        subTitle={error}
        extra={
          <Button type="primary" onClick={() => void readSession()}>
            重新连接
          </Button>
        }
      />
    )
  if (!session.authenticated)
    return (
      <AuthPage
        passwordConfigured={session.password_configured}
        busy={busy}
        error={error}
        onSubmit={authenticate}
      />
    )
  return <Shell busy={busy} logout={logout} />
}

function Shell({
  busy,
  logout,
}: {
  busy: boolean
  logout: () => Promise<void>
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [mobileNav, setMobileNav] = useState(false)
  const selected = `/${location.pathname.split('/')[1]}`
  const pageLabel =
    navigation.find((item) => item.key === selected)?.label ?? '工作台'
  const menu = (
    <Menu
      mode="inline"
      selectedKeys={[selected]}
      items={navigation}
      onClick={({ key }) => {
        navigate(key)
        setMobileNav(false)
      }}
    />
  )
  useEffect(() => {
    document.title = `${pageLabel} · SunYu ERP`
  }, [pageLabel])
  return (
    <div className={styles.app}>
      <aside className={styles.sidebar}>
        <Link to="/" aria-label="SunYu ERP 工作台">
          <Brand />
        </Link>
        <div className={styles.navLabel}>工作空间</div>
        {menu}
        <div className={styles.sidebarBottom}>
          <strong>SunYu 项目工作台</strong>把每个项目，管理得更清楚。
        </div>
      </aside>
      <Drawer
        open={mobileNav}
        onClose={() => setMobileNav(false)}
        placement="left"
        title="工作空间"
        size={260}
      >
        {menu}
      </Drawer>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <Space>
            <Button
              className={styles.mobileMenu}
              type="text"
              aria-label="打开导航"
              icon={<MenuOutlined />}
              onClick={() => setMobileNav(true)}
            />
            <Breadcrumb
              items={[
                { title: <Link to="/">工作空间</Link> },
                {
                  title: location.pathname.startsWith('/projects/') ? (
                    <Link to="/projects">项目中心</Link>
                  ) : (
                    pageLabel
                  ),
                },
                ...(location.pathname.startsWith('/projects/')
                  ? [{ title: '项目详情' }]
                  : []),
              ]}
            />
          </Space>
          <div className={styles.topbarRight}>
            <span className={styles.date}>
              {new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                weekday: 'long',
              }).format(new Date())}
            </span>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              loading={busy}
              onClick={() => void logout()}
            >
              退出
            </Button>
          </div>
        </header>
        <main className={styles.content} id="main-content">
          <WorkspaceNavigationProvider>
            <ScreenBoundary
              key={location.pathname.replace(/(\/documents)\/\d+$/, '$1')}
            >
              <Suspense fallback={<LoadingBlock />}>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/projects" element={<ProjectsPage />} />
                  <Route path="/companies" element={<CompaniesPage />} />
                  <Route path="/inventory" element={<InventoryWorkspace />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  {[
                    '/projects/:projectCode',
                    '/projects/:projectCode/stages',
                    '/projects/:projectCode/documents',
                    '/projects/:projectCode/documents/:documentId',
                    '/projects/:projectCode/commercial',
                    '/projects/:projectCode/procurement',
                    '/projects/:projectCode/workforce',
                    '/projects/:projectCode/delivery',
                  ].map((path) => (
                    <Route key={path} path={path} element={<ProjectPage />} />
                  ))}
                  <Route
                    path="*"
                    element={
                      <Result
                        status="404"
                        title="页面不存在"
                        subTitle="该地址可能已变更，请从项目中心重新进入。"
                        extra={
                          <Link to="/projects">
                            <Button type="primary">打开项目中心</Button>
                          </Link>
                        }
                      />
                    }
                  />
                </Routes>
              </Suspense>
            </ScreenBoundary>
          </WorkspaceNavigationProvider>
        </main>
      </div>
    </div>
  )
}

export default function RootApp() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          motion: false,
          colorPrimary: '#245bd2',
          colorInfo: '#245bd2',
          colorSuccess: '#278366',
          colorWarning: '#c18129',
          colorError: '#c34343',
          colorText: '#26354b',
          colorTextSecondary: '#596579',
          colorBgLayout: '#f4f6f9',
          colorBorder: '#e1e6ee',
          colorBorderSecondary: '#edf0f4',
          fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
          fontSize: 14,
          borderRadius: 6,
          controlHeight: 34,
          wireframe: false,
        },
        components: {
          Table: {
            headerBg: '#f8f9fc',
            headerColor: '#526177',
            cellPaddingBlock: 11,
          },
          Menu: {
            itemSelectedBg: '#edf2ff',
            itemSelectedColor: '#245bd2',
            itemBorderRadius: 6,
          },
          Tabs: { horizontalItemGutter: 28 },
          Button: { primaryShadow: 'none' },
        },
      }}
    >
      <AntApp>
        <BrowserRouter>
          <ScreenBoundary>
            <Application />
          </ScreenBoundary>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}
