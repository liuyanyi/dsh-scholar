import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { collectNativeEnvironment, heartbeatLoop } from '@dsh-scholar/runner-gateway'
import { getRunnerProfile, RUNNER_PROFILE_IDS } from '@dsh-scholar/research-schemas'
import type { ResearchClient } from '@dsh-scholar/research-client'

const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const profile = getRunnerProfile(RUNNER_PROFILE_IDS.containerNativeCpu)!
const sha = `sha256:${'1'.repeat(64)}`

describe('native actual Python environment identity', () => {
  it.skipIf(!process.env.DSH_TEST_DRIFT_PYTHON)('detects a real uv dependency upgrade without changing the declared lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-real-drift-')); dirs.push(root)
    writeFileSync(join(root, 'requirements.txt'), 'packaging==24.2\n')
    const python = process.env.DSH_TEST_DRIFT_PYTHON!
    const exec = promisify(execFile)
    await exec('uv', ['pip', 'install', '--python', python, 'packaging==24.2'], { timeout: 60000 })
    const first = await collectNativeEnvironment(root, { mode: 'cpu' }, profile.image, process.env, undefined, python)
    await exec('uv', ['pip', 'install', '--python', python, 'packaging==25.0'], { timeout: 60000 })
    const upgraded = await collectNativeEnvironment(root, { mode: 'cpu' }, profile.image, process.env, undefined, python)
    expect(first.runtime_snapshot.python?.distributions.find(d => d.name === 'packaging')?.version).toBe('24.2')
    expect(upgraded.runtime_snapshot.python?.distributions.find(d => d.name === 'packaging')?.version).toBe('25.0')
    expect(upgraded.fingerprint.dependency_lock_hash).toBe(first.fingerprint.dependency_lock_hash)
    expect(upgraded.fingerprint.actual_environment_hash).not.toBe(first.fingerprint.actual_environment_hash)
    console.log('Real uv drift detected: packaging 24.2 -> 25.0; declared lock unchanged')
  }, 120000)
  it('detects installed version and RECORD drift while the declared lock stays unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-drift-')); dirs.push(root)
    writeFileSync(join(root, 'uv.lock'), 'unchanged-lock')
    let installed = '2.7.1'
    let record = sha
    const probe = async (command: string, args: string[]) => command !== 'python' ? null : args[0] === '--version' ? 'Python 3.12.3' : JSON.stringify({
      version: '3.12.3', executable_hash: sha, prefix_hash: sha,
      distributions: [{ name: 'torch', version: installed, record_hash: record }],
    })
    const first = await collectNativeEnvironment(root, { mode: 'cpu' }, profile.image, {}, probe)
    installed = '2.8.0'
    const upgraded = await collectNativeEnvironment(root, { mode: 'cpu' }, profile.image, {}, probe)
    expect(upgraded.fingerprint.dependency_lock_hash).toBe(first.fingerprint.dependency_lock_hash)
    expect(upgraded.fingerprint.actual_environment_hash).not.toBe(first.fingerprint.actual_environment_hash)
    installed = '2.7.1'; record = `sha256:${'2'.repeat(64)}`
    const reinstalled = await collectNativeEnvironment(root, { mode: 'cpu' }, profile.image, {}, probe)
    expect(reinstalled.fingerprint.actual_environment_hash).not.toBe(first.fingerprint.actual_environment_hash)
    expect(JSON.stringify(first.runtime_snapshot)).not.toContain(root)
  })
  it('rejects an interpreter whose inventory cannot be collected', async () => {
    await expect(collectNativeEnvironment('/tmp', { mode: 'cpu' }, profile.image, {}, async (cmd, args) => cmd === 'python' && args[0] === '--version' ? 'Python 3.12.3' : null)).rejects.toThrow('native_python_inventory_unavailable')
  })
})

describe('native lease supervision', () => {
  it('terminates at lease expiry even when renewal never returns', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const lost = vi.fn(() => ac.abort())
    const client = { heartbeatJob: vi.fn(() => new Promise(() => {})) } as unknown as ResearchClient
    await heartbeatLoop('job', 'owner', client, 20, ac.signal, 1, 'token', lost, new Date(Date.now() + 100).toISOString())
    await vi.advanceTimersByTimeAsync(150)
    expect(lost).toHaveBeenCalledTimes(1)
    expect(client.heartbeatJob).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops a fenced attempt immediately on stale renewal', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const lost = vi.fn(() => ac.abort())
    const client = { heartbeatJob: vi.fn(async () => { throw { code: 'lease_stale', status: 409 } }) } as unknown as ResearchClient
    await heartbeatLoop('job', 'owner', client, 20, ac.signal, 1, 'token', lost, new Date(Date.now() + 1000).toISOString())
    await vi.advanceTimersByTimeAsync(30)
    expect(lost).toHaveBeenCalledTimes(1)
  })
  it('extends the deadline only after an acknowledged renewal', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const lost = vi.fn(() => ac.abort())
    const client = { heartbeatJob: vi.fn(async () => ({ lease_expires_at: new Date(Date.now() + 1000).toISOString() })) } as unknown as ResearchClient
    await heartbeatLoop('job', 'owner', client, 20, ac.signal, 1, 'token', lost, new Date(Date.now() + 30).toISOString())
    await vi.advanceTimersByTimeAsync(100)
    expect(lost).not.toHaveBeenCalled()
    ac.abort()
  })
})
