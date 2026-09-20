import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, startKernelServer, assessRunnerEnvironment } from '@dsh-scholar/research-kernel'
import { ResearchClient } from '@dsh-scholar/research-client'
import { collectNativeEnvironment, executeJob, signManifest } from '@dsh-scholar/runner-gateway'
import { BUILTIN_RUNNER_TARGETS, containerNativeFingerprintHash, getRunnerProfile, RUNNER_PROFILE_IDS, RunnerTargetCreateInput, RunnerProfile, runnerTargetConfigHash } from '@dsh-scholar/research-schemas'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0).reverse()) await fn() })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const profile = getRunnerProfile(RUNNER_PROFILE_IDS.containerNativeCpu)!
let observation: Awaited<ReturnType<typeof collectNativeEnvironment>>['fingerprint']
beforeAll(async () => { observation = (await collectNativeEnvironment('/tmp', { mode: 'cpu' }, profile.image)).fingerprint })
const brief = { problem: 'native', scope: 'test', questions: [], primary_metrics: ['accuracy'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' }

function setup(gpu = false) {
  const root = mkdtempSync(join(tmpdir(), 'native-kernel-'))
  const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), requireSignedManifest: true })
  cleanup.push(() => { kernel.close(); rmSync(root, { recursive: true, force: true }) })
  const target = kernel.updateRunnerTarget('target_container_native_v1', { expected_revision: 1, enabled: true, ...(gpu ? { capabilities: ['linux', 'cpu', 'container-native', 'network-inherited', 'nvidia'], native_compute: { mode: 'nvidia' as const, devices: [process.env.DSH_TEST_GPU_DEVICE ?? '0'] } } : {}) })
  kernel.observeRunnerTarget(target.target_id, { expected_revision: target.revision, health: 'online', native_observation: observation })
  const project = kernel.createProject({ name: 'native integration', workspace: root, brief, execution: { runner_target_id: target.target_id, runner_profile_id: gpu ? RUNNER_PROFILE_IDS.containerNativeGpu : profile.profile_id } })
  const keys = generateKeyPairSync('ed25519')
  kernel.registerRunnerKey({ key_id: 'native-test-key', public_key_pem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
  return { root, kernel, project, target, signingKey: { keyId: 'native-test-key', privateKey: keys.privateKey } }
}

async function clientFor(kernel: ResearchKernel) {
  const { server, url } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return new ResearchClient({ endpoint: url })
}

describe('native schema and readiness', () => {
  it('rejects SSH/Docker metadata and cross-mode profiles', () => {
    const target = BUILTIN_RUNNER_TARGETS.find(t => t.kind === 'container-native')!
    const base = { target_id: target.target_id, display_name: target.display_name, kind: target.kind, service_identity: target.service_identity }
    expect(RunnerTargetCreateInput.parse(base).kind).toBe('container-native')
    expect(() => RunnerTargetCreateInput.parse({ ...base, runtime: { image_digest: profile.image, compute: { mode: 'cpu' } } })).toThrow()
    expect(() => RunnerTargetCreateInput.parse({ ...base, connection: { endpoint: target.service_identity, credential: target.service_identity, known_hosts: target.service_identity } })).toThrow()
    expect(() => RunnerProfile.parse({ ...profile, runner_mode: 'local-docker' })).toThrow()
    for (const p of [RUNNER_PROFILE_IDS.localDockerCpu, RUNNER_PROFILE_IDS.isolatedSubprocess]) expect(assessRunnerEnvironment(getRunnerProfile(p)!, target, () => true).hardFailures).toContain('profile_target_mismatch')
    expect(assessRunnerEnvironment(profile, { ...target, kind: 'local-process' }, () => true).hardFailures).toContain('profile_target_mismatch')
  })
  it('fails disabled, draining, offline, stale and missing GPU capability', () => {
    const base = { ...BUILTIN_RUNNER_TARGETS.find(t => t.kind === 'container-native')!, enabled: true, health: 'online' as const, last_seen_at: new Date().toISOString() }
    expect(assessRunnerEnvironment(profile, base, () => true).hardFailures).toEqual([])
    for (const [patch, failure] of [[{ enabled: false }, 'target_disabled'], [{ draining: true }, 'target_draining'], [{ health: 'offline' }, 'target_offline'], [{ last_seen_at: '1970-01-01' }, 'target_unprobed']] as const) {
      expect(assessRunnerEnvironment(profile, { ...base, ...patch }, () => true).hardFailures).toContain(failure)
    }
    expect(assessRunnerEnvironment(getRunnerProfile(RUNNER_PROFILE_IDS.containerNativeGpu)!, base, () => true).hardFailures).toContain('target_capability_mismatch')
  })
})

describe('native Kernel to signed runner roundtrip', () => {
  it.each([false, ...(process.env.DSH_TEST_GPU_PYTHON ? [true] : [])])('executes approved baseline with frozen code/data and signed HTTP manifest (GPU=%s)', async gpu => {
    const { kernel, project, target, signingKey } = setup(gpu)
    const selectedProfile = getRunnerProfile(gpu ? RUNNER_PROFILE_IDS.containerNativeGpu : profile.profile_id)!
    const contract = kernel.registerContract({ project_id: project.project_id, idea_id: 'idea_native', data: { dataset_id: 'd', version: 'v1' }, methods: { baseline: 'b', treatment: 'a' }, metrics: { primary: 'accuracy', secondary: [] }, seeds: [11], analysis: {}, ablations: [], stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true } })
    kernel.approveContract(contract.contract_id, 'dec_native', 'pi')
    const script = `const fs=require('fs'); if(fs.readdirSync(process.env.DSH_DATA_DIR).length!==1)process.exit(8); fs.writeFileSync(process.env.DSH_OUTPUTS_DIR+'/metrics.json',JSON.stringify({schema_version:1,run_id:process.env.DSH_RUN_ID,contract_id:process.env.DSH_CONTRACT_ID,seed:11,metrics:[{name:'accuracy',value:0.95}]}));`
    const source = gpu ? readFileSync('tests/fixtures/native-gpu-smoke.py', 'utf8') : script
    const filename = gpu ? 'train.py' : 'train.cjs'
    const requirements = gpu ? readFileSync('tests/fixtures/native-gpu-requirements.txt', 'utf8') : ''
    const locks = gpu ? { 'requirements.txt': { sha256: sha(requirements), content_base64: Buffer.from(requirements).toString('base64') } } : {}
    const code = kernel.registerArtifact({ project_id: project.project_id, kind: 'code', content: JSON.stringify({ schema_version: 1, files: { [filename]: { sha256: sha(source), content_base64: Buffer.from(source).toString('base64') }, ...locks } }) })
    const data = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'frozen dataset' })
    const job = kernel.submitJob({ project_id: project.project_id, kind: 'baseline', idempotency_key: 'native-baseline', contract_id: contract.contract_id, code_snapshot_id: code.artifact_id, image_digest: profile.image, data_artifact_ids: [data.artifact_id], command: [gpu ? process.env.DSH_TEST_GPU_PYTHON! : process.execPath, filename], payload: { seed: 11, output_contract: { metrics: '/outputs/metrics.json' } } })
    expect(job.payload).toMatchObject({ runner_target_kind: 'container-native', runner_target_revision: target.revision, runner_target_hash: runnerTargetConfigHash(target), profile_config_hash: selectedProfile.config_hash })
    const [claimed] = kernel.claimJobs('native-owner', 300, 1)
    const client = await clientFor(kernel)
    const complete = client.completeJob.bind(client)
    vi.spyOn(client, 'completeJob').mockImplementation(async input => {
      const { signature, payload_sha256, runner_key_id, ...manifest } = input.run_manifest as Record<string, unknown>
      const environment = manifest.execution_environment as Record<string, unknown>
      await expect(complete({ ...input, run_manifest: signManifest({ ...manifest, execution_environment: { ...environment, fingerprint_hash: `sha256:${'0'.repeat(64)}` } }, signingKey) })).rejects.toMatchObject({ code: 'manifest_environment_mismatch' })
      await expect(complete({ ...input, run_manifest: signManifest({ ...manifest, container_digest: `docker:${profile.image}` }, signingKey) })).rejects.toMatchObject({ code: 'manifest_container_mismatch' })
      const original = (input.run_manifest as any).execution_environment
      const fingerprint = { ...original.fingerprint, network_isolation: 'network-namespace' as const }
      await expect(complete({ ...input, run_manifest: signManifest({ ...manifest, execution_environment: { ...original, fingerprint, fingerprint_hash: containerNativeFingerprintHash(fingerprint) } }, signingKey) })).rejects.toMatchObject({ code: 'manifest_environment_mismatch' })
      const alteredFacts = { ...original.fingerprint, os: 'different-os' }
      await expect(complete({ ...input, run_manifest: signManifest({ ...manifest, execution_environment: { ...original, fingerprint: alteredFacts, fingerprint_hash: containerNativeFingerprintHash(alteredFacts) } }, signingKey) })).rejects.toMatchObject({ code: 'manifest_environment_mismatch' })
      await expect(complete({ ...input, run_manifest: signManifest({ ...manifest, native_environment_artifact: manifest.log_artifact }, signingKey) })).rejects.toMatchObject({ code: 'manifest_environment_mismatch' })
      return complete(input)
    })
    const result = await executeJob(claimed!, { client, owner: 'native-owner', targetId: target.target_id, mode: 'container-native', signingKey })
    expect(result.job.status, result.job.error).toBe('succeeded')
    if (gpu) {
      console.log('Native real GPU:', result.run.stdout)
      expect(JSON.parse(result.run.stdout)).toMatchObject({ max_abs_error: 0, visible_devices: process.env.DSH_TEST_GPU_DEVICE ?? '0' })
      expect((result.job.run_manifest as any).execution_environment.fingerprint.dependency_lock_hash).toMatch(/^sha256:/)
    }
    expect(kernel.getJob(job.job_id).run_manifest).toMatchObject({ code_snapshot_id: code.artifact_id, container_digest: `configured:${profile.image}`, execution_environment: { kind: 'container-native' }, signature: expect.any(String) })
  })

  it('retains snapshot/contract requirements and rejects native profile on local-process', () => {
    const { kernel, project } = setup()
    expect(() => kernel.submitJob({ project_id: project.project_id, kind: 'baseline', idempotency_key: 'missing', command: ['node'], payload: {} })).toThrow(/code_snapshot/)
    expect(() => kernel.createProject({ name: 'bad', workspace: '/tmp', brief, execution: { runner_target_id: 'target_local_process_v1', runner_profile_id: profile.profile_id } })).toThrow(/profile/)
    const local = kernel.createProject({ name: 'local', workspace: '/tmp', brief, execution: { runner_target_id: 'target_local_process_v1', runner_profile_id: RUNNER_PROFILE_IDS.isolatedSubprocess } })
    expect(() => kernel.submitJob({ project_id: local.project_id, kind: 'formal', idempotency_key: 'secure', command: ['node'], payload: {} })).toThrow(/container/)
  })

  it('compiles frozen TeX via a fake engine, preserves diagnostics/artifacts and marks concurrent edits stale', async () => {
    const { kernel, root, project, target, signingKey } = setup()
    // Fixture engine only: real TeX/GPU acceptance is documented separately.
    writeFileSync(join(root, 'pdflatex'), '#!/bin/sh\ncase " $* " in *" -no-shell-escape "*) ;; *) exit 9;; esac\ngrep -q FROZEN paper.tex || exit 8\nprintf "%s" "%PDF-fixture" > paper.pdf\nprintf "%s" "LaTeX Warning: fixture" > paper.log\nprintf "%s" "frozen aux" > paper.aux\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', 'FROZEN')
    const rev = kernel.texTree(doc.document_id).document.revision
    const snapshot = kernel.texSnapshot(doc.document_id, rev)
    const job = kernel.submitJob({ project_id: project.project_id, kind: 'latex-compile', idempotency_key: 'tex-native', command: ['pdflatex'], payload: { tex_document_id: doc.document_id, tex_revision: rev, tex_snapshot: snapshot.manifest, engine: 'pdflatex' } })
    const build = kernel.texCreateBuild(doc.document_id, rev, 'paper.tex', job.job_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', 'EDITED')
    const [claimed] = kernel.claimJobs('native-owner', 300, 1)
    const result = await executeJob(claimed!, { client: await clientFor(kernel), owner: 'native-owner', targetId: target.target_id, mode: 'container-native', signingKey })
    expect(result.job.status, result.job.error).toBe('succeeded')
    expect(kernel.texGetBuild(build.build_id)).toMatchObject({ status: 'succeeded', stale: true, pdf_artifact: expect.any(String), log_artifact: expect.any(String) })
    expect(result.job.run_manifest).toMatchObject({ tex_aux_artifact: expect.stringMatching(/^sha256:/), tex_diagnostics: expect.arrayContaining([expect.objectContaining({ level: 'warning' })]) })
  })

  it('fails missing TeX engine during preflight with an environment failure', async () => {
    const { kernel, root, project, target, signingKey } = setup()
    symlinkSync('/bin/sh', join(root, 'sh'))
    vi.stubEnv('PATH', root)
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', 'FROZEN')
    const rev = kernel.texTree(doc.document_id).document.revision
    const snapshot = kernel.texSnapshot(doc.document_id, rev)
    kernel.submitJob({ project_id: project.project_id, kind: 'latex-compile', idempotency_key: 'tex-missing', command: ['pdflatex'], payload: { tex_document_id: doc.document_id, tex_revision: rev, tex_snapshot: snapshot.manifest, engine: 'pdflatex' } })
    const [claimed] = kernel.claimJobs('native-owner', 300, 1)
    const result = await executeJob(claimed!, { client: await clientFor(kernel), owner: 'native-owner', targetId: target.target_id, mode: 'container-native', signingKey })
    expect(result.job.failure_class).toBe('environment')
    expect(result.run.error).toContain('native_executable_missing')
  })
})
