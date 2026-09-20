import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJsonDeep } from './canonical-json.js'
import { DockerCompute } from './runner-environment.js'

const version = z.string().max(160).nullable()
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const NativeEnvironmentSnapshot = z.object({
  schema_version: z.literal(1),
  os: z.string(), arch: z.string(),
  node: z.object({ version: z.string(), executable_hash: sha256 }).strict(),
  python: z.object({
    version: z.string(), executable_hash: sha256, prefix_hash: sha256,
    distributions: z.array(z.object({ name: z.string(), version: z.string(), record_hash: sha256.nullable() }).strict()),
  }).strict().nullable(),
  cuda_version: version, driver_version: version,
  gpu_uuids: z.array(z.string().regex(/^GPU-[a-fA-F0-9-]+$/)),
}).strict()
export type NativeEnvironmentSnapshot = z.infer<typeof NativeEnvironmentSnapshot>
export function nativeEnvironmentSnapshotContent(value: NativeEnvironmentSnapshot): string {
  return canonicalJsonDeep(NativeEnvironmentSnapshot.parse(value))
}
export function nativeEnvironmentSnapshotHash(value: NativeEnvironmentSnapshot): string {
  return `sha256:${createHash('sha256').update(nativeEnvironmentSnapshotContent(value)).digest('hex')}`
}

export const ContainerNativeFingerprint = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]),
  execution_kind: z.literal('container-native'),
  os: z.string(), arch: z.string(), node_version: z.string(),
  python_version: version, cuda_version: version, nvidia_driver_version: version,
  gpu_devices: z.array(z.object({ index: z.string().regex(/^\d+$/), uuid: z.string().regex(/^GPU-[a-fA-F0-9-]+$/) }).strict()),
  dependency_lock_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  actual_environment_hash: sha256.optional(),
  container_image_identity: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/).nullable(),
  network_isolation: z.enum(['not-enforced', 'network-namespace']),
  resource_isolation: z.enum(['parent-container', 'cgroup-v2']),
  enforced_limits: z.object({ cpus: z.number().positive(), memory_mb: z.number().int().positive(), pids: z.number().int().positive() }).strict().optional(),
  compute: DockerCompute,
}).strict().refine(value => (value.resource_isolation === 'cgroup-v2') === (value.enforced_limits !== undefined), 'cgroup limits must describe enforced resources')
  .refine(value => value.schema_version !== 2 || value.actual_environment_hash !== undefined, 'v2 requires actual environment identity')
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
