import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Cpu, Database, HardDrive, MemoryStick, Search, Server, ShieldCheck } from 'lucide-react'
import { Badge, Card, Meter, Notice, PageHeader, Skeleton, Stat, Table, Tabs, formatUptime, useResource } from '../admin/ui'
import { useConsole } from '../shell/context'
import { href } from '../shell/router'
import { normalizeService, type HardwareData, type ServiceItem } from '../shell/types'
import { StepUpPrompt } from './StepUp'

export function ServerPage({ tab }: { tab: 'resources' | 'services' }) {
  const { api } = useConsole()
  const hardware = useResource<HardwareData>(() => api.get('/api/system/hardware'), [api], 5000)
  const services = useResource<ServiceItem[]>(async () => (await api.get('/api/system/services')).services.map(normalizeService), [api], tab === 'services' ? 5000 : 30_000)
  const system = hardware.data?.system

  return (
    <div className="page">
      <PageHeader
        title="Server"
        description="Live resources of the host this platform runs on, and the application services listening on it. Updates every 5 seconds."
        meta={
          system && (
            <>
              <span className="mono">{system.hostname}</span>
              <span>{system.osName}</span>
              <span className="mono">{system.release}</span>
              <span>Up {formatUptime(system.uptimeSeconds)}</span>
            </>
          )
        }
        onRefresh={() => { void hardware.reload(); void services.reload() }}
        busy={hardware.loading}
      />
      <Tabs
        label="Server sections"
        active={tab}
        tabs={[
          { id: 'resources', label: 'Resources', href: href('server') },
          { id: 'services', label: 'Services', href: href('server', 'services'), count: services.data?.length },
        ]}
      />
      {(hardware.needsStepUp || services.needsStepUp) && (
        <StepUpPrompt
          what="live server data"
          stale={tab === 'resources' ? !!hardware.data : !!services.data}
          onVerified={() => { void hardware.reload(); void services.reload() }}
        />
      )}
      {tab === 'resources' ? (
        <Resources data={hardware.data} error={hardware.error} waiting={hardware.needsStepUp} />
      ) : (
        <Services list={services.data} error={services.error} loading={services.loading} waiting={services.needsStepUp} />
      )}
    </div>
  )
}

function Resources({ data, error, waiting }: { data: HardwareData | null; error: string | null; waiting: boolean }) {
  if (error && !data) return <Notice tone="error">{error}</Notice>
  if (!data && waiting) return null
  if (!data)
    return (
      <div className="grid-3">
        <Skeleton height={220} radius={12} />
        <Skeleton height={220} radius={12} />
        <Skeleton height={220} radius={12} />
      </div>
    )
  const { cpu, memory, storage, system } = data
  const loadPct = (cpu.loadAvg['1m'] / Math.max(1, cpu.cores)) * 100
  const cachePct = ((memory.cachedBytes + memory.buffersBytes) / Math.max(1, memory.totalBytes)) * 100
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)
  return (
    <>
      <div className="grid-3">
        <Card title="Processor" icon={<Cpu size={16} />} subtitle={cpu.model}>
          <Meter label="Load, last minute" percent={loadPct} value={`${Math.round(loadPct)}%`} detail={`of ${cpu.cores} cores`} warnAt={75} badAt={100} />
          <dl className="kv">
            <dt>Load average</dt><dd className="num">{cpu.loadAvg['1m']} · {cpu.loadAvg['5m']} · {cpu.loadAvg['15m']} <span className="muted">(1, 5, 15 min)</span></dd>
            <dt>Cores</dt><dd className="num">{cpu.cores}</dd>
            <dt>Clock</dt><dd className="num">{cpu.speedMhz ? `${(cpu.speedMhz / 1000).toFixed(2)} GHz` : '—'}</dd>
          </dl>
        </Card>
        <Card title="Memory" icon={<MemoryStick size={16} />} subtitle={`${memory.totalGB} GB installed`}>
          <Meter label="In use" percent={memory.usedPercent} secondary={cachePct} value={`${memory.usedPercent}%`} detail={`${memory.usedGB} GB`} warnAt={85} badAt={95} note="Light segment: cache and buffers" />
          <dl className="kv">
            <dt>Used</dt><dd className="num">{memory.usedGB} GB</dd>
            <dt>Cache & buffers</dt><dd className="num">{gb(memory.cachedBytes + memory.buffersBytes)} GB</dd>
            <dt>Free</dt><dd className="num">{memory.freeGB} GB</dd>
          </dl>
        </Card>
        <Card title="Storage" icon={<HardDrive size={16} />} subtitle={<span className="mono">{storage.filesystem}</span>}>
          <Meter label="Used" percent={storage.usedPercent} value={`${storage.usedPercent}%`} detail={`${storage.usedGB} GB`} warnAt={85} badAt={92} />
          <dl className="kv">
            <dt>Capacity</dt><dd className="num">{storage.totalGB} GB</dd>
            <dt>Used</dt><dd className="num">{storage.usedGB} GB</dd>
            <dt>Available</dt><dd className="num">{storage.availGB} GB</dd>
          </dl>
        </Card>
      </div>
      <Card title="Host" icon={<Server size={16} />} subtitle={`Sampled ${new Date(data.timestamp).toLocaleTimeString()}`} flush>
        <div className="kv-grid" style={{ borderTop: 0 }}>
          <div className="kv-cell"><span>Hostname</span><b className="mono">{system.hostname}</b></div>
          <div className="kv-cell"><span>Operating system</span><b>{system.osName}</b></div>
          <div className="kv-cell"><span>Kernel</span><b className="mono">{system.release}</b></div>
          <div className="kv-cell"><span>Architecture</span><b>{system.arch === 'x64' ? 'x86-64' : system.arch}</b></div>
          <div className="kv-cell"><span>Uptime</span><b>{formatUptime(system.uptimeSeconds)}</b></div>
        </div>
      </Card>
    </>
  )
}

const categoryIcon = (category: string) => (category === 'Database' ? <Database size={15} /> : category === 'Edge Ingress' ? <ShieldCheck size={15} /> : category === 'AI Runtime' ? <Cpu size={15} /> : <Server size={15} />)

function Services({ list, error, loading, waiting }: { list: ServiceItem[] | null; error: string | null; loading: boolean; waiting: boolean }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const services = useMemo(() => list ?? [], [list])
  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      services
        .filter((service) => !q || `${service.name} ${service.category} ${service.port} ${service.pid ?? ''} ${service.cmd}`.toLowerCase().includes(q))
        .sort((a, b) => a.port - b.port),
    [services, q],
  )
  const totalMb = services.reduce((sum, service) => sum + service.memoryMb, 0)
  const totalCpu = services.reduce((sum, service) => sum + service.cpuPercent, 0)
  const mem = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`)
  if (error && !list) return <Notice tone="error">{error}</Notice>
  if (!list && waiting) return null
  return (
    <>
      <div className="stats">
        <Stat label="Listening services" value={list ? services.length : '—'} foot="Operating-system ports excluded" />
        <Stat label="Memory in use" value={list ? mem(totalMb) : '—'} foot="Resident memory of these services" />
        <Stat label="CPU" value={list ? `${totalCpu.toFixed(1)}%` : '—'} foot="Sum across services" />
      </div>
      <Card flush>
        <div className="toolbar">
          <label className="search">
            <Search size={15} />
            <input className="input" type="search" placeholder="Search name, port, PID or command" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search services" />
          </label>
          <span className="toolbar-note">Select a row to see its command line</span>
        </div>
        {loading && !list ? (
          <div style={{ padding: 18, display: 'grid', gap: 10 }}><Skeleton height={32} /><Skeleton height={32} /></div>
        ) : (
          <Table minWidth={860}>
            <thead><tr><th style={{ width: 28 }} /><th>Service</th><th>Category</th><th>Port</th><th>Process</th><th className="right">CPU</th><th className="right">Memory</th><th>Uptime</th></tr></thead>
            <tbody>
              {visible.map((service) => {
                const expanded = open === service.id
                return (
                  <Fragment key={service.id}>
                    <tr className={`row-link${expanded ? ' row-selected' : ''}`} onClick={() => setOpen(expanded ? null : service.id)} aria-expanded={expanded}>
                      <td className="muted">{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                      <td>
                        <span className="inline-flex"><span className="list-icon" style={{ width: 26, height: 26 }}>{categoryIcon(service.category)}</span><span><span className="cell-title">{service.name}</span><span className="cell-sub">{service.description}</span></span></span>
                      </td>
                      <td><Badge>{service.category}</Badge></td>
                      <td className="nowrap"><span className="mono strong">:{service.port}</span> <span className="muted">{service.protocol}</span></td>
                      <td className="mono nowrap">{service.pid ?? '—'} <span className="muted">· {service.user}</span></td>
                      <td className="right num">{service.cpuPercent.toFixed(1)}%</td>
                      <td className="right num nowrap">{mem(service.memoryMb)} <span className="cell-sub">{service.memPercent.toFixed(1)}% of RAM</span></td>
                      <td className="mono muted nowrap">{service.uptime || '—'}</td>
                    </tr>
                    {expanded && (
                      <tr className="row-selected">
                        <td />
                        <td colSpan={7}>
                          <div className="terminal">{service.cmd || 'No command line available.'}</div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {visible.length === 0 && <tr className="empty-row"><td colSpan={8}>{services.length ? 'No services match.' : 'No listening services found.'}</td></tr>}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}
