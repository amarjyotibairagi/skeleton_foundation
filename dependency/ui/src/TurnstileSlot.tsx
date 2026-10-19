import { useLayoutEffect, useRef } from 'react'
import { LOGIN_CHALLENGE_DISABLED, TURNSTILE_BOX, type TurnstileController } from './useTurnstile'

/**
 * Fixed-size home for the login Turnstile widget. Its box is measured and
 * locked before first paint and matches the widget exactly, so the login card
 * keeps one size from the first frame: while the script loads (placeholder),
 * during an interactive challenge, after success, and after a reset.
 */
export function TurnstileSlot({ turnstile }: { turnstile: TurnstileController }) {
  const slotRef = useRef<HTMLDivElement>(null)
  const { lockSize, size } = turnstile

  useLayoutEffect(() => {
    if (slotRef.current) lockSize(slotRef.current.clientWidth)
  }, [lockSize])

  // Deployments without Turnstile (LOGIN_CHALLENGE=none) reserve no space for it.
  if (LOGIN_CHALLENGE_DISABLED) return null
  const box = TURNSTILE_BOX[size ?? 'flexible']
  return (
    <div ref={slotRef} style={{ position: 'relative', width: '100%', height: box.height, flex: '0 0 auto', overflow: 'hidden' }}>
      {/* Sits under the widget, which paints over it once Cloudflare renders. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: '50%',
          width: box.width,
          transform: 'translateX(-50%)',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid #e0e0e0',
          borderRadius: 4,
          background: '#fafafa',
          color: '#6b7280',
          fontSize: 13,
        }}
      >
        Loading security check…
      </div>
      {/* Block, not flex: a flex item would shrink the flexible widget to its
          300px minimum. Zero line-height removes the baseline gap under the
          widget's inline iframe, which would otherwise add 4px. */}
      <div
        ref={turnstile.turnstileContainerRef}
        style={{ position: 'relative', display: 'block', width: '100%', height: '100%', lineHeight: 0, textAlign: 'center' }}
      />
    </div>
  )
}
