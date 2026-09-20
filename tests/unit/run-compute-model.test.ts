import { describe, expect, it } from 'vitest'
import { runCompute, runComputeProfile, runGpuMapping } from '../../packages/dsh-research-ui/src/client/run-compute-model'

describe('per-run compute UI model', () => {
  it('requires an explicit GPU selection and preserves click order', () => {
    expect(() => runCompute('nvidia', [])).toThrow()
    expect(runCompute('cpu', ['5'])).toEqual({ mode: 'cpu' })
    expect(runCompute('nvidia', ['5', '2'])).toEqual({ mode: 'nvidia', devices: ['5', '2'] })
    expect(runCompute('nvidia', [], true)).toEqual({ mode: 'nvidia', devices: 'all' })
    expect(() => runCompute('nvidia', ['2', '2'])).toThrow()
    expect(runGpuMapping(['GPU-bbbb', 'GPU-aaaa'])).toBe('cuda:0 = GPU-bbbb\ncuda:1 = GPU-aaaa')
  })
  it('preserves the strict isolation tier when switching compute modes', () => {
    expect(runComputeProfile('profile_container_native_gpu_isolated_v1', { mode: 'cpu' })).toBe('profile_container_native_cpu_isolated_v1')
    expect(runComputeProfile('profile_container_native_cpu_v1', { mode: 'nvidia', devices: ['5'] })).toBe('profile_container_native_gpu_v1')
  })
})
