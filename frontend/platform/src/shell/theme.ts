import { useEffect, useState } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
const KEY = 'platform.theme'

function readPref(): ThemePref {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** Light, dark or follow the operating system; remembered on this device. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return
    const update = () => setSystemDark(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const theme = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const choose = (next: ThemePref) => {
    setPref(next)
    try {
      if (next === 'system') window.localStorage.removeItem(KEY)
      else window.localStorage.setItem(KEY, next)
    } catch {
      // Not remembered in private browsing.
    }
  }
  return { pref, theme, choose }
}
