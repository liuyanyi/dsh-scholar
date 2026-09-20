import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResearchClient } from '@dsh-scholar/research-client'
import { buildExecutionPlan, ContainerNativeEnvironment, getRunnerProfile, RUNNER_PROFILE_IDS, RunManifest, type JobRecord } from '@dsh-scholar/research-schemas'
import { cancelRun, canonicalJson, collectNativeEnvironment, ContainerNativeAdapter, executeJob, nativeEnvironment, buildLatexRunScript } from '@dsh-scholar/runner-gateway'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const profile = getRunnerProfile(RUNNER_PROFILE_IDS.containerNativeCpu)!
const dirs: string[] = []
let expectedEnvironmentHash: string
beforeAll(async () => { expectedEnvironmentHash = (await collectNativeEnvironment('/tmp', { mode: 'cpu' }, profile.image)).fingerprint.actual_environment_hash! })
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function harness(script: string, kind: JobRecord['kind'] = 'formal') {
  const archive = JSON.stringify({ schema_version: 1, files: { 'train.cjs': { sha256: hash(script), content_base64: Buffer.from(script).toString('base64') } } })
  const job = {
    job_id: `job_${Math.random().toString(16).slice(2)}`, project_id: 'prj_native', contract_id: 'expc_native',
    kind, command: [process.execPath, 'train.cjs'], run_id: 'run_native', code_snapshot_id: `sha256:${hash(archive)}`,
    status: 'running', lease_generation: 1, lease_token: 'lease-native', lease_expires_at: new Date(Date.now() + 60000).toISOString(),
    payload: {
      runner_target_id: 'target_container_native_v1', runner_target_kind: 'container-native', runner_target_revision: 1,
      runner_target_hash: `sha256:${'1'.repeat(64)}`, runner_profile_id: profile.profile_id, profile_config_hash: profile.config_hash,
      project_config_pin: `sha256:${'2'.repeat(64)}`, image_digest: profile.image, runner_compute: { mode: 'cpu' },
      seed: 11, contract_metrics: ['accuracy'], output_contract: { metrics: '/outputs/metrics.json' }, data_artifact_ids: [],
      expected_environment_hash: expectedEnvironmentHash,
    },
  } as unknown as JobRecord
  const artifacts: Array<{ kind: string; content: string }> = []
  const client = {
    getRunnerTarget: vi.fn(async () => ({ target_id: 'target_container_native_v1', kind: 'container-native', enabled: true, draining: false, health: 'online', last_seen_at: new Date().toISOString(), revision: 1, config_hash: job.payload.runner_target_hash })),
    fetchArtifact: vi.fn(async () => archive),
    registerArtifact: vi.fn(async (input: { kind: string; content_base64: string }) => {
      const content = Buffer.from(input.content_base64, 'base64').toString()
      artifacts.push({ kind: input.kind, content })
      return { artifact_id: `sha256:${hash(content)}` }
    }),
    request: vi.fn(async () => ({})),
    completeJob: vi.fn(async (input: Record<string, unknown>) => ({ ...job, ...input })),
    getJob: vi.fn(async () => ({ ...job, status: 'cancelled' })),
  }
  const keys = generateKeyPairSync('ed25519')
  const run = (options: Record<string, unknown> = {}) => executeJob(job, {
    client: client as unknown as ResearchClient, owner: 'native-runner', targetId: 'target_container_native_v1', mode: 'container-native',
    signingKey: { keyId: 'native-key', privateKey: keys.privateKey }, ...options,
  })
  return { job, client, artifacts, keys, run }
}

const metrics = `const fs = require('node:fs'); fs.writeFileSync(process.env.DSH_OUTPUTS_DIR + '/metrics.json', JSON.stringify({schema_version:1,run_id:process.env.DSH_RUN_ID,contract_id:process.env.DSH_CONTRACT_ID,seed:Number(process.env.DSH_SEED),metrics:[{name:'accuracy',value:0.9}]})); console.log('frozen-input');`

describe('container-native actual CPU execution', () => {
  it.skipIf(process.env.DSH_TEST_NATIVE_ISOLATION !== '1')('enforces real delegated cgroup and network namespace, then removes the group', async () => {
    const parentNetwork = readlinkSync('/proc/self/ns/net')
    const before = readdirSync(process.env.DSH_NATIVE_CGROUP_ROOT!).filter(name => name.startsWith('dsh-')).sort()
    const h = harness(`const check=require('node:assert/strict'); const files=require('node:fs');
      check.notEqual(files.readlinkSync('/proc/self/ns/net'), ${JSON.stringify(parentNetwork)});
      const group=files.readFileSync('/proc/self/cgroup','utf8').trim().split('::')[1];
      const root='/sys/fs/cgroup'+group;
      check.equal(files.readFileSync(root+'/cpu.max','utf8').trim(),'100000 100000');
      check.equal(files.readFileSync(root+'/memory.max','utf8').trim(),'1073741824');
      check.equal(files.readFileSync(root+'/pids.max','utf8').trim(),'256');
      check.throws(()=>files.writeFileSync(root+'/memory.max','max'));
      check.equal(files.readFileSync('/proc/net/route','utf8').trim().split('\\n').length,1);
      ${metrics}`)
    const isolated = getRunnerProfile(RUNNER_PROFILE_IDS.containerNativeCpuIsolated)!
    Object.assign(h.job.payload, { runner_profile_id: isolated.profile_id, profile_config_hash: isolated.config_hash })
    const result = await h.run()
    expect(result.job.status, result.job.error).toBe('succeeded')
    expect((result.job.run_manifest as any).execution_environment.fingerprint).toMatchObject({ network_isolation: 'network-namespace', resource_isolation: 'cgroup-v2', enforced_limits: isolated.limits })
    expect(readdirSync(process.env.DSH_NATIVE_CGROUP_ROOT!).filter(name => name.startsWith('dsh-')).sort()).toEqual(before)
  })
  it('fails requested resource isolation before experiment code when delegation is unavailable', async () => {
    vi.stubEnv('DSH_NATIVE_CGROUP_ROOT', '')
    const h = harness(`throw new Error('EXPERIMENT_MUST_NOT_START')`)
    const isolated = getRunnerProfile(RUNNER_PROFILE_IDS.containerNativeCpuResources)!
    Object.assign(h.job.payload, { runner_profile_id: isolated.profile_id, profile_config_hash: isolated.config_hash })
    const result = await h.run()
    expect(result.job.failure_class).toBe('environment')
    expect(result.run.error).toContain('native_isolation_unavailable')
    expect(result.run.stderr).not.toContain('EXPERIMENT_MUST_NOT_START')
    expect(result.job.status).toBe('failed')
  })
  it.each(['baseline', 'pilot', 'formal', 'reproduce'] as const)('executes %s with metrics, logs and signed environment provenance', async kind => {
    const h = harness(metrics, kind)
    const result = await h.run()
    expect(result.job.status, result.job.error).toBe('succeeded')
    expect(result.run.stdout).toContain('frozen-input')
    expect(h.artifacts.map(a => a.kind)).toEqual(['manifest', 'log', 'analysis'])
    const manifest = result.job.run_manifest as Record<string, unknown>
    expect(manifest.container_digest).toBe(`configured:${profile.image}`)
    expect(ContainerNativeEnvironment.safeParse(manifest.execution_environment).success).toBe(true)
    expect(RunManifest.parse(manifest).native_environment_artifact).toBe(manifest.native_environment_artifact)
    expect(RunManifest.parse(manifest).execution_environment).toEqual(manifest.execution_environment)
    const { signature, ...signed } = manifest
    expect(verify(null, Buffer.from(canonicalJson(signed)), h.keys.publicKey, Buffer.from(signature as string, 'base64'))).toBe(true)
    expect(h.client.request).toHaveBeenCalled()
  })

  it('does not leak service/provider/Codex credentials or ambient NODE_OPTIONS', async () => {
    for (const name of ['DSH_SCHOLAR_SERVICE_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'SSH_AUTH_SOCK', 'NODE_OPTIONS']) vi.stubEnv(name, 'SECRET_SENTINEL')
    const h = harness(`console.log(JSON.stringify(process.env)); ${metrics}`)
    const result = await h.run()
    expect(result.job.status).toBe('succeeded')
    expect(result.run.stdout).not.toContain('SECRET_SENTINEL')
    expect(result.run.stdout).toContain('CUDA_VISIBLE_DEVICES')
  })

  it('rejects snapshot tampering before any process or artifact upload', async () => {
    const h = harness(metrics)
    h.client.fetchArtifact.mockResolvedValue('{}')
    const result = await h.run()
    expect(result.job.failure_class).toBe('environment')
    expect(result.run.error).toContain('snapshot_hash_mismatch')
    expect(h.client.registerArtifact).not.toHaveBeenCalled()
  })

  it('keeps frozen input when the source working tree changes during execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-working-')); dirs.push(dir)
    writeFileSync(join(dir, 'train.cjs'), 'throw new Error("live tree")')
    const h = harness(`setTimeout(() => { ${metrics} }, 80)`)
    const running = h.run()
    writeFileSync(join(dir, 'train.cjs'), 'process.exit(12)')
    expect((await running).job.status).toBe('succeeded')
  })

  it('fails command errors and invalid metrics', async () => {
    expect((await harness('process.exit(7)').run()).run.exit_code).toBe(7)
    const result = await harness('console.log("no metrics")').run()
    expect(result.job.status).toBe('failed')
    expect(result.job.failure_class).toBe('code_error')
  })

  it('enforces timeout and log limit', async () => {
    expect((await harness('setInterval(()=>{},1000)').run({ timeoutMs: 40 })).run.error).toMatch(/timed out/)
    expect((await harness('console.log("x".repeat(100000))').run({ maxLogBytes: 100 })).run.error).toMatch(/maxBuffer/)
  })

  it('handles pre-aborted signals and explicit process-group cancellation', async () => {
    const ac = new AbortController(); ac.abort()
    expect((await harness('setInterval(()=>{},1000)').run({ signal: ac.signal })).run.error).toMatch(/cancelled/)
    const h = harness('console.log("ready"); setInterval(()=>{},1000)')
    const result = h.run()
    await vi.waitFor(() => expect(h.client.request).toHaveBeenCalled(), { timeout: 10000 })
    expect(cancelRun(h.job.job_id)).toBe(true)
    expect((await result).job.status).toBe('cancelled')
  })

  it('fails missing executable as environment and refuses changed target pins', async () => {
    const h = harness(metrics); h.job.command = ['dsh-nonexistent-executable']
    expect((await h.run()).job.failure_class).toBe('environment')
    const changed = harness(metrics)
    changed.client.getRunnerTarget.mockImplementation(async () => ({ target_id: 'target_container_native_v1', kind: 'container-native', enabled: true, draining: false, health: 'online', last_seen_at: new Date().toISOString(), revision: 2, config_hash: String(changed.job.payload.runner_target_hash) }))
    expect((await changed.run()).job.failure_class).toBe('environment')
    expect(changed.client.fetchArtifact).not.toHaveBeenCalled()
  })

  it('binds prepared plan and refuses Docker/profile substitution', async () => {
    const h = harness(metrics)
    const plan = buildExecutionPlan(h.job, { run_id: 'run_native', lease: { owner: 'r', generation: 1, token: 't', expires_at: null }, timeout_ms: 100 })
    const adapter = new ContainerNativeAdapter({ targetId: plan.target_id, jobId: plan.job_id, nativeRun: vi.fn(), cancel: () => false })
    await expect(adapter.prepare({ ...plan, target_kind: 'local-process' })).rejects.toThrow()
    await adapter.prepare(plan)
    await expect(adapter.start({ ...plan, command: ['evil'] }, { cwd: '/tmp' })).rejects.toThrow(/changed/)
  })
})

describe('native GPU and environment observations', () => {
  it('blocks a drifted environment before executing frozen code', async () => {
    const h = harness(metrics)
    h.job.payload.expected_environment_hash = `sha256:${'f'.repeat(64)}`
    const result = await h.run()
    expect(result.job.failure_class).toBe('environment')
    expect(result.run.error).toContain('environment_changed')
    expect(result.run.stdout).toBe('')
  })
  it('records unknown versions honestly and computes stable hashes without paths/secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-env-')); dirs.push(dir)
    writeFileSync(join(dir, 'uv.lock'), 'locked')
    const a = await collectNativeEnvironment(dir, { mode: 'cpu' }, profile.image, { OPENAI_API_KEY: 'secret' }, async () => null)
    const b = await collectNativeEnvironment(dir, { mode: 'cpu' }, profile.image, {}, async () => null)
    expect(a).toEqual(b)
    expect(a.fingerprint.python_version).toBeNull()
    expect(JSON.stringify(a)).not.toContain(dir)
    expect(a.fingerprint.network_isolation).toBe('not-enforced')
  })
  it('validates devices against observed GPUs and parent visibility (mocked NVIDIA)', async () => {
    const probe = async (cmd: string) => cmd === 'nvidia-smi' ? '0, GPU-aaaa-bbbb, 570.1\n1, GPU-cccc-dddd, 570.1' : null
    await expect(collectNativeEnvironment('/tmp', { mode: 'nvidia', devices: ['2'] }, profile.image, {}, probe)).rejects.toThrow('native_gpu_unavailable')
    await expect(collectNativeEnvironment('/tmp', { mode: 'nvidia', devices: ['1'] }, profile.image, { CUDA_VISIBLE_DEVICES: '0' }, probe)).rejects.toThrow()
    expect((await collectNativeEnvironment('/tmp', { mode: 'nvidia', devices: 'all' }, profile.image, {}, probe)).fingerprint.gpu_devices).toHaveLength(2)
    expect(nativeEnvironment('/tmp', { mode: 'nvidia', devices: ['1'] }, {}).CUDA_VISIBLE_DEVICES).toBe('1')
  })
})

describe('native TeX', () => {
  it('uses frozen paths, bounded passes and no shell escape', () => {
    const script = buildLatexRunScript('paper.tex', 'pdflatex', ['paper.tex', 'sections/a.tex'], true)
    expect(script.match(/-no-shell-escape/g)).toHaveLength(3)
    expect(script).toContain('$DSH_WORK_DIR/sections/a.tex')
    expect(script).toContain('OUT="$DSH_OUTPUTS_DIR"')
    expect(() => buildLatexRunScript('paper;evil.tex', 'pdflatex', [], true)).toThrow()
  })
})
