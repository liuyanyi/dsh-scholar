import { accessSync, constants, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** flock stays outside the sandbox and holds each UUID until its child exits. */
export function nativeGpuLockedCommand(uuids: string[], command: string[], timeoutMs = 60000, readyPath?: string): string[] {
  if (uuids.length === 0) return command
  accessSync('/usr/bin/flock', constants.X_OK)
  accessSync('/usr/bin/timeout', constants.X_OK)
  const root = process.env.DSH_NATIVE_GPU_LOCK_ROOT ?? join(tmpdir(), 'dsh-native-gpu-locks')
  if (!isAbsolute(root)) throw new Error('environment: native_gpu_lock_directory_must_be_absolute')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error('environment: native_gpu_lock_directory_unsafe')
  let wrapped = readyPath === undefined ? command : ['/bin/sh', '-c', ': > "$1" || exit 125; shift; exec "$@"', 'dsh-gpu', readyPath, ...command]
  for (const uuid of [...new Set(uuids)].sort().reverse()) {
    if (!/^GPU-[a-fA-F0-9-]+$/.test(uuid)) throw new Error('environment: native_gpu_uuid_invalid')
    const file = join(root, `${uuid}.lock`)
    closeSync(openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600))
    wrapped = ['/usr/bin/flock', '--nonblock', '--conflict-exit-code', '75', file, ...wrapped]
  }
  // An independent deadline also bounds orphaned work after Runner SIGKILL.
  return ['/usr/bin/timeout', '--signal=KILL', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`, ...wrapped]
}
