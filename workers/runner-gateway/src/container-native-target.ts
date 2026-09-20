import { ExecutionPlan, executionPlanFingerprint, getRunnerProfile, computeProfileConfigHash } from '@dsh-scholar/research-schemas'
import { deepFreezePlan, ExecutionPlanMutationError, ExecutionTargetError, type ExecutionTarget, type ExecutionTargetContext, type ExecutionRunHandle, type LocalRunHandle, type DockerRunFn, type CancelRunFn } from './execution-target.js'

/** Native execution is a distinct target, sharing only the process engine. */
export class ContainerNativeAdapter implements ExecutionTarget {
  readonly target_id: string
  private fingerprint: string | null = null
  constructor(private readonly deps: { targetId: string; jobId: string; nativeRun: DockerRunFn; cancel: CancelRunFn }) {
    this.target_id = deps.targetId
  }
  async prepare(plan: ExecutionPlan) {
    const parsed = ExecutionPlan.parse(plan)
    const profile = getRunnerProfile(parsed.profile_id)
    if (parsed.target_id !== this.target_id || parsed.target_kind !== 'container-native'
      || profile?.runner_mode !== 'container-native' || !profile.enabled
      || computeProfileConfigHash(profile) !== parsed.profile_config_hash
      || profile.capabilities.includes('gpu') !== (parsed.compute.mode === 'nvidia')
      || parsed.limits.cpus !== profile.limits.cpus || parsed.limits.memory_mb !== profile.limits.memory_mb || parsed.limits.pids !== profile.limits.pids
      || parsed.network.policy !== profile.network_policy) throw new ExecutionTargetError('environment: native_plan_mismatch')
    this.fingerprint = executionPlanFingerprint(parsed)
    return { target_id: this.target_id, fingerprint: this.fingerprint }
  }
  async start(plan: ExecutionPlan, context: ExecutionTargetContext = {}): Promise<LocalRunHandle> {
    plan = deepFreezePlan(ExecutionPlan.parse(plan))
    if (this.fingerprint === null || executionPlanFingerprint(ExecutionPlan.parse(plan)) !== this.fingerprint) throw new ExecutionPlanMutationError('native plan changed after prepare')
    if (context.cwd === undefined) throw new ExecutionTargetError('environment: native_snapshot_directory_required')
    const run: LocalRunHandle = {
      handle_id: `native_${plan.run_id}`, target_id: this.target_id, job_id: this.deps.jobId, run_id: plan.run_id,
      started_at: new Date().toISOString(), state: 'running',
      outcome: this.deps.nativeRun(plan, { command: plan.command, cwd: context.cwd, jobId: this.deps.jobId, runId: plan.run_id, signal: context.signal, onChunk: context.onChunk, runEnv: context.runEnv ?? {} }),
    }
    run.outcome = run.outcome.finally(() => { run.state = 'done' })
    return run
  }
  async attach(run: ExecutionRunHandle) { return { run_id: run.run_id, job_id: run.job_id, target_id: this.target_id, state: (run as LocalRunHandle).state } }
  async cancel(run: ExecutionRunHandle) { return this.deps.cancel(run.job_id) }
  async wait(run: ExecutionRunHandle) { return (run as LocalRunHandle).outcome }
  async execute(plan: ExecutionPlan, context: ExecutionTargetContext) { await this.prepare(plan); return this.wait(await this.start(plan, context)) }
}
