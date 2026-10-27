import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { resourceTotals } from './resource-usage'

const vm = {
  id: 'vm-01',
  resource_usage: {
    status: 'ok',
    cpu_used_cores: 0.5,
    cpu_limit_cores: 2,
    memory_used_bytes: 200,
    memory_limit_bytes: 1024,
  },
} as Vm

describe('slot resource totals', () => {
  it('adds usage and capacities without averaging percentages', () => {
    const total = resourceTotals([vm, { ...vm, id: 'vm-02' }])
    expect(total.known).toBe(2)
    expect(total.usage.cpu_used_cores).toBe(1)
    expect(total.usage.memory_limit_bytes).toBe(2048)
  })
  it('marks partial coverage and sums only sampled slots', () => {
    const total = resourceTotals([vm, { id: 'vm-02' } as Vm])
    expect(total.known).toBe(1)
    expect(total.total).toBe(2)
    expect(total.usage.cpu_used_cores).toBe(0.5)
  })
  it('does not report zero usage without any samples', () => {
    expect(resourceTotals([]).usage.cpu_used_cores).toBeUndefined()
    expect(resourceTotals([{ id: 'vm-02' } as Vm]).usage.status).toBe('error')
  })
})
