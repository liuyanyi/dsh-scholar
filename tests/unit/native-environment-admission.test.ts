import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { getRunnerProfile, RUNNER_PROFILE_IDS, type ContainerNativeFingerprint } from '@dsh-scholar/research-schemas'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
const hash = `sha256:${'a'.repeat(64)}`
const observed: ContainerNativeFingerprint = {
  schema_version: 2, execution_kind: 'container-native', os: 'linux', arch: 'x64', node_version: 'test',
  python_version: null, cuda_version: null, nvidia_driver_version: null,
  gpu_devices: [{ index: '0', uuid: 'GPU-aaaa' }, { index: '1', uuid: 'GPU-bbbb' }],
  dependency_lock_hash: null, container_image_identity: null, actual_environment_hash: hash,
  network_isolation: 'not-enforced', resource_isolation: 'parent-container', compute: { mode: 'cpu' },
}

function setup(gpu = false) {
  const root = mkdtempSync(join(tmpdir(), 'native-admit-'))
  const dbPath = join(root, 'kernel.db')
  const casRoot = join(root, 'cas')
  const kernel = new ResearchKernel({ dbPath, casRoot })
  cleanup.push(() => { kernel.close(); rmSync(root, { recursive: true, force: true }) })
  const target = kernel.updateRunnerTarget('target_container_native_v1', { expected_revision: 1, enabled: true, capabilities: ['container-native', 'network-inherited', 'cpu', 'nvidia'], ...(gpu ? { native_compute: { mode: 'nvidia' as const, devices: ['0'] } } : {}) })
  const heartbeat = (observation = observed) => kernel.observeRunnerTarget(target.target_id, { expected_revision: target.revision, health: 'online', native_observation: observation })
  heartbeat()
  const profile = getRunnerProfile(gpu ? RUNNER_PROFILE_IDS.containerNativeGpu : RUNNER_PROFILE_IDS.containerNativeCpu)!
  const project = kernel.createProject({ name: 'native pin', workspace: root, brief: { problem: 'test', scope: 'test', questions: [], primary_metrics: ['accuracy'], resources: '', risks: [], target_outputs: [], target_venue: null, baseline_repo: null, domain: 'ml' }, execution: { runner_profile_id: profile.profile_id, runner_target_id: target.target_id } })
  const contract = kernel.registerContract({ project_id: project.project_id, idea_id: 'idea_test', data: { dataset_id: 'd', version: 'v1' }, methods: { baseline: 'b', treatment: 'a' }, metrics: { primary: 'accuracy', secondary: [] }, seeds: [11], analysis: {}, ablations: [], stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true } })
  const code = kernel.registerArtifact({ project_id: project.project_id, kind: 'code', content: '{"schema_version":1,"files":{}}' })
  const submit = (key: string) => kernel.submitJob({ project_id: project.project_id, contract_id: contract.contract_id, kind: 'baseline', idempotency_key: key, image_digest: profile.image, code_snapshot_id: code.artifact_id, command: ['true'] })
  return { kernel, contract, heartbeat, submit, target, project, dbPath, casRoot }
}

describe('approved native environment admission', () => {
  it('requires a v2 observation at approval, and never silently repins an approved Contract', () => {
    const h = setup()
    h.heartbeat({ ...observed, schema_version: 1, actual_environment_hash: undefined })
    expect(() => h.kernel.approveContract(h.contract.contract_id, 'dec', 'pi')).toThrow(/v2/)
    h.heartbeat()
    const approved = h.kernel.approveContract(h.contract.contract_id, 'dec', 'pi')
    expect(approved.approval?.native_environment).toEqual({ target_id: h.target.target_id, sha256: hash })
    const job = h.submit('initial')
    expect(job.payload.expected_environment_hash).toBe(hash)
    h.heartbeat({ ...observed, actual_environment_hash: `sha256:${'b'.repeat(64)}` })
    expect(() => h.submit('drifted')).toThrow(/differs from the approved Contract/)
    expect(h.kernel.claimJobs('runner')).toEqual([])
    expect(h.kernel.approveContract(h.contract.contract_id, 'other', 'pi').approval).toEqual(approved.approval)
  })
  it('serializes overlapping GPU UUID claims across Kernel instances and releases on terminal state', () => {
    const h = setup(true)
    h.kernel.approveContract(h.contract.contract_id, 'dec', 'pi')
    h.submit('a'); h.submit('b')
    const second = new ResearchKernel({ dbPath: h.dbPath, casRoot: h.casRoot })
    cleanup.push(() => second.close())
    const [first] = h.kernel.claimJobs('one', 300, 8)
    expect(first?.payload.native_gpu_uuids).toEqual(['GPU-aaaa'])
    expect(second.claimJobs('two', 300, 8)).toEqual([])
    const addTargetJob = (id: string, device: string) => {
      const target = h.kernel.registerRunnerTarget({ target_id: id, display_name: id, kind: 'container-native', enabled: true, draining: false, capabilities: h.target.capabilities, service_identity: h.target.service_identity!, native_compute: { mode: 'nvidia', devices: [device] } })
      h.kernel.observeRunnerTarget(id, { expected_revision: target.revision, health: 'online', native_observation: observed })
      return h.kernel.submitJob({ project_id: h.project.project_id, kind: 'smoke', idempotency_key: id, runner_target_id: id, runner_profile_id: RUNNER_PROFILE_IDS.containerNativeGpu, command: ['true'] })
    }
    addTargetJob('target_gpu_alias', '0')
    expect(second.claimJobs('two', 300, 8)).toEqual([])
    const independent = addTargetJob('target_gpu_other', '1')
    expect(second.claimJobs('two', 300, 8).map(job => job.job_id)).toEqual([independent.job_id])
    h.kernel.completeJob({ job_id: first!.job_id, owner: 'one', status: 'failed', failure_class: 'environment', lease_generation: first!.lease_generation, lease_token: first!.lease_token })
    expect(second.claimJobs('two', 300, 8)).toHaveLength(1)
  })
  it('recovers crashed leases with a new generation, while cancellation frees scheduling capacity', () => {
    const h = setup(true)
    h.kernel.approveContract(h.contract.contract_id, 'dec', 'pi')
    h.submit('a'); h.submit('b')
    const [first] = h.kernel.claimJobs('one', 300, 8)
    expect(h.kernel.recoverExpiredLeases(Date.now() + 400000)).toBe(1)
    const [next] = h.kernel.claimJobs('two', 300, 8)
    expect(next).toBeDefined()
    expect(() => h.kernel.completeJob({ job_id: first!.job_id, owner: 'one', status: 'failed', lease_generation: first!.lease_generation, lease_token: first!.lease_token })).toThrow()
    h.kernel.cancelJob(next!.job_id, 'pi')
    expect(h.kernel.claimJobs('three', 300, 8)).toHaveLength(1)
  })
})
