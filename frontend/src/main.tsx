import { createRoot } from 'react-dom/client'
import 'antd/dist/reset.css'
import RootApp from './react/App'

const container = document.getElementById('app')
if (!container) throw new Error('缺少应用挂载节点')
createRoot(container).render(<RootApp />)
