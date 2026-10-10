<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useAuth } from '../auth.js'
import Icon from '../components/ui/Icon.vue'
import { useToast } from '../components/ui/toast.js'
import { useTheme } from '../theme.js'

const route = useRoute()
const router = useRouter()
const { state, signOut } = useAuth()
const { theme, toggleTheme } = useTheme()
const toast = useToast()

const NAV_ITEMS = [
  { name: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { name: 'incidents', label: 'Incidents', icon: 'incidents' },
  { name: 'notifications', label: 'Notifications', icon: 'notifications' },
  { name: 'settings', label: 'Settings', icon: 'settings' },
] as const

const COLLAPSE_KEY = 'uptime-sidebar-collapsed'

const collapsed = ref(readCollapsed())
const mobileOpen = ref(false)
const menuOpen = ref(false)
const signingOut = ref(false)
const menuRef = ref<HTMLElement | null>(null)

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
  try {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0')
  } catch {
    // Best effort only; the layout still collapses for this session.
  }
}

function onDocumentClick(event: MouseEvent): void {
  if (!menuOpen.value || menuRef.value === null) return
  if (event.target instanceof Node && !menuRef.value.contains(event.target)) menuOpen.value = false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  menuOpen.value = false
  mobileOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKeydown)
})

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
    menuOpen.value = false
  },
)

const pageTitle = computed(() => route.meta.title ?? 'Uptime Monitoring')
const initials = computed(() => (state.user?.email ?? '?').slice(0, 2).toUpperCase())

async function handleSignOut(): Promise<void> {
  signingOut.value = true
  try {
    await signOut()
    toast.success('Signed out')
    await router.push({ name: 'login' })
  } catch {
    toast.error('Could not sign out', 'The session may already be closed.')
  } finally {
    signingOut.value = false
  }
}
</script>

<template>
  <div class="shell" :class="{ 'is-collapsed': collapsed }">
    <aside class="sidebar" :class="{ 'is-open': mobileOpen }">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">U</span>
        <span class="brand-name">Uptime</span>
      </div>

      <nav class="nav" aria-label="Primary">
        <RouterLink
          v-for="item in NAV_ITEMS"
          :key="item.name"
          class="nav-item"
          :to="{ name: item.name }"
          :title="collapsed ? item.label : undefined"
        >
          <Icon :name="item.icon" :size="18" />
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <button
        type="button"
        class="collapse-button"
        :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <span class="collapse-icon" aria-hidden="true">
          <Icon name="chevron-left" :size="16" />
        </span>
        <span class="nav-label">Collapse</span>
      </button>
    </aside>

    <div v-if="mobileOpen" class="scrim" @click="mobileOpen = false" />

    <div class="main">
      <header class="topbar">
        <button
          type="button"
          class="icon-button menu-button"
          aria-label="Toggle navigation"
          @click="mobileOpen = !mobileOpen"
        >
          <Icon name="menu" />
        </button>

        <h1 class="page-title">{{ pageTitle }}</h1>

        <div class="topbar-actions">
          <button
            type="button"
            class="icon-button"
            :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
            @click="toggleTheme()"
          >
            <Icon :name="theme === 'dark' ? 'sun' : 'moon'" />
          </button>

          <div ref="menuRef" class="user-menu">
            <button
              type="button"
              class="user-button"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              @click="menuOpen = !menuOpen"
            >
              <span class="user-avatar" aria-hidden="true">{{ initials }}</span>
              <span class="user-email">{{ state.user?.email }}</span>
            </button>

            <div v-if="menuOpen" class="menu" role="menu">
              <div class="menu-header">
                <p class="menu-email">{{ state.user?.email }}</p>
                <p class="menu-role">{{ state.user?.role }}</p>
              </div>
              <RouterLink class="menu-item" role="menuitem" :to="{ name: 'settings' }">
                Account settings
              </RouterLink>
              <button
                type="button"
                class="menu-item is-danger"
                role="menuitem"
                :disabled="signingOut"
                @click="handleSignOut"
              >
                {{ signingOut ? 'Signing out…' : 'Sign out' }}
              </button>
            </div>
          </div>
        </div>
      </header>

      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
  background-color: var(--bg);
}

/* Sidebar */

.sidebar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: var(--sidebar-width);
  height: 100vh;
  padding: var(--space-4) var(--space-3);
  background-color: var(--surface);
  border-right: 1px solid var(--border);
  transition: width 160ms ease;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2) var(--space-5);
  overflow: hidden;
}

.brand-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  background-color: var(--accent);
  border-radius: 9px;
  color: var(--accent-fg);
  font-size: 14px;
  font-weight: 700;
}

.brand-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 13.5px;
  font-weight: 550;
  white-space: nowrap;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

.nav-item:hover {
  background-color: var(--surface-hover);
  color: var(--fg);
  text-decoration: none;
}

.nav-item.router-link-exact-active {
  background-color: var(--accent-soft);
  color: var(--accent);
}

.nav-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.collapse-button {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: auto;
  padding: 8px 10px;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
}

.collapse-button:hover {
  background-color: var(--surface-hover);
  color: var(--fg);
}

.collapse-icon {
  display: flex;
  flex-shrink: 0;
  transition: transform 160ms ease;
}

.is-collapsed .sidebar {
  width: var(--sidebar-width-collapsed);
}

.is-collapsed .nav-label,
.is-collapsed .brand-name {
  opacity: 0;
  pointer-events: none;
}

.is-collapsed .collapse-icon {
  transform: rotate(180deg);
}

/* Topbar */

.main {
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  min-width: 0;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 15;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--topbar-height);
  padding: 0 var(--space-5);
  background-color: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}

.page-title {
  font-size: 16px;
  font-weight: 600;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}

.icon-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--muted);
  cursor: pointer;
}

.icon-button:hover {
  background-color: var(--surface-hover);
  color: var(--fg);
}

.menu-button {
  display: none;
}

.user-menu {
  position: relative;
}

.user-button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 220px;
  padding: 4px 8px 4px 4px;
  background: none;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--fg);
  cursor: pointer;
}

.user-button:hover {
  background-color: var(--surface-hover);
  border-color: var(--border);
}

.user-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  background-color: var(--accent-soft);
  border-radius: 50%;
  color: var(--accent);
  font-size: 11px;
  font-weight: 650;
}

.user-email {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: 0;
  z-index: 30;
  width: 230px;
  padding: var(--space-2);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}

.menu-header {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--space-2);
}

.menu-email {
  overflow: hidden;
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-role {
  color: var(--muted);
  font-size: 12px;
  text-transform: capitalize;
}

.menu-item {
  display: block;
  width: 100%;
  padding: 7px var(--space-3);
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.menu-item:hover {
  background-color: var(--surface-hover);
  text-decoration: none;
}

.menu-item.is-danger {
  color: var(--error);
}

.menu-item:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Content */

.content {
  flex-grow: 1;
  min-width: 0;
  padding: var(--space-5);
}

.scrim {
  position: fixed;
  inset: 0;
  z-index: 19;
  background-color: var(--overlay);
}

@media (max-width: 860px) {
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    transform: translateX(-100%);
    box-shadow: var(--shadow-lg);
  }

  .sidebar.is-open {
    transform: translateX(0);
  }

  .is-collapsed .sidebar {
    width: var(--sidebar-width);
  }

  .is-collapsed .nav-label,
  .is-collapsed .brand-name {
    opacity: 1;
    pointer-events: auto;
  }

  .collapse-button {
    display: none;
  }

  .menu-button {
    display: flex;
  }

  .content {
    padding: var(--space-4) var(--space-3);
  }

  .topbar {
    padding: 0 var(--space-3);
  }

  .user-email {
    display: none;
  }
}
</style>
