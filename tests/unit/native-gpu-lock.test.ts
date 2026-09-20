import { afterEach, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeGpuLockedCommand } from '../../workers/runner-gateway/src/native-gpu-lock.js'

const exec = promisify(execFile)
const roots: string[] = []
const groups: number[] = []
afterEach(() => {
  for (const pid of groups.splice(0)) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('holds GPU UUID locks across processes and releases them after cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-gpu-lock-')); roots.push(root)
  vi.stubEnv('DSH_NATIVE_GPU_LOCK_ROOT', root)
  const args = nativeGpuLockedCommand(['GPU-aaaa'], [process.execPath, '-e', 'console.log("ready");setInterval(()=>{},1000)'])
  const child = spawn(args[0]!, args.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  groups.push(child.pid!)
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); child.once('exit', code => { if (code) reject(new Error(`lock holder exited ${code}`)) }) })
  const conflicting = nativeGpuLockedCommand(['GPU-aaaa'], ['/bin/true'])
  await expect(exec(conflicting[0]!, conflicting.slice(1))).rejects.toMatchObject({ code: 75 })
  const independent = nativeGpuLockedCommand(['GPU-bbbb'], ['/bin/true'])
  await expect(exec(independent[0]!, independent.slice(1))).resolves.toBeDefined()
  const closed = new Promise(resolve => child.once('close', resolve))
  process.kill(-child.pid!, 'SIGKILL')
  await closed
  await expect(exec(conflicting[0]!, conflicting.slice(1))).resolves.toBeDefined()
})

it('bounds orphaned GPU work with an independent timeout and releases its locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-gpu-deadline-')); roots.push(root)
  vi.stubEnv('DSH_NATIVE_GPU_LOCK_ROOT', root)
  const command = nativeGpuLockedCommand(['GPU-aaaa'], [process.execPath, '-e', 'setInterval(()=>{},1000)'], 100)
  await expect(exec(command[0]!, command.slice(1), { timeout: 5000 })).rejects.toBeDefined()
  const next = nativeGpuLockedCommand(['GPU-aaaa'], ['/bin/true'])
  await expect(exec(next[0]!, next.slice(1))).resolves.toBeDefined()
})
