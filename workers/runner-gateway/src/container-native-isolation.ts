import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmdirSync, statfsSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { getRunnerProfile, type ExecutionPlan } from '@dsh-scholar/research-schemas'

const exec = promisify(execFile)
const CGROUP2_SUPER_MAGIC = 0x63677270

export interface NativeIsolation {
  wrap(command: string[]): string[]
  network_isolation: 'not-enforced' | 'network-namespace'
  resource_isolation: 'parent-container' | 'cgroup-v2'
  enforced_limits?: { cpus: number; memory_mb: number; pids: number }
  cleanup(): Promise<void>
}

/** Deployment owns the delegated path; a Job can select only a pinned profile. */
export async function prepareNativeIsolation(plan: ExecutionPlan, cwd: string, env: NodeJS.ProcessEnv): Promise<NativeIsolation> {
  const resources = getRunnerProfile(plan.profile_id)?.capabilities.includes('native-cgroup-v2') === true
  const network = plan.network.policy === 'none'
  let group: string | undefined
  const cleanup = async () => {
    if (group === undefined) return
    const path = group
    writeFileSync(join(path, 'cgroup.kill'), '1')
    // cgroup.kill is synchronous but process reaping can lag behind it.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { rmdirSync(path); group = undefined; return } catch (error) {
        if (!['EBUSY', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    throw new Error('environment: native_cgroup_cleanup_failed')
  }
  const limits = { cpus: plan.limits.cpus, memory_mb: plan.limits.memory_mb, pids: plan.limits.pids }
  try {
    if (resources) {
      const root = process.env.DSH_NATIVE_CGROUP_ROOT
      if (!root || !isAbsolute(root) || statfsSync(root).type !== CGROUP2_SUPER_MAGIC) throw new Error('native_cgroup_delegation_required')
      const parent = realpathSync(root)
      const enabled = readFileSync(join(parent, 'cgroup.subtree_control'), 'utf8').split(/\s+/)
      if (!['cpu', 'memory', 'pids'].every(controller => enabled.includes(controller))) throw new Error('native_cgroup_controllers_required')
      const path = join(parent, `dsh-${randomUUID()}`)
      mkdirSync(path)
      group = path
      writeFileSync(join(path, 'cpu.max'), `${Math.max(1000, Math.floor(limits.cpus * 100000))} 100000`)
      writeFileSync(join(path, 'memory.max'), String(limits.memory_mb * 1024 * 1024))
      writeFileSync(join(path, 'memory.swap.max'), '0')
      writeFileSync(join(path, 'memory.oom.group'), '1')
      writeFileSync(join(path, 'pids.max'), String(limits.pids))
      // Require cgroup.kill support before starting any experiment.
      readFileSync(join(path, 'cgroup.events'), 'utf8')
      writeFileSync(join(path, 'cgroup.kill'), '1')
    }
    const wrap = (command: string[]): string[] => {
      if (!network && !resources) return command
      const sandbox = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--bind', cwd, cwd, '--proc', '/proc', '--dev-bind', '/dev', '/dev', '--chdir', cwd,
        ...(network ? ['--unshare-net'] : []), '--', ...command]
      // Join before exec, so all descendants inherit the limits, with no attach race.
      return group === undefined ? sandbox : ['/bin/sh', '-c', 'printf "%s" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"', 'dsh-cgroup', group, ...sandbox]
    }
    if (network || resources) {
      const [executable, ...args] = wrap(['/bin/true'])
      await exec(executable!, args, { cwd, env, timeout: 5000, maxBuffer: 65536 })
    }
    return { wrap, network_isolation: network ? 'network-namespace' : 'not-enforced', resource_isolation: resources ? 'cgroup-v2' : 'parent-container', ...(resources ? { enforced_limits: limits } : {}), cleanup }
  } catch (error) {
    await cleanup()
    throw new Error(`environment: native_isolation_unavailable: ${(error as Error).message}`)
  }
}
