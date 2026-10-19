import { useConsole, isOwner } from '../shell/context'
import { ConfigEditor, type ConfigDefinition } from './ConfigEditor'
import { Card, Notice, PageHeader, useResource } from './ui'

export function ConfigurationView() {
  const { api, user } = useConsole()
  const config = useResource<{ definitions: ConfigDefinition[]; values: Record<string, unknown> }>(async () => {
    const data = await api.get('/api/config/definitions')
    return {
      definitions: data.definitions,
      values: Object.fromEntries(data.platformValues.map((row: { key: string; value: unknown }) => [row.key, row.value])),
    }
  }, [api])
  const definitions = config.data?.definitions ?? []
  const values = config.data?.values ?? {}

  return (
    <div className="page">
      <PageHeader
        title="Configuration"
        description="Platform-wide defaults for every feature, limit and setting. Plans and tenants override them where a key allows."
        onRefresh={() => void config.reload()}
        busy={config.loading}
      />
      {config.error && <Notice tone="error">{config.error}</Notice>}
      {!isOwner(user) && <Notice tone="warning">Only platform owners can change platform-wide values. You can view them.</Notice>}
      <Notice>
        Resolution order: definition default, then platform, plan, tenant override and finally tenant-local values (tenant-editable keys only). Tenant services pick up changes within about 10 seconds.
      </Notice>
      <Card title="Platform values" subtitle={`${definitions.length} keys`}>
        <ConfigEditor
          api={api}
          definitions={definitions}
          scope={{ scope: 'platform' }}
          overrides={values}
          readOnly={!isOwner(user)}
          effective={{
            values: Object.fromEntries(definitions.map((definition) => [definition.key, definition.key in values ? values[definition.key] : definition.defaultValue])),
            sources: Object.fromEntries(definitions.map((definition) => [definition.key, definition.key in values ? 'platform' : 'default'])),
          }}
          onChanged={() => void config.reload()}
        />
      </Card>
    </div>
  )
}
