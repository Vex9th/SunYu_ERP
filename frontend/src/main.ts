import 'element-plus/dist/index.css'
import ElementPlus from 'element-plus'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { createAppRouter } from './router'
import './styles/design-system.css'

const router = createAppRouter()

createApp(App)
  .use(createPinia())
  .use(router)
  .use(ElementPlus)
  .mount('#app')
