import { createApp } from 'vue'
import App from './App.vue'
import { setUnauthorizedHandler } from './api.js'
import { clearSession } from './auth.js'
import { router } from './router.js'
import { initTheme } from './theme.js'
import './style.css'

initTheme()

// An authenticated request rejected with 401 means the session ended: drop the
// local state and send the user to the login screen (unless already there).
setUnauthorizedHandler(() => {
  clearSession()
  const current = router.currentRoute.value
  if (current.name === 'login' || current.name === 'setup') return
  void router.replace({ name: 'login', query: { redirect: current.fullPath } })
})

createApp(App).use(router).mount('#app')
