import { Fingerprint, Loader2 } from 'lucide-react'
import { Notice, useAsyncAction } from '../admin/ui'
import { webAuthnSupported } from '../admin/webauthn'
import { useConsole } from '../shell/context'

/**
 * Live server data is only served after a security-key check in the last five
 * minutes. This asks for one on request and then reloads what was waiting.
 */
export function StepUpPrompt({ what, onVerified, stale }: { what: string; onVerified: () => void; stale?: boolean }) {
  const { api, setMfaRecent } = useConsole()
  const action = useAsyncAction()
  const verify = () =>
    void action.run(async () => {
      await api.stepUp()
      setMfaRecent(true)
      onVerified()
    })
  return (
    <Notice
      tone={stale ? 'warning' : 'info'}
      action={
        <button type="button" className="btn btn-sm btn-primary" disabled={action.busy || !webAuthnSupported()} onClick={verify}>
          {action.busy ? <Loader2 size={14} className="spin" /> : <Fingerprint size={14} />}
          Verify with security key
        </button>
      }
    >
      <div>
        {stale
          ? <>Live updates of {what} paused: your security-key check is older than five minutes. The figures shown may be out of date.</>
          : <>{what.charAt(0).toUpperCase() + what.slice(1)} is only shown after a security-key check in the last five minutes.</>}
        {action.error && <div className="text-bad" style={{ marginTop: 4 }}>{action.error}</div>}
      </div>
    </Notice>
  )
}
