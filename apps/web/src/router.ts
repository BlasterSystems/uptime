import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { authState, bootstrapAuth, isAuthenticated } from './auth.js'
import AppLayout from './layouts/AppLayout.vue'
import DashboardView from './views/DashboardView.vue'
import DocsView from './views/DocsView.vue'
import IncidentsView from './views/IncidentsView.vue'
import LoginView from './views/LoginView.vue'
import MonitorDetailView from './views/MonitorDetailView.vue'
import NotificationsView from './views/NotificationsView.vue'
import PublicStatusView from './views/PublicStatusView.vue'
import RequestResetView from './views/RequestResetView.vue'
import ResetPasswordView from './views/ResetPasswordView.vue'
import SettingsView from './views/SettingsView.vue'
import SetupView from './views/SetupView.vue'
import StatusPageIncidentsView from './views/StatusPageIncidentsView.vue'
import StatusPageView from './views/StatusPageView.vue'

declare module 'vue-router' {
  interface RouteMeta {
    /** Topbar heading; also used as the document title. */
    title?: string
    /** Reachable while signed out (login and first-run setup). */
    public?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: AppLayout,
    children: [
      {
        path: '',
        name: 'dashboard',
        component: DashboardView,
        meta: { title: 'Dashboard' },
      },
      {
        path: 'monitors/:id',
        name: 'monitor-detail',
        component: MonitorDetailView,
        meta: { title: 'Monitor' },
      },
      {
        path: 'incidents',
        name: 'incidents',
        component: IncidentsView,
        meta: { title: 'Incidents' },
      },
      {
        path: 'notifications',
        name: 'notifications',
        component: NotificationsView,
        meta: { title: 'Notifications' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: SettingsView,
        meta: { title: 'Settings' },
      },
      {
        path: 'docs',
        name: 'docs',
        component: DocsView,
        meta: { title: 'Integration Docs' },
      },
    ],
  },
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { title: 'Sign in', public: true },
  },
  {
    path: '/forgot-password',
    name: 'forgot-password',
    component: RequestResetView,
    meta: { title: 'Reset your password', public: true },
  },
  {
    path: '/reset-password',
    name: 'reset-password',
    component: ResetPasswordView,
    meta: { title: 'Choose a new password', public: true },
  },
  {
    path: '/status',
    name: 'public-status',
    component: PublicStatusView,
    meta: { title: 'Status', public: true },
  },
  {
    path: '/status/:slug',
    name: 'status-page',
    component: StatusPageView,
    meta: { title: 'Status', public: true },
  },
  {
    path: '/status/:slug/incidents',
    name: 'status-incidents',
    component: StatusPageIncidentsView,
    meta: { title: 'Incident history', public: true },
  },
  {
    path: '/setup',
    name: 'setup',
    component: SetupView,
    meta: { title: 'Set up', public: true },
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'dashboard' } },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  if (!authState.ready) await bootstrapAuth()

  if (authState.setupRequired) {
    return to.name === 'setup' ||
      to.name === 'status-page' ||
      to.name === 'status-incidents' ||
      to.name === 'public-status'
      ? true
      : { name: 'setup' }
  }

  if (to.name === 'setup') {
    return isAuthenticated.value ? { name: 'dashboard' } : { name: 'login' }
  }

  if (to.meta.public === true) {
    return isAuthenticated.value && to.name === 'login' ? { name: 'dashboard' } : true
  }

  if (!isAuthenticated.value) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  return true
})

router.afterEach((to) => {
  const title = to.meta.title
  document.title = title === undefined ? 'Uptime Monitoring' : `${title} · Uptime Monitoring`
})
