import 'element-plus/dist/index.css'
import {
  ElAlert,
  ElCard,
  ElContainer,
  ElDivider,
  ElMain,
  ElSpace,
  ElStep,
  ElSteps,
  ElTag,
  ElText,
} from 'element-plus'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'

import App from './App.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: App }],
})

createApp(App)
  .use(createPinia())
  .use(router)
  .use(ElAlert)
  .use(ElCard)
  .use(ElContainer)
  .use(ElDivider)
  .use(ElMain)
  .use(ElSpace)
  .use(ElStep)
  .use(ElSteps)
  .use(ElTag)
  .use(ElText)
  .mount('#app')
