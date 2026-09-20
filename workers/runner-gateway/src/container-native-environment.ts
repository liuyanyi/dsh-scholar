import { execFile } from 'node:child_process'
import { constants, accessSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { ContainerNativeFingerprint, containerNativeFingerprintHash, NativeEnvironmentSnapshot, nativeEnvironmentSnapshotHash, type ContainerNativeEnvironment, type DockerCompute } from '@dsh-scholar/research-schemas'

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
  try { return (await exec(command, args, { env, timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim() } catch { return null }
}

const pythonInventory = `import hashlib, importlib.metadata as m, json, re, sys
def h(b): return 'sha256:' + hashlib.sha256(b).hexdigest()
rows = []
for d in m.distributions():
    record = d.read_text('RECORD')
    rows.append({'name': re.sub(r'[-_.]+', '-', d.metadata['Name']).lower(), 'version': d.version, 'record_hash': h(record.encode()) if record else None})
rows.sort(key=lambda r: (r['name'], r['version'], r['record_hash'] or ''))
with open(sys.executable, 'rb') as f: executable = h(f.read())
print(json.dumps({'version': sys.version.split()[0], 'executable_hash': executable, 'prefix_hash': h(sys.prefix.encode()), 'distributions': rows}))`

export async function collectNativeEnvironment(cwd: string, compute: DockerCompute, image: string, source: NodeJS.ProcessEnv = process.env, runProbe: NativeProbe = probe, pythonCommand = 'python'): Promise<ContainerNativeEnvironment & { runtime_snapshot: NativeEnvironmentSnapshot }> {
  const env = nativeEnvironment(cwd, compute, source)
  const python = await runProbe(pythonCommand, ['--version'], env)
  const inventory = await runProbe(pythonCommand, ['-I', '-c', pythonInventory], env)
  if (python !== null && inventory === null) throw new Error('environment: native_python_inventory_unavailable')
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
  const runtime_snapshot = NativeEnvironmentSnapshot.parse({
    schema_version: 1, os: process.platform, arch: process.arch,
    node: { version: process.version, executable_hash: `sha256:${createHash('sha256').update(readFileSync(process.execPath)).digest('hex')}` },
    python: inventory === null ? null : JSON.parse(inventory),
    cuda_version: cuda?.match(/release (\d+\.\d+)/)?.[1] ?? null,
    driver_version: drivers.size ? [...drivers].sort().join(',') : null,
    gpu_uuids: available.map(d => d.uuid).sort(),
  })
  const fingerprint = ContainerNativeFingerprint.parse({
    schema_version: 2, execution_kind: 'container-native', os: process.platform, arch: process.arch, node_version: process.version,
    actual_environment_hash: nativeEnvironmentSnapshotHash(runtime_snapshot),
    python_version: runtime_snapshot.python === null ? null : `Python ${runtime_snapshot.python.version}`,
    cuda_version: cuda?.match(/release (\d+\.\d+)/)?.[1] ?? null,
    nvidia_driver_version: drivers.size ? [...drivers].sort().join(',') : null,
    gpu_devices: available,
    dependency_lock_hash: Object.keys(locks).length ? `sha256:${createHash('sha256').update(JSON.stringify(locks)).digest('hex')}` : null,
    container_image_identity: identity !== undefined && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(identity) ? identity : null,
    network_isolation: 'not-enforced', resource_isolation: 'parent-container', compute,
  })
  return { kind: 'container-native', configured_image_pin: image, fingerprint, fingerprint_hash: containerNativeFingerprintHash(fingerprint), runtime_snapshot }
}
