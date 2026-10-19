import { useEffect, useState, type FormEvent } from 'react'
import { ShieldCheck } from 'lucide-react'

type Invitation = { username: string; displayName: string; role: string; expiresAt: string; passwordMinLength: number }

// Standalone page for /accept-invite. The token arrives in the URL fragment,
// which the browser never sends to the server; it is read here and removed
// from the address bar before anything else happens.
export default function AcceptInvite() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '')
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname)
    if (!token) {
      setError('This link is incomplete. Ask the person who invited you for a new one.')
      return
    }
    fetch('/api/auth/invitations/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.message)
        setInvitation(data.invitation)
      })
      .catch((caught: Error) => setError(caught.message || 'This invitation could not be loaded.'))
  }, [token])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password'))
    if (password !== String(form.get('confirm'))) {
      setError('The passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setDone(data.message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The invitation could not be accepted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page-bg">
      <div className="login-shell">
        <div className="login-brand">
          <span className="brand-mark"><ShieldCheck size={18} /></span>
          <span>Platform console</span>
        </div>
        <div className="login-card">
          <div>
            <h1>Set up your operator account</h1>
            <p className="login-sub">
              {invitation && !done
                ? <>Signing in as <strong>{invitation.username}</strong> ({invitation.role.replace('platform_', '')}). This link expires {new Date(invitation.expiresAt).toLocaleString()}.</>
                : 'Choose the password you will sign in with.'}
            </p>
          </div>
          {error && <div className="login-error" role="alert">{error}</div>}
          {done ? (
            <>
              <p style={{ fontSize: 13.5, color: '#15803d' }}>{done}</p>
              <a className="login-submit" href="/" style={{ textDecoration: 'none' }}>Go to sign in</a>
            </>
          ) : invitation ? (
            <form onSubmit={(event) => void submit(event)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="login-field">
                <label htmlFor="invite-password">New password</label>
                <input id="invite-password" className="login-input" style={{ paddingLeft: 12 }} name="password" type="password" autoComplete="new-password" minLength={invitation.passwordMinLength} required />
                <span style={{ fontSize: 12, color: '#5b6779' }}>At least {invitation.passwordMinLength} characters. A passphrase works well.</span>
              </div>
              <div className="login-field">
                <label htmlFor="invite-confirm">Confirm password</label>
                <input id="invite-confirm" className="login-input" style={{ paddingLeft: 12 }} name="confirm" type="password" autoComplete="new-password" required />
              </div>
              <button className="login-submit" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
            </form>
          ) : null}
        </div>
      </div>
    </main>
  )
}
