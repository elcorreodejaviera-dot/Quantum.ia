import React from 'react'
import { useHLAccountBalance } from '../hooks/useHyperliquid'

// (JAV-93) Selector de cuenta HL DEDICADA, extraído de BotPortal para reuso (BotPortal + SpotGridView).
// Lógica idéntica a la original; sin cambios de comportamiento. `formatUsd` se mantiene local (mismo
// formato que BotPortal) para no tocar sus decenas de usos al extraer el componente.
function formatUsd(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '$0'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

export default function HLAccountSelect({ accounts, value, onChange }) {
  const selected = accounts.find((a) => a.id === value) ?? null
  const { account: bal } = useHLAccountBalance(selected?.tradingAccountAddress ?? null)
  return (
    <div className="config-field">
      <span>Wallet</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Selecciona una cuenta…</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {(a.label ?? 'Cuenta')} ({a.tradingAccountAddress.slice(0, 6)}…{a.tradingAccountAddress.slice(-4)})
          </option>
        ))}
      </select>
      {selected && (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}
          title="Withdrawable API (perp) y USDC spot libre. La disponibilidad real se valida al operar.">
          {bal ? `Withdrawable ${formatUsd(bal.withdrawable)} · Spot ${formatUsd(bal.spotUsdcFree)}` : '…'}
        </span>
      )}
    </div>
  )
}
