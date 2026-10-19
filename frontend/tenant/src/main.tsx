import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@skeleton/ui/styles.css'
import './theme.css'
import App from './App'
import AcceptInvite from './AcceptInvite'
import ErrorBoundary from './ErrorBoundary'

// A lazily loaded part of the app (a view, the report generator) that cannot be
// fetched usually means a newer version was deployed after this tab opened.
// Reload once to pick it up; never loop if the file is genuinely missing.
window.addEventListener('vite:preloadError', (event) => {
  let last = 0
  try {
    last = Number(sessionStorage.getItem('app.chunk-reload') || 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem('app.chunk-reload', String(Date.now()))
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{window.location.pathname === '/accept-invite' ? <AcceptInvite /> : <App />}</ErrorBoundary>
  </StrictMode>,
)
