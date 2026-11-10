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
  { name: 'docs', label: 'Docs', icon: 'docs' },
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
      <RouterLink class="brand" :to="{ name: 'dashboard' }" aria-label="Uptime — dashboard">
        <span class="brand-mark" aria-hidden="true">
          <span class="mark-node" />
          <span class="mark-line" />
          <span class="mark-square" />
        </span>
        <span class="brand-text">
          <span class="brand-name">Uptime</span>
          <span class="brand-endorsement">A BlasterSystems product</span>
        </span>
      </RouterLink>

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
  gap: 32px;
  flex-shrink: 0;
  width: var(--sidebar-width);
  height: 100vh;
  padding: 28px 0 18px;
  background-color: var(--surface-sunken);
  border-right: 1px solid var(--border-1);
  transition: width 160ms ease;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: var(--space-1) var(--space-2) var(--space-5);
  overflow: hidden;
  color: var(--ink);
  text-decoration: none;
  border-radius: var(--radius-sm);
}

.brand:hover .brand-name {
  color: var(--thread-ink);
}

/* The DS thread mark: ○ transparency — vermilion thread — ■ on record. */
.brand-mark {
  position: relative;
  flex: none;
  width: 30px;
  height: 10px;
  color: var(--ink);
}

.mark-node {
  position: absolute;
  left: 0;
  top: 0;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.mark-line {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 4.25px;
  height: 1.5px;
  background: var(--thread);
}

.mark-square {
  position: absolute;
  right: 0;
  top: 0;
  width: 10px;
  height: 10px;
  background: currentColor;
}

.brand-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.brand-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1;
  white-space: nowrap;
}

.brand-endorsement {
  overflow: hidden;
  color: color-mix(in oklch, currentColor 62%, transparent);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: var(--tracking-mono);
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 42px;
  padding: 0 16px 0 22px;
  color: var(--text-2);
  font-size: var(--fs-nav);
  font-weight: var(--fw-medium);
  text-decoration: none;
  white-space: nowrap;
  transition: color var(--dur-press);
}

.nav-item::before {
  content: "";
  position: absolute;
  left: 9px;
  top: 5px;
  bottom: 5px;
  width: 2px;
  border-radius: 2px;
  background: transparent;
}

.nav-item:hover,
.nav-item.router-link-exact-active {
  color: var(--ink);
  text-decoration: none;
}

/* The active path is the one vermilion line in the composition. */
.nav-item.router-link-exact-active::before {
  background: var(--thread);
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
  border-radius: var(--radius-control);
  color: var(--text-2);
  font-size: var(--fs-small);
  cursor: pointer;
}

.collapse-button:hover {
  background-color: var(--surface-card);
  color: var(--ink);
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
.is-collapsed .brand-name,
.is-collapsed .brand-endorsement {
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
  background-color: var(--surface-sunken);
  border-bottom: 1px solid var(--border-1);
}

.page-title {
  font-size: var(--fs-stat);
  font-weight: var(--fw-medium);
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
  border-radius: var(--radius-control);
  color: var(--text-2);
  cursor: pointer;
}

.icon-button:hover {
  background-color: var(--surface-card);
  color: var(--ink);
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
  border-radius: var(--radius-sm);
  color: var(--ink);
  cursor: pointer;
}

.user-button:hover {
  background-color: var(--surface-card);
  border-color: var(--border-1);
}

.user-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  background-color: var(--action-bg);
  border-radius: var(--radius-control);
  color: var(--action-fg);
  font-family: var(--font-mono);
  font-size: var(--fs-endorse);
  font-weight: var(--fw-medium);
  letter-spacing: var(--tracking-mono);
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
  background-color: var(--surface-card);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-panel);
}

.menu-header {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--space-2);
}

.menu-email {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
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
  border-radius: var(--radius-control);
  color: var(--ink);
  font-size: var(--fs-small);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.menu-item:hover {
  background-color: var(--surface-sunken);
  text-decoration: none;
}

.menu-item.is-danger {
  color: var(--thread-ink);
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
  background-color: color-mix(in oklch, var(--paper) 72%, transparent);
}

@media (max-width: 860px) {
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    transform: translateX(-100%);
    border-right: 1px solid var(--border-1);
  }

  .sidebar.is-open {
    transform: translateX(0);
  }

  .is-collapsed .sidebar {
    width: var(--sidebar-width);
  }

  .is-collapsed .nav-label,
  .is-collapsed .brand-name,
  .is-collapsed .brand-endorsement {
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
