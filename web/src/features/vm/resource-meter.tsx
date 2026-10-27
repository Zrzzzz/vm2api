import type { Vm, VmResourceUsage } from '@/types/panel-vm'
import { fmtBytes } from '@/lib/format'
import { resourceTotals } from './resource-usage'

const STATUS_TEXT = {
  error: '采集失败',
  unsupported: '暂不支持',
  stopped: '已停止',
  warming: '采样中',
  ok: '',
}

function Meter({
  label,
  used,
  limit,
  bytes,
  note,
}: {
  label: string
  used?: number | null
  limit?: number
  bytes?: boolean
  note: string
}) {
  const valid =
    used != null && Number.isFinite(used) && limit != null && limit > 0
  const pct = valid ? (used / limit) * 100 : null
  const format = (n: number) => (bytes ? fmtBytes(n) : n.toFixed(2))
  return (
    <div className='grid min-w-0 gap-1'>
      <div className='flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] tabular-nums'>
        <span className='text-muted-foreground'>{label}</span>
        <span className='font-mono'>
          {valid
            ? `${format(used)} / ${format(limit)}${bytes ? '' : ' 核'}`
            : note}
        </span>
      </div>
      <div
        className='h-1 overflow-hidden rounded-full bg-muted'
        aria-hidden='true'
      >
        {pct != null ? (
          <div
            className='h-full rounded-full transition-[width]'
            style={{
              width: `${Math.min(100, Math.max(0, pct))}%`,
              backgroundColor:
                pct >= 90
                  ? 'var(--status-warn-solid)'
                  : 'var(--status-ok-solid)',
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

export function ResourceMeter({ usage }: { usage?: VmResourceUsage }) {
  const note = usage ? STATUS_TEXT[usage.status] : '未采集'
  return (
    <div
      className='grid min-w-0 gap-2'
      title={
        usage?.sampled_at
          ? `采样时间 ${new Date(usage.sampled_at).toLocaleTimeString()}；CPU 1 核相当于 Docker 100%；MEM 不含可回收文件缓存${usage.memory_limit_kind === 'host' ? '；未限制内存，上限为宿主可用总量' : ''}`
          : note
      }
    >
      <Meter
        label='CPU'
        used={usage?.cpu_used_cores}
        limit={usage?.cpu_limit_cores}
        note={note}
      />
      <Meter
        label='MEM'
        used={usage?.memory_used_bytes}
        limit={usage?.memory_limit_bytes}
        bytes
        note={note}
      />
    </div>
  )
}

export function ResourceSummary({ vms }: { vms: Vm[] }) {
  const { usage, known, total } = resourceTotals(vms)
  return (
    <div className='grid min-w-0 gap-2'>
      <div className='flex flex-wrap justify-between gap-x-3 text-[11px] text-muted-foreground'>
        <span>已采集槽位合计</span>
        <span>
          已采集 {known}/{total}
        </span>
      </div>
      <ResourceMeter usage={usage} />
      <span className='text-[10px] text-muted-foreground'>
        上限为槽位上限之和，非宿主物理容量
        {known < total ? '；未采集槽位未计入' : ''}
      </span>
    </div>
  )
}
