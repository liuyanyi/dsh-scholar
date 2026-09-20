import { execFile } from 'node:child_process'
import { constants, accessSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { ContainerNativeFingerprint, containerNativeFingerprintHash, type ContainerNativeEnvironment, type DockerCompute } from '@dsh-scholar/research-schemas'

const exec = promisify(execFile)
const inheritedKeys = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'LD_LIBRARY_PATH', 'CUDA_HOME', 'CUDA_PATH', 'NVIDIA_VISIBLE_DEVICES', 'NVIDIA_DRIVER_CAPABILITIES'] as const

export function nativeEnvironment(cwd: string, compute: DockerCompute, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', openin_any: 'p', openout_any: 'p' }
  for (const key of inheritedKeys) if (source[key] !== undefined) env[key] = source[key]!
  env.CUDA_VISIBLE_DEVICES = compute.mode === 'cpu' ? '' : compute.devices === 'all' ? (source.CUDA_VISIBLE_DEVICES ?? '') : compute.devices.join(',')
  if (compute.mode === 'nvidia' && compute.devices === 'all' && source.CUDA_VISIBLE_DEVICES === undefined) delete env.CUDA_VISIBLE_DEVICES
  env.DSH_OUTPUTS_DIR = join(cwd, 'outputs')
  env.DSH_WORK_DIR = cwd
  env.DSH_DATA_DIR = join(cwd, 'inputs', 'data')
  return env
}

export function resolveNativeExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (!command || command.includes('\0')) throw new Error('environment: native_executable_invalid')
  const candidates = command.includes('/') ? [isAbsolute(command) ? command : join(cwd, command)] : (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, command))
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate } catch { /* try next PATH entry */ }
  }
  throw new Error('environment: native_executable_missing')
}

export type NativeProbe = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string | null>
const probe: NativeProbe = async (command, args, env) => {
  try { return (await exec(command, args, { env, timeout: 5000, maxBuffer: 64 * 1024 })).stdout.trim() } catch { return null }
}

export async function collectNativeEnvironment(cwd: string, compute: DockerCompute, image: string, source: NodeJS.ProcessEnv = process.env, runProbe: NativeProbe = probe): Promise<ContainerNativeEnvironment> {
  const env = nativeEnvironment(cwd, compute, source)
  const python = await runProbe('python', ['--version'], env)
  const cuda = await runProbe('nvcc', ['--version'], env)
  const nvidia = await runProbe('nvidia-smi', ['--query-gpu=index,uuid,driver_version', '--format=csv,noheader,nounits'], env)
  const devices: Array<{ index: string; uuid: string }> = []
  const drivers = new Set<string>()
  for (const line of nvidia?.split('\n') ?? []) {
    const [index, uuid, driver] = line.split(',').map(s => s.trim())
    if (index !== undefined && /^\d+$/.test(index) && uuid !== undefined && /^GPU-[a-fA-F0-9-]+$/.test(uuid)) {
      devices.push({ index, uuid })
      if (driver !== undefined && /^[\d.]+$/.test(driver)) drivers.add(driver)
    }
  }
  devices.sort((a, b) => Number(a.index) - Number(b.index))
  const visible = source.CUDA_VISIBLE_DEVICES?.split(',').filter(Boolean)
  const available = visible === undefined ? devices : devices.filter(d => visible.includes(d.index) || visible.includes(d.uuid))
  if (compute.mode === 'nvidia' && (available.length === 0 || (compute.devices !== 'all' && compute.devices.some(id => !available.some(d => d.index === id))))) {
    throw new Error('environment: native_gpu_unavailable')
  }
  const locks: Record<string, string> = {}
  for (const name of ['uv.lock', 'poetry.lock', 'requirements.txt', 'pnpm-lock.yaml', 'package-lock.json']) {
    if (existsSync(join(cwd, name))) locks[name] = createHash('sha256').update(readFileSync(join(cwd, name))).digest('hex')
  }
  const identity = source.DSH_RESEARCH_CONTAINER_IMAGE
  const fingerprint = ContainerNativeFingerprint.parse({
    schema_version: 1, execution_kind: 'container-native', os: process.platform, arch: process.arch, node_version: process.version,
    python_version: python?.match(/^Python \d+\.\d+\.\d+(?:[a-z0-9.+-]*)?$/)?.[0] ?? null,
    cuda_version: cuda?.match(/release (\d+\.\d+)/)?.[1] ?? null,
    nvidia_driver_version: drivers.size ? [...drivers].sort().join(',') : null,
    gpu_devices: available,
    dependency_lock_hash: Object.keys(locks).length ? `sha256:${createHash('sha256').update(JSON.stringify(locks)).digest('hex')}` : null,
    container_image_identity: identity !== undefined && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(identity) ? identity : null,
    network_isolation: 'not-enforced', resource_isolation: 'parent-container', compute,
  })
  return { kind: 'container-native', configured_image_pin: image, fingerprint, fingerprint_hash: containerNativeFingerprintHash(fingerprint) }
}
