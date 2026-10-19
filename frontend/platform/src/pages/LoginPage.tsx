import { useState, type FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, Lock, ShieldCheck, User } from 'lucide-react'
import { TurnstileSlot } from '@skeleton/ui/TurnstileSlot'
import { useTurnstile } from '@skeleton/ui/useTurnstile'
import type { AuthUser } from '../shell/types'

/**
 * Operator sign-in. The card keeps one size from first paint: the Turnstile
 * slot reserves the widget's box, and messages float below the card instead of
 * pushing its contents around.
 */
export function LoginPage({ productName, onSignedIn }: { productName: string; onSignedIn: (user: AuthUser, csrfToken: string, mfaRecent: boolean) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const turnstile = useTurnstile({ enabled: true, onError: setError })
  const { isVerified, turnstileToken, resetTurnstile } = turnstile

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!isVerified || !turnstileToken) return
    setError(null)
    if (!username.trim()) return setError('Enter your username.')
    if (!password) return setError('Enter your password.')
    setBusy(true)
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: username.trim(), password, turnstileToken }),
      })
      const data = await response.json()
      if (response.ok && data.success) {
        onSignedIn(data.user, data.csrfToken, Boolean(data.mfaRecent))
        return
      }
      setError(data.message || 'The username or password is not correct.')
      resetTurnstile()
    } catch {
      setError('Unable to reach the server. Try again.')
      resetTurnstile()
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page-bg">
      <div className="login-shell">
        <div className="login-brand">
          <span className="brand-mark"><ShieldCheck size={18} /></span>
          <span>{productName}</span>
          <span className="brand-tag">Platform</span>
        </div>
        <div className="login-card">
          <div>
            <h1>Sign in to the console</h1>
            <p className="login-sub">Platform operators only. Use your administrator credentials.</p>
          </div>
          {error && <div role="alert" className="login-error">{error}</div>}
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="login-field">
              <label htmlFor="platform-login-username">Username</label>
              <div className="login-input-wrap">
                <User size={17} />
                <input id="platform-login-username" className="login-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter username" autoComplete="username" />
              </div>
            </div>
            <div className="login-field">
              <label htmlFor="platform-login-password">Password</label>
              <div className="login-input-wrap">
                <Lock size={17} />
                <input
                  id="platform-login-password"
                  className="login-input"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  autoComplete="current-password"
                />
                <button type="button" className="login-toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            <TurnstileSlot turnstile={turnstile} />
            <button type="submit" className="login-submit" disabled={!isVerified || busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              <ArrowRight size={17} />
            </button>
          </form>
        </div>
        <p className="login-foot">Every sign-in is recorded in the platform audit log.</p>
      </div>
    </main>
  )
}
