import { DockerCompute } from '@dsh-scholar/research-schemas/runner-environment'

export function runCompute(mode: 'cpu' | 'nvidia', devices: string[], all = false): DockerCompute {
  return DockerCompute.parse(mode === 'cpu' ? { mode } : { mode, devices: all ? 'all' : devices })
}

/** Preserve the selected isolation tier when switching CPU/GPU for one run. */
export function runComputeProfile(profileId: string, compute: DockerCompute): string {
  return profileId.replace(/^(profile_container_native_)(cpu|gpu)(_.+)$/, `$1${compute.mode === 'cpu' ? 'cpu' : 'gpu'}$3`)
}

export function runGpuMapping(uuids: string[]): string {
  return uuids.map((uuid, index) => `cuda:${index} = ${uuid}`).join('\n')
}
