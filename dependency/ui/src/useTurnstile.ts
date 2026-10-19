import { useCallback, useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string
          action?: string
          theme?: 'light' | 'dark' | 'auto'
          size?: 'normal' | 'compact' | 'flexible'
          callback?: (token: string) => void
          'error-callback'?: () => void
          'expired-callback'?: () => void
        }
      ) => string
      reset: (widgetId?: string) => void
      remove: (widgetId?: string) => void
    }
  }
}

export const PRODUCTION_TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined

/**
 * Set at build time (VITE_LOGIN_CHALLENGE=none) only for deployments that run
 * without Cloudflare Turnstile. The servers must be configured the same way
 * (LOGIN_CHALLENGE=none) or they reject the placeholder token. Login screens
 * hide <TurnstileSlot> when this is set.
 */
export const LOGIN_CHALLENGE_DISABLED = import.meta.env.VITE_LOGIN_CHALLENGE === 'none'
export const DISABLED_CHALLENGE_TOKEN = 'login-challenge-disabled-by-configuration'

/** Widget dimensions Cloudflare renders for each size; the slot reserves exactly this box. */
export type TurnstileWidgetSize = 'flexible' | 'compact'
export const TURNSTILE_BOX: Record<TurnstileWidgetSize, { width: number | '100%'; height: number }> = {
  flexible: { width: '100%', height: 65 },
  compact: { width: 150, height: 140 },
}
// A flexible widget is never narrower than this; below it, compact fits.
const FLEXIBLE_MIN_WIDTH = 300

/**
 * Renders and manages a Cloudflare Turnstile widget for a login screen.
 *
 * The widget is rendered once with action "login" (every BFF verifies that
 * binding) into a slot whose size is chosen before first paint and never
 * changes afterwards: the widget is not collapsed after success, it keeps
 * showing Cloudflare's own success state. Use it with <TurnstileSlot>.
 *
 * `enabled` should be false while a session check is still pending or a user
 * is already signed in; the widget is removed when it turns false, so it
 * renders again after a sign-out.
 */
export function useTurnstile({ enabled, onError }: { enabled: boolean; onError: (message: string | null) => void }) {
  const [isVerified, setIsVerified] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [size, setSize] = useState<TurnstileWidgetSize | null>(null)
  const turnstileContainerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const sizeRef = useRef<TurnstileWidgetSize | null>(null)

  /** Called by the slot before first paint with its width; the first call wins. */
  const lockSize = useCallback((slotWidth: number) => {
    if (sizeRef.current) return
    sizeRef.current = slotWidth >= FLEXIBLE_MIN_WIDTH ? 'flexible' : 'compact'
    setSize(sizeRef.current)
  }, [])

  useEffect(() => {
    if (!enabled) return

    let interval: number | undefined

    const clearVerification = () => {
      setIsVerified(false)
      setTurnstileToken(null)
    }

    const initTurnstile = () => {
      if (LOGIN_CHALLENGE_DISABLED) {
        if (interval) clearInterval(interval)
        setIsVerified(true)
        setTurnstileToken(DISABLED_CHALLENGE_TOKEN)
        return
      }
      if (!PRODUCTION_TURNSTILE_SITE_KEY) {
        if (interval) clearInterval(interval)
        if (import.meta.env.DEV) {
          setIsVerified(true)
          setTurnstileToken('dev-token')
        } else {
          onError('Security verification is not configured.')
        }
        return
      }
      if (!window.turnstile || !turnstileContainerRef.current || !sizeRef.current || widgetIdRef.current) return
      try {
        widgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
          sitekey: PRODUCTION_TURNSTILE_SITE_KEY,
          action: 'login',
          theme: 'light',
          size: sizeRef.current,
          callback: (token: string) => {
            setIsVerified(true)
            setTurnstileToken(token)
            onError(null)
          },
          'error-callback': () => {
            clearVerification()
            onError('Verification failed. Please retry.')
          },
          'expired-callback': clearVerification,
        })
        if (interval) clearInterval(interval)
      } catch {
        clearVerification()
        onError('Security verification could not be initialized.')
      }
    }

    interval = window.setInterval(initTurnstile, 250)
    initTurnstile()

    return () => {
      if (interval) clearInterval(interval)
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current)
        } catch {
          // The script may already be gone during navigation.
        }
      }
      widgetIdRef.current = null
      clearVerification()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const resetTurnstile = () => {
    if (LOGIN_CHALLENGE_DISABLED) return
    setIsVerified(false)
    setTurnstileToken(null)
    if (window.turnstile && widgetIdRef.current) {
      try {
        window.turnstile.reset(widgetIdRef.current)
      } catch {
        // ignore
      }
    }
  }

  return { isVerified, turnstileToken, size, lockSize, turnstileContainerRef, resetTurnstile }
}

export type TurnstileController = ReturnType<typeof useTurnstile>
