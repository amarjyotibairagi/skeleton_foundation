import type { FormEvent } from 'react'
import { Fingerprint, KeyRound, ShieldCheck } from 'lucide-react'
import { useConsole } from '../shell/context'
import { Badge, Card, Field, Notice, PageHeader, roleLabel, useAsyncAction } from './ui'
import { webAuthnSupported } from './webauthn'

const OPERATOR_PASSWORD_MIN_LENGTH = 14

export function SecurityView() {
  const { api, user, mfaRecent, setMfaRecent } = useConsole()
  const keys = useAsyncAction()
  const password = useAsyncAction()
  const supported = webAuthnSupported()

  const changePassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const newPassword = String(form.get('newPassword') ?? '')
    void password.run(async () => {
      if (newPassword !== String(form.get('confirmPassword') ?? '')) throw new Error('The new passwords do not match.')
      const result = await api.send<{ message: string }>('POST', '/api/auth/password', {
        currentPassword: String(form.get('currentPassword') ?? ''),
        newPassword,
      })
      formElement.reset()
      return result.message
    })
  }

  return (
    <div className="page">
      <PageHeader title="My security" description={<>Signed in as <span className="mono">{user.username}</span> ({roleLabel(user.role).toLowerCase()}). Manage your password and the security keys that unlock privileged actions.</>} />
      {!supported && <Notice tone="error">This browser does not support security keys (WebAuthn). Use a current browser to make changes.</Notice>}
      <div className="grid-2">
        <Card title="Security keys" icon={<Fingerprint size={16} />} subtitle="Privileged actions ask for a key check; it then lasts five minutes">
          <dl className="kv">
            <dt>This session</dt>
            <dd>{mfaRecent ? <Badge tone="good" dot>Verified recently</Badge> : <Badge dot>Not verified yet</Badge>}</dd>
          </dl>
          {keys.error && <Notice tone="error">{keys.error}</Notice>}
          {keys.message && <Notice tone="success">{keys.message}</Notice>}
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={!supported || keys.busy} onClick={() => void keys.run(async () => { await api.stepUp(); setMfaRecent(true); return 'Verified. Changes are unlocked for five minutes.' })}>
              <ShieldCheck size={15} /> Verify now
            </button>
            <button type="button" className="btn" disabled={!supported || keys.busy} onClick={() => void keys.run(async () => { await api.registerSecurityKey(); return 'Security key added.' })}>
              <KeyRound size={15} /> Add a security key
            </button>
          </div>
          <p className="hint">Lost every key? Another platform owner can reset them from Operators, or run <code>scripts/platform-operator.mjs</code> on the host.</p>
        </Card>
        <Card title="Password" icon={<KeyRound size={16} />} subtitle={`At least ${OPERATOR_PASSWORD_MIN_LENGTH} characters. Your other sessions are signed out; this one stays.`}>
          <form className="form" onSubmit={changePassword}>
            <input type="text" name="username" autoComplete="username" value={user.username} hidden readOnly />
            <Field label="Current password"><input className="input" name="currentPassword" type="password" autoComplete="current-password" required maxLength={512} /></Field>
            <Field label="New password"><input className="input" name="newPassword" type="password" autoComplete="new-password" required minLength={OPERATOR_PASSWORD_MIN_LENGTH} maxLength={512} /></Field>
            <Field label="Confirm new password"><input className="input" name="confirmPassword" type="password" autoComplete="new-password" required minLength={OPERATOR_PASSWORD_MIN_LENGTH} maxLength={512} /></Field>
            {password.error && <Notice tone="error">{password.error}</Notice>}
            {password.message && <Notice tone="success">{password.message}</Notice>}
            <div className="form-actions"><button className="btn btn-primary" disabled={password.busy}>{password.busy ? 'Changing…' : 'Change password'}</button></div>
          </form>
        </Card>
      </div>
    </div>
  )
}
