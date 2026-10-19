import { useState, type FormEvent } from 'react'
import { Layers, Plus } from 'lucide-react'
import { isAdmin, isOwner, useConsole } from '../shell/context'
import { ConfigEditor, type ConfigDefinition } from './ConfigEditor'
import { Badge, Card, EmptyState, Field, Modal, Notice, PageHeader, Table, useAsyncAction, useResource } from './ui'

type Plan = {
  planCode: string
  displayName: string
  audience: 'b2b' | 'b2c' | 'both'
  isActive: boolean
  version: number
  tenantCount: number
  overrides: Record<string, unknown>
  description: string
  priceMonthly: number | null
  highlights: string[]
  sortOrder: number
}

const audienceLabel = { b2b: 'Tenants', b2c: 'Individuals', both: 'Both' } as const

export function PlansView() {
  const { api, user } = useConsole()
  const canEdit = isOwner(user)
  const plans = useResource<Plan[]>(async () => (await api.get('/api/plans')).plans, [api])
  const definitions = useResource<ConfigDefinition[]>(async () => (await api.get('/api/config/definitions')).definitions, [api])
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const action = useAsyncAction()

  const list = plans.data ?? []
  const plan = list.find((item) => item.planCode === selected) ?? list[0]

  const savePlan = (event: FormEvent<HTMLFormElement>, existing?: Plan) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    void action.run(async () => {
      const planCode = existing?.planCode ?? String(form.get('planCode'))
      await api.send('POST', '/api/plans', {
        planCode,
        displayName: form.get('displayName'),
        audience: form.get('audience'),
        isActive: form.get('isActive') === 'on',
      })
      setSelected(planCode)
      setCreating(false)
      await plans.reload()
      return `Plan ${planCode} saved.`
    })
  }

  return (
    <div className="page">
      <PageHeader
        title="Plans"
        description="Plans group entitlements. Their values sit between the platform defaults and a tenant's own overrides."
        onRefresh={() => void plans.reload()}
        busy={plans.loading}
        actions={canEdit && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> New plan</button>}
      />
      {plans.error && <Notice tone="error">{plans.error}</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}

      <Card title="All plans" flush>
        {list.length === 0 ? (
          <EmptyState icon={<Layers size={20} />} title={plans.loading ? 'Loading plans…' : 'No plans yet'} />
        ) : (
          <Table>
            <thead><tr><th>Plan</th><th>For</th><th className="right">Tenants</th><th>Price</th><th>State</th></tr></thead>
            <tbody>
              {list.map((item) => (
                <tr key={item.planCode} className={`row-link${item.planCode === plan?.planCode ? ' row-selected' : ''}`} onClick={() => setSelected(item.planCode)}>
                  <td><span className="cell-title">{item.displayName}</span><span className="cell-sub"><span className="mono">{item.planCode}</span> · version {item.version}</span></td>
                  <td>{audienceLabel[item.audience]}</td>
                  <td className="right num">{item.tenantCount}</td>
                  <td className="num">{item.priceMonthly === null ? <span className="muted">—</span> : `${item.priceMonthly.toFixed(2)} / month`}</td>
                  <td>{item.isActive ? <Badge tone="good" dot>Active</Badge> : <Badge dot>Retired</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {plan && (
        <>
          {canEdit && (
            <div className="grid-2">
              <Card title={`${plan.displayName}: details`}>
                <form className="form" onSubmit={(event) => savePlan(event, plan)} key={`${plan.planCode}-${plan.version}`}>
                  <div className="form-grid">
                    <Field label="Display name"><input className="input" name="displayName" defaultValue={plan.displayName} required maxLength={120} /></Field>
                    <Field label="Available to">
                      <select className="input" name="audience" defaultValue={plan.audience}>
                        <option value="b2b">Tenants (B2B)</option>
                        <option value="b2c">Individuals (B2C)</option>
                        <option value="both">Both</option>
                      </select>
                    </Field>
                  </div>
                  <label className="check"><input type="checkbox" name="isActive" defaultChecked={plan.isActive} /> Available for assignment</label>
                  <div className="form-actions"><button className="btn btn-primary" disabled={action.busy}>Save details</button></div>
                </form>
              </Card>
              {plan.audience !== 'b2b' ? (
                <Card title="Shown on the public app">
                  <form
                    className="form"
                    key={`${plan.planCode}-presentation-${plan.description}-${plan.priceMonthly}`}
                    onSubmit={(event) => {
                      event.preventDefault()
                      const form = new FormData(event.currentTarget)
                      const price = String(form.get('priceMonthly') || '').trim()
                      void action.run(async () => {
                        await api.send('PATCH', `/api/plans/${plan.planCode}/presentation`, {
                          description: String(form.get('description') || ''),
                          priceMonthly: price === '' ? null : Number(price),
                          highlights: String(form.get('highlights') || '').split('\n').map((line) => line.trim()).filter(Boolean),
                          sortOrder: Number(form.get('sortOrder') || 100),
                        })
                        await plans.reload()
                        return 'Public plan details saved. The public app picks them up within a minute.'
                      })
                    }}
                  >
                    <Field label="Description"><input className="input" name="description" defaultValue={plan.description} maxLength={500} /></Field>
                    <div className="form-grid">
                      <Field label="Monthly price"><input className="input" name="priceMonthly" type="number" min={0} step="0.01" defaultValue={plan.priceMonthly ?? ''} /></Field>
                      <Field label="Order" hint="Lower comes first"><input className="input" name="sortOrder" type="number" defaultValue={plan.sortOrder} /></Field>
                    </div>
                    <Field label="Highlights" hint="One per line"><textarea className="input" name="highlights" rows={4} defaultValue={plan.highlights.join('\n')} /></Field>
                    <div className="form-actions"><button className="btn btn-primary" disabled={action.busy}>Save public details</button></div>
                  </form>
                </Card>
              ) : (
                <Card title="Public app">
                  <p className="hint">This plan is for tenants only, so it is not listed on the public app.</p>
                </Card>
              )}
            </div>
          )}
          <Card title={`Entitlements: ${plan.displayName}`} subtitle="What tenants on this plan get, unless a tenant override says otherwise">
            <ConfigEditor
              api={api}
              definitions={definitions.data ?? []}
              scope={{ scope: 'plan', ref: plan.planCode }}
              overrides={plan.overrides}
              readOnly={!isAdmin(user)}
              onChanged={() => void plans.reload()}
            />
          </Card>
        </>
      )}

      {creating && (
        <Modal
          title="New plan"
          icon={<Layers size={18} />}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button type="submit" form="new-plan" className="btn btn-primary" disabled={action.busy}>Create plan</button>
            </>
          }
        >
          <form id="new-plan" className="form" onSubmit={(event) => savePlan(event)}>
            <Field label="Code" hint="Lowercase letters, digits and underscores, e.g. enterprise. Cannot be changed."><input className="input mono" name="planCode" required pattern="[a-z][a-z0-9_]{1,62}" /></Field>
            <Field label="Display name"><input className="input" name="displayName" required maxLength={120} /></Field>
            <Field label="Available to">
              <select className="input" name="audience" defaultValue="b2b">
                <option value="b2b">Tenants (B2B)</option>
                <option value="b2c">Individuals (B2C)</option>
                <option value="both">Both</option>
              </select>
            </Field>
            <label className="check"><input type="checkbox" name="isActive" defaultChecked /> Available for assignment</label>
            {action.error && <Notice tone="error">{action.error}</Notice>}
          </form>
        </Modal>
      )}
    </div>
  )
}
