import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { AdminApi } from './api'
import { Badge, Notice, Table, useAsyncAction } from './ui'

export type ConfigDefinition = {
  key: string
  kind: 'feature' | 'limit' | 'setting'
  valueType: 'boolean' | 'integer' | 'string' | 'string_list'
  label: string
  description: string
  category: string
  moduleCode: string | null
  defaultValue: unknown
  min: number | null
  max: number | null
  maxLength: number | null
  scopes: string[]
  tenantEditable: boolean
  isPublic: boolean
}

type Scope = { scope: 'platform' } | { scope: 'plan'; ref: string } | { scope: 'tenant'; ref: string }

function display(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Empty list'
  return String(value) || '""'
}

function parseInput(definition: ConfigDefinition, raw: string): unknown {
  switch (definition.valueType) {
    case 'boolean':
      return raw === 'true'
    case 'integer': {
      const value = Number(raw)
      if (!Number.isInteger(value)) throw new Error(`${definition.label} must be a whole number.`)
      return value
    }
    case 'string_list':
      return raw.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
    default:
      return raw
  }
}

const kindTone = { feature: 'info', limit: 'warn', setting: 'neutral' } as const

/**
 * Edits configuration overrides at one scope. Shows, per key, the value this
 * scope sets (if any), the effective value where known, and where it came from.
 */
export function ConfigEditor({ api, definitions, scope, overrides, effective, onChanged, readOnly }: {
  api: AdminApi
  definitions: ConfigDefinition[]
  scope: Scope
  overrides: Record<string, unknown>
  effective?: { values: Record<string, unknown>; sources: Record<string, string> } | null
  onChanged: () => void
  readOnly?: boolean
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')
  const [onlyOverridden, setOnlyOverridden] = useState(false)
  const action = useAsyncAction()
  const visible = useMemo(
    () =>
      definitions
        .filter((definition) => definition.scopes.includes(scope.scope))
        .filter((definition) => !onlyOverridden || definition.key in overrides)
        .filter((definition) => !filter || `${definition.key} ${definition.label} ${definition.category}`.toLowerCase().includes(filter.toLowerCase())),
    [definitions, scope.scope, filter, onlyOverridden, overrides],
  )
  const grouped = useMemo(() => {
    const groups = new Map<string, ConfigDefinition[]>()
    for (const definition of visible) groups.set(definition.category, [...(groups.get(definition.category) || []), definition])
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [visible])
  const overriddenCount = definitions.filter((definition) => definition.scopes.includes(scope.scope) && definition.key in overrides).length

  const startEdit = (definition: ConfigDefinition) => {
    const current = definition.key in overrides ? overrides[definition.key] : effective?.values[definition.key] ?? definition.defaultValue
    setDraft(Array.isArray(current) ? current.join('\n') : String(current ?? ''))
    setEditing(definition.key)
  }

  const save = (definition: ConfigDefinition) =>
    action.run(async () => {
      const value = parseInput(definition, draft)
      await api.send('PUT', '/api/config/values', { ...scope, key: definition.key, value })
      setEditing(null)
      onChanged()
      return `${definition.label} saved.`
    })

  const clear = (definition: ConfigDefinition) =>
    action.run(async () => {
      await api.send('DELETE', '/api/config/values', { ...scope, key: definition.key })
      onChanged()
      return `${definition.label} now inherits.`
    })

  return (
    <div className="config">
      <div className="form-inline">
        <label className="search">
          <Search size={15} />
          <input className="input" type="search" placeholder="Filter features, limits and settings" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter configuration" />
        </label>
        <label className="check" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={onlyOverridden} onChange={(event) => setOnlyOverridden(event.target.checked)} style={{ marginTop: 0 }} />
          Only values set here ({overriddenCount})
        </label>
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}
      {grouped.map(([category, items]) => (
        <div key={category} className="config-group">
          <h3>{category}</h3>
          <Table minWidth={720}>
            <thead>
              <tr>
                <th>Setting</th>
                <th style={{ width: '24%' }}>Set here</th>
                {effective && <th style={{ width: '22%' }}>Effective</th>}
                {!readOnly && <th className="right" style={{ width: 150 }} />}
              </tr>
            </thead>
            <tbody>
              {items.map((definition) => {
                const overridden = definition.key in overrides
                const isEditing = editing === definition.key
                return (
                  <tr key={definition.key}>
                    <td>
                      <span className="badges">
                        <span className="strong">{definition.label}</span>
                        <Badge tone={kindTone[definition.kind]}>{definition.kind}</Badge>
                        {definition.tenantEditable && <Badge tone="good">tenant-editable</Badge>}
                      </span>
                      <span className="cell-sub"><span className="mono">{definition.key}</span> · default {display(definition.defaultValue)}{definition.description ? ` · ${definition.description}` : ''}</span>
                    </td>
                    <td>
                      {isEditing ? (
                        definition.valueType === 'boolean' ? (
                          <select className="input input-sm" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={definition.label}>
                            <option value="true">On</option>
                            <option value="false">Off</option>
                          </select>
                        ) : definition.valueType === 'string_list' ? (
                          <textarea className="input" rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={definition.label} placeholder="One per line" />
                        ) : (
                          <input
                            className="input input-sm"
                            type={definition.valueType === 'integer' ? 'number' : 'text'}
                            min={definition.min ?? undefined}
                            max={definition.max ?? undefined}
                            maxLength={definition.maxLength ?? undefined}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void save(definition)
                              if (event.key === 'Escape') setEditing(null)
                            }}
                            aria-label={definition.label}
                          />
                        )
                      ) : overridden ? (
                        <span className="strong" style={{ overflowWrap: 'anywhere' }}>{display(overrides[definition.key])}</span>
                      ) : (
                        <span className="muted">Inherited</span>
                      )}
                    </td>
                    {effective && (
                      <td>
                        <span className="badges">
                          <span style={{ overflowWrap: 'anywhere' }}>{display(effective.values[definition.key])}</span>
                          <Badge>{effective.sources[definition.key] || 'default'}</Badge>
                        </span>
                      </td>
                    )}
                    {!readOnly && (
                      <td>
                        <div className="row-actions">
                          {isEditing ? (
                            <>
                              <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                              <button type="button" className="btn btn-sm btn-primary" disabled={action.busy} onClick={() => void save(definition)}>Save</button>
                            </>
                          ) : (
                            <>
                              {overridden && <button type="button" className="btn btn-sm btn-ghost" disabled={action.busy} onClick={() => void clear(definition)}>Reset</button>}
                              <button type="button" className="btn btn-sm" onClick={() => startEdit(definition)}>{overridden ? 'Change' : 'Override'}</button>
                            </>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </Table>
        </div>
      ))}
      {!visible.length && <div className="empty"><strong>No matching keys</strong></div>}
    </div>
  )
}
