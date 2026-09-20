import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionPlan } from '@dsh-scholar/research-schemas'
import { RUNNER_PROFILE_IDS, getRunnerProfile } from '@dsh-scholar/research-schemas'

const mocks = vi.hoisted(() => ({
  write: vi.fn(), mkdir: vi.fn(), rmdir: vi.fn(), statfs: vi.fn(), read: vi.fn(), exec: vi.fn(),
}))
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeFileSync: mocks.write, mkdirSync: mocks.mkdir, rmdirSync: mocks.rmdir,
  statfsSync: mocks.statfs, readFileSync: mocks.read, realpathSync: (path: string) => path,
}))
vi.mock('node:child_process', () => ({ execFile: mocks.exec }))
import { prepareNativeIsolation } from '../../workers/runner-gateway/src/container-native-isolation.js'

function plan(id: string): ExecutionPlan {
  const profile = getRunnerProfile(id)!
  return { profile_id: id, network: { policy: profile.network_policy }, limits: profile.limits } as ExecutionPlan
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('DSH_NATIVE_CGROUP_ROOT', '/delegated')
  mocks.statfs.mockReturnValue({ type: 0x63677270 })
  mocks.read.mockReturnValue('cpu memory pids')
  mocks.exec.mockImplementation((_cmd, _args, _options, callback) => callback(null, '', ''))
})
afterEach(() => vi.unstubAllEnvs())

describe('optional native isolation', () => {
  it('default mode needs neither cgroups nor namespaces', async () => {
    const isolation = await prepareNativeIsolation(plan(RUNNER_PROFILE_IDS.containerNativeCpu), '/work', {})
    expect(isolation.wrap(['/bin/true'])).toEqual(['/bin/true'])
    expect(isolation.resource_isolation).toBe('parent-container')
    expect(isolation.network_isolation).toBe('not-enforced')
    await isolation.cleanup()
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it('offline mode requires a working sandbox, without allocating a cgroup', async () => {
    const isolation = await prepareNativeIsolation(plan(RUNNER_PROFILE_IDS.containerNativeCpuOffline), '/work', {})
    expect(isolation.wrap(['python', 'train.py'])).toContain('--unshare-net')
    expect(isolation.wrap(['python', 'train.py'])).toContain('--unshare-pid')
    expect(isolation.network_isolation).toBe('network-namespace')
    expect(mocks.mkdir).not.toHaveBeenCalled()
  })
  it.each([RUNNER_PROFILE_IDS.containerNativeCpuResources, RUNNER_PROFILE_IDS.containerNativeGpuIsolated])('enforces pinned limits before spawning: %s', async id => {
    const isolation = await prepareNativeIsolation(plan(id), '/work', { PATH: '/usr/bin' })
    const group = mocks.mkdir.mock.calls[0]![0]
    expect(mocks.write).toHaveBeenCalledWith(`${group}/cpu.max`, '100000 100000')
    expect(mocks.write).toHaveBeenCalledWith(`${group}/memory.max`, '1073741824')
    expect(mocks.write).toHaveBeenCalledWith(`${group}/memory.swap.max`, '0')
    expect(mocks.write).toHaveBeenCalledWith(`${group}/pids.max`, '256')
    expect(isolation.enforced_limits).toEqual({ cpus: 1, memory_mb: 1024, pids: 256 })
    const command = isolation.wrap(['python', 'x; touch /tmp/injected'])
    expect(command.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(command[2]).toContain('cgroup.procs')
    expect(command.slice(-2)).toEqual(['python', 'x; touch /tmp/injected'])
    expect(command).toContain('--cap-drop')
    expect(command).toContain('--ro-bind')
    expect(command.includes('--unshare-net')).toBe(id === RUNNER_PROFILE_IDS.containerNativeGpuIsolated)
    await isolation.cleanup()
    await isolation.cleanup()
    expect(mocks.write).toHaveBeenLastCalledWith(`${group}/cgroup.kill`, '1')
    expect(mocks.rmdir).toHaveBeenCalledTimes(1)
  })
  it.each(['missing', 'filesystem', 'controllers'])('rejects unusable cgroup delegation: %s', async cause => {
    if (cause === 'missing') vi.stubEnv('DSH_NATIVE_CGROUP_ROOT', '')
    if (cause === 'filesystem') mocks.statfs.mockReturnValue({ type: 1 })
    if (cause === 'controllers') mocks.read.mockReturnValue('cpu')
    await expect(prepareNativeIsolation(plan(RUNNER_PROFILE_IDS.containerNativeCpuResources), '/work', {})).rejects.toThrow('native_isolation_unavailable')
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('cleans up a partially configured group when a resource control is denied', async () => {
    mocks.write.mockImplementation((path: string) => { if (path.endsWith('memory.max')) throw new Error('EROFS') })
    await expect(prepareNativeIsolation(plan(RUNNER_PROFILE_IDS.containerNativeCpuResources), '/work', {})).rejects.toThrow('EROFS')
    expect(mocks.rmdir).toHaveBeenCalledTimes(1)
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('refuses namespace failures instead of silently executing without isolation', async () => {
    mocks.exec.mockImplementation((_cmd, _args, _options, callback) => callback(new Error('Operation not permitted')))
    await expect(prepareNativeIsolation(plan(RUNNER_PROFILE_IDS.containerNativeCpuIsolated), '/work', {})).rejects.toThrow('native_isolation_unavailable')
    expect(mocks.rmdir).toHaveBeenCalledTimes(1)
  })
  it('kills remaining descendants and waits for cgroup removal', async () => {
    const isolation = await prepareNativeIsolation(plan(RUNNER_PROFILE_IDS.containerNativeCpuResources), '/work', {})
    mocks.rmdir.mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) })
    await isolation.cleanup()
    expect(mocks.rmdir).toHaveBeenCalledTimes(2)
  })
})
