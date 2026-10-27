import type { Vm, VmResourceUsage } from '@/types/panel-vm'

export function resourceTotals(vms: Vm[]): {
  usage: VmResourceUsage
  known: number
  total: number
} {
  const known = vms.filter((vm) => vm.resource_usage?.status === 'ok')
  const complete = known.length > 0
  const sum = (
    key:
      | 'cpu_used_cores'
      | 'cpu_limit_cores'
      | 'memory_used_bytes'
      | 'memory_limit_bytes'
  ) => known.reduce((n, vm) => n + (vm.resource_usage?.[key] ?? 0), 0)
  return {
    known: known.length,
    total: vms.length,
    usage: complete
      ? {
          status: 'ok',
          cpu_used_cores: sum('cpu_used_cores'),
          cpu_limit_cores: sum('cpu_limit_cores'),
          memory_used_bytes: sum('memory_used_bytes'),
          memory_limit_bytes: sum('memory_limit_bytes'),
        }
      : { status: 'error' },
  }
}
