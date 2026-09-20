import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJsonDeep } from './canonical-json.js'
import { DockerCompute } from './runner-environment.js'

const version = z.string().max(160).nullable()
export const ContainerNativeFingerprint = z.object({
  schema_version: z.literal(1),
  execution_kind: z.literal('container-native'),
  os: z.string(), arch: z.string(), node_version: z.string(),
  python_version: version, cuda_version: version, nvidia_driver_version: version,
  gpu_devices: z.array(z.object({ index: z.string().regex(/^\d+$/), uuid: z.string().regex(/^GPU-[a-fA-F0-9-]+$/) }).strict()),
  dependency_lock_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  container_image_identity: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/).nullable(),
  network_isolation: z.enum(['not-enforced', 'network-namespace']),
  resource_isolation: z.enum(['parent-container', 'cgroup-v2']),
  enforced_limits: z.object({ cpus: z.number().positive(), memory_mb: z.number().int().positive(), pids: z.number().int().positive() }).strict().optional(),
  compute: DockerCompute,
}).strict().refine(value => (value.resource_isolation === 'cgroup-v2') === (value.enforced_limits !== undefined), 'cgroup limits must describe enforced resources')
export type ContainerNativeFingerprint = z.infer<typeof ContainerNativeFingerprint>

export function containerNativeFingerprintHash(value: ContainerNativeFingerprint): string {
  return `sha256:${createHash('sha256').update(canonicalJsonDeep(ContainerNativeFingerprint.parse(value))).digest('hex')}`
}

export const ContainerNativeEnvironment = z.object({
  kind: z.literal('container-native'),
  configured_image_pin: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
  fingerprint: ContainerNativeFingerprint,
  fingerprint_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().refine(value => value.fingerprint_hash === containerNativeFingerprintHash(value.fingerprint), 'environment fingerprint hash mismatch')
export type ContainerNativeEnvironment = z.infer<typeof ContainerNativeEnvironment>
