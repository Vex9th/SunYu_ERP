import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router'

import App from './App.vue'
import NotFoundPage from './components/NotFoundPage.vue'

export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({
    history,
    routes: [
      { path: '/', name: 'home', component: App },
      { path: '/projects', name: 'projects', component: App },
      { path: '/companies', name: 'companies', component: App },
      { path: '/inventory', name: 'inventory', component: App },
      { path: '/settings', name: 'settings', component: App },
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
      {
        path: '/projects/:projectCode/commercial',
        name: 'project-commercial',
        component: App,
      },
      {
        path: '/projects/:projectCode/procurement',
        name: 'project-procurement',
        component: App,
      },
      {
        path: '/projects/:projectCode/workforce',
        name: 'project-workforce',
        component: App,
      },
      {
        path: '/projects/:projectCode/delivery',
        name: 'project-delivery',
        component: App,
      },
      {
        path: '/:pathMatch(.*)*',
        name: 'not-found',
        component: NotFoundPage,
      },
    ],
  })
}
