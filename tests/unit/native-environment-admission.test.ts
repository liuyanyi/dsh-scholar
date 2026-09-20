import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'
import { ResearchClient } from '@dsh-scholar/research-client'
import { buildExecutionPlan, getRunnerProfile, RUNNER_PROFILE_IDS, runnerTargetConfigHash, type DockerCompute, type ContainerNativeFingerprint } from '@dsh-scholar/research-schemas'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
const hash = `sha256:${'a'.repeat(64)}`
const observed: ContainerNativeFingerprint = {
  schema_version: 3, execution_kind: 'container-native', os: 'linux', arch: 'x64', node_version: 'test',
  python_version: null, cuda_version: null, nvidia_driver_version: null,
  gpu_devices: [{ index: '0', uuid: 'GPU-aaaa' }, { index: '1', uuid: 'GPU-bbbb' }],
  dependency_lock_hash: null, container_image_identity: null, actual_environment_hash: hash,
  software_environment_hash: hash,
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
  const submit = (key: string, compute: DockerCompute | undefined = gpu ? { mode: 'nvidia', devices: ['0'] } : undefined) => kernel.submitJob({ project_id: project.project_id, contract_id: contract.contract_id, kind: 'baseline', idempotency_key: key, image_digest: profile.image, code_snapshot_id: code.artifact_id, command: ['true'], compute })
  return { kernel, contract, heartbeat, submit, target, project, dbPath, casRoot, code }
}

describe('approved native environment admission', () => {
  it('passes per-run compute through the atomic baseline endpoint and binds its idempotency', async () => {
    const h = setup(true)
    const decide = (type: 'scope' | 'idea' | 'contract') => {
      const gate = h.kernel.createGate({ project_id: h.project.project_id, type, title: type, ...(type === 'contract' ? { payload: { contract_id: h.contract.contract_id } } : {}) })
      return h.kernel.decideGate({ gate_id: gate.gate_id, actor: 'pi', decision: 'approved' }).project
    }
    let project = decide('scope')
    project = h.kernel.transition(project.project_id, 'SURVEYING', project.revision)
    project = h.kernel.transition(project.project_id, 'IDEATING', project.revision)
    project = decide('idea')
    project = h.kernel.transition(project.project_id, 'CONTRACT_PENDING', project.revision)
    project = decide('contract')
    const { server, url } = await startKernelServer({ kernel: h.kernel, host: '127.0.0.1', port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url })
      const request = { project_id: project.project_id, expected_revision: project.revision, idempotency_key: 'baseline-compute', contract_id: h.contract.contract_id, code_snapshot_id: h.code.artifact_id, command: ['true'], compute: { mode: 'nvidia' as const, devices: ['1', '0'] }, runner_profile_id: RUNNER_PROFILE_IDS.containerNativeGpu }
      const started = await client.startBaselineRun(request)
      expect(started.job.payload.native_gpu_uuids).toEqual(['GPU-bbbb', 'GPU-aaaa'])
      expect(started.project.status).toBe('BASELINE_REPRO')
      expect((await client.startBaselineRun(request)).job.job_id).toBe(started.job.job_id)
      await expect(client.startBaselineRun({ ...request, compute: { mode: 'nvidia', devices: ['0'] } })).rejects.toMatchObject({ code: 'idempotency_conflict' })
      const next = await client.startBaselineRun({ ...request, expected_revision: started.project.revision, idempotency_key: 'baseline-other-gpu', compute: { mode: 'nvidia', devices: ['0'] } })
      expect(next.job.payload.native_gpu_uuids).toEqual(['GPU-aaaa'])
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('reads legacy approvals without rewriting them and requires an explicit software-pin upgrade', () => {
    const h = setup()
    const approved = h.kernel.approveContract(h.contract.contract_id, 'old-decision', 'pi')
    delete approved.approval!.native_environment!.schema_version
    const db = new DatabaseSync(h.dbPath)
    try { db.prepare('UPDATE contracts SET body = ? WHERE contract_id = ?').run(JSON.stringify(approved), approved.contract_id) } finally { db.close() }
    expect(h.kernel.approveContract(approved.contract_id, 'new-decision', 'pi')).toEqual(approved)
    expect(() => h.submit('legacy-new-job')).toThrow(/v2 software pin/)
    expect(h.kernel.getContract(approved.contract_id)).toEqual(approved)
  })
  it('fixes independent ordered allocations under one Target and approval through HTTP/Client', async () => {
    const h = setup(true)
    h.heartbeat({ ...observed, gpu_devices: [{ index: '2', uuid: 'GPU-aaaa' }, { index: '5', uuid: 'GPU-bbbb' }] })
    const approved = h.kernel.approveContract(h.contract.contract_id, 'dec', 'pi')
    const before = h.kernel.listRunnerTargets().find(t => t.target_id === h.target.target_id)!
    const { server, url } = await startKernelServer({ kernel: h.kernel, host: '127.0.0.1', port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url })
      const submit = (key: string, compute?: DockerCompute, profile: string = RUNNER_PROFILE_IDS.containerNativeGpu) => client.submitJob({ project_id: h.project.project_id, kind: 'pilot', contract_id: h.contract.contract_id, code_snapshot_id: h.code.artifact_id, image_digest: getRunnerProfile(profile)!.image, idempotency_key: key, command: ['true'], runner_profile_id: profile, compute })
      const a = await submit('2', { mode: 'nvidia', devices: ['2'] })
      const b = await submit('5', { mode: 'nvidia', devices: ['5'] })
      const c = await submit('5-2', { mode: 'nvidia', devices: ['5', '2'] })
      expect(a.payload.native_gpu_uuids).toEqual(['GPU-aaaa'])
      expect(b.payload.native_gpu_uuids).toEqual(['GPU-bbbb'])
      expect(c.payload.native_gpu_uuids).toEqual(['GPU-bbbb', 'GPU-aaaa'])
      await expect(submit('2', { mode: 'nvidia', devices: ['5'] })).rejects.toMatchObject({ code: 'idempotency_conflict' })
      expect((await submit('2', { mode: 'nvidia', devices: ['2'] })).job_id).toBe(a.job_id)
      const all = await submit('all', { mode: 'nvidia', devices: 'all' })
      expect(all.payload.native_gpu_uuids).toEqual(['GPU-aaaa', 'GPU-bbbb'])
      await expect(submit('missing')).rejects.toMatchObject({ code: 'native_gpu_selection_required' })
      for (const devices of [[], ['99'], ['2', '2'], ['-1'], ['02'], ['GPU-aaaa']]) {
        await expect(submit(JSON.stringify(devices), { mode: 'nvidia', devices })).rejects.toBeDefined()
      }
      await expect(submit('mismatch', { mode: 'cpu' })).rejects.toMatchObject({ code: 'compute_profile_mismatch' })
      const cpu = await submit('cpu', { mode: 'cpu' }, RUNNER_PROFILE_IDS.containerNativeCpu)
      expect(cpu.payload.runner_compute).toEqual({ mode: 'cpu' })
      expect(cpu.payload.native_gpu_uuids).toBeUndefined()
      h.heartbeat({ ...observed, actual_environment_hash: `sha256:${'c'.repeat(64)}`, gpu_devices: [{ index: '2', uuid: 'GPU-aaaa' }, { index: '5', uuid: 'GPU-bbbb' }, { index: '9', uuid: 'GPU-cccc' }] })
      expect((await submit('later', { mode: 'nvidia', devices: ['5'] })).payload.expected_environment_hash).toBe(a.payload.expected_environment_hash)
      expect(h.kernel.getContract(h.contract.contract_id)).toEqual(approved)
      const after = h.kernel.listRunnerTargets().find(t => t.target_id === h.target.target_id)!
      expect(after.revision).toBe(before.revision)
      expect(after.health).toBe('online')
      expect(runnerTargetConfigHash(after)).toBe(runnerTargetConfigHash(before))
      expect(h.kernel.getJob(all.job_id).payload.native_gpu_uuids).toEqual(['GPU-aaaa', 'GPU-bbbb'])
      const claimed = h.kernel.claimJobs('runner', 300, 10)
      expect(claimed.filter(j => [a.job_id, b.job_id].includes(j.job_id))).toHaveLength(2)
      expect(claimed.some(j => j.job_id === c.job_id)).toBe(false)
      const bound = claimed.find(j => j.job_id === b.job_id)!
      const plan = buildExecutionPlan(bound, { run_id: 'run_test', command: ['true'], timeout_ms: 60000, lease: { owner: 'runner', generation: bound.lease_generation, token: bound.lease_token!, expires_at: bound.lease_expires_at } })
      expect(plan.native_gpu_uuids).toEqual(['GPU-bbbb'])
      expect(plan.native_gpu_devices).toEqual([{ index: '5', uuid: 'GPU-bbbb' }])
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('rejects top-level compute on other targets and ignores forged internal payload', () => {
    const h = setup()
    const request = { project_id: h.project.project_id, kind: 'smoke' as const, idempotency_key: 'invalid', runner_target_id: 'target_local_process_v1', runner_profile_id: RUNNER_PROFILE_IDS.isolatedSubprocess, command: ['true'], compute: { mode: 'cpu' as const } }
    expect(() => h.kernel.submitJob(request)).toThrow(/only supported/)
    const job = h.kernel.submitJob({ ...request, runner_target_id: h.target.target_id, runner_profile_id: RUNNER_PROFILE_IDS.containerNativeCpu, payload: { runner_compute: { mode: 'nvidia', devices: 'all' }, native_gpu_uuids: ['GPU-ffff'] } })
    expect(job.payload.runner_compute).toEqual({ mode: 'cpu' })
    expect(job.payload.native_gpu_uuids).toBeUndefined()
  })
  it('requires a v3 observation at approval, and never silently repins an approved Contract', () => {
    const h = setup()
    h.heartbeat({ ...observed, schema_version: 1, actual_environment_hash: undefined })
    expect(() => h.kernel.approveContract(h.contract.contract_id, 'dec', 'pi')).toThrow(/v3/)
    h.heartbeat()
    const approved = h.kernel.approveContract(h.contract.contract_id, 'dec', 'pi')
    expect(approved.approval?.native_environment).toEqual({ schema_version: 2, target_id: h.target.target_id, sha256: hash })
    const job = h.submit('initial')
    expect(job.payload.expected_environment_hash).toBe(hash)
    h.heartbeat({ ...observed, software_environment_hash: `sha256:${'b'.repeat(64)}` })
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
      return h.kernel.submitJob({ project_id: h.project.project_id, kind: 'smoke', idempotency_key: id, runner_target_id: id, runner_profile_id: RUNNER_PROFILE_IDS.containerNativeGpu, command: ['true'], compute: { mode: 'nvidia', devices: [device] } })
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
    expect(next?.payload.native_gpu_uuids).toEqual(first?.payload.native_gpu_uuids)
    expect(() => h.kernel.completeJob({ job_id: first!.job_id, owner: 'one', status: 'failed', lease_generation: first!.lease_generation, lease_token: first!.lease_token })).toThrow()
    h.kernel.cancelJob(next!.job_id, 'pi')
    expect(h.kernel.claimJobs('three', 300, 8)).toHaveLength(1)
  })
})
