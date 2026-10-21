import type { DatabaseRuntimeMetrics } from '@/types/panel-database'
import { StatusMark } from '@/components/status-mark'
import { PanelCard, StatCell } from '@/features/overview/panel-card'
import { formatMetricBytes, formatMetricNumber, formatMetricTime } from './metrics'

export function DatabaseOverview({ metrics, sampledAt }: {
  metrics: DatabaseRuntimeMetrics
  sampledAt: string | null
}) {
  const latency = metrics.probe_latency_ms == null ? '—' : `${metrics.probe_latency_ms.toFixed(1)}ms`
  return (
    <PanelCard
      title='数据库运行态'
      meta={sampledAt ? `采样于 ${formatMetricTime(sampledAt)}` : '当前快照'}
      action={<StatusMark variant='pill' tone={metrics.ok
        ? { key: 'ok', cls: 'ok', text: '连接正常' }
        : { key: 'bad', cls: 'bad', text: '连接失败' }} />}
    >
      <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-3 xl:grid-cols-6'>
        <StatCell label='数据库' value='PostgreSQL' hint={`版本 ${metrics.version}`} />
        <StatCell label='数据库大小' value={formatMetricBytes(metrics.file_size_bytes)} hint='数据、索引与辅助存储' />
        <StatCell label='查询延迟' value={latency} hint='固定 SELECT 1' />
        <StatCell label='应用连接池' value={`${formatMetricNumber(metrics.pool_total)} / ${formatMetricNumber(metrics.pool_max)}`} hint={`${formatMetricNumber(metrics.pool_idle)} 个空闲连接`} />
        <StatCell label='等待连接' value={formatMetricNumber(metrics.pool_waiting)} hint='等待获取连接的请求' />
        <StatCell label='数据库连接' value={formatMetricNumber(metrics.connections)} hint='当前数据库的全部连接' />
      </div>
    </PanelCard>
  )
}
