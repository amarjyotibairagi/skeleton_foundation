import { useEffect, useState } from 'react'

// Hash routes (#/tenants/T123/plan) keep the console a single static page while
// giving every view a real address: back/forward, refresh and shared links work.

export type Route = { path: string; parts: string[] }

const read = (): Route => {
  const path = window.location.hash.replace(/^#/, '').replace(/\/+$/, '') || '/'
  return { path, parts: path.split('/').filter(Boolean).map(decodeURIComponent) }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const update = () => setRoute(read())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return route
}

export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join('/')}`

export function navigate(...parts: string[]) {
  window.location.hash = href(...parts).slice(1)
}
