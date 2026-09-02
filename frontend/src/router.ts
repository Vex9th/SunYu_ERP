import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router'

import App from './App.vue'

export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({
    history,
    routes: [
      { path: '/', name: 'home', component: App },
      { path: '/projects/:projectCode', name: 'project', component: App },
      {
        path: '/projects/:projectCode/documents',
        name: 'project-documents',
        component: App,
      },
      {
        path: '/projects/:projectCode/documents/:documentId',
        name: 'project-document',
        component: App,
      },
    ],
  })
}
