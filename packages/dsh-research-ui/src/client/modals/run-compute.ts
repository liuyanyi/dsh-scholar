import { DockerCompute } from '@dsh-scholar/research-schemas/runner-environment'
import { api } from '../api'
import { el, rootHost, trapFocus } from '../ui'
import { runCompute, runComputeProfile } from '../run-compute-model'
import { t } from '../i18n/index'

type Target = { target_id: string; kind: string; last_seen_at: string | null; native_observation?: { gpu_devices: Array<{ index: string; uuid: string; name?: string }> } }

export async function selectRunCompute(projectId: string, request: Record<string, unknown> | null): Promise<{ compute?: DockerCompute; runner_profile_id?: string } | null> {
  if (request?.compute !== undefined) return {
    compute: DockerCompute.parse(request.compute),
    runner_profile_id: typeof request.runner_profile_id === 'string' ? request.runner_profile_id : undefined,
  }
  const project = await api<{ execution: { runner_target_id: string; runner_profile_id: string } }>(`/v1/projects/${encodeURIComponent(projectId)}`)
  const targets = await api<Target[]>('/v1/runner-targets')
  if (!project || !targets) throw new Error(t('runs', 'runs.compute.unavailable'))
  const target = targets.find(item => item.target_id === (request?.runner_target_id ?? project.execution.runner_target_id))
  if (target?.kind !== 'container-native') return { runner_profile_id: typeof request?.runner_profile_id === 'string' ? request.runner_profile_id : undefined }
  const root = rootHost()
  if (!root) throw new Error(t('runs', 'runs.compute.unavailable'))
  return new Promise(resolve => {
    const overlay = el('div', 'overlay')
    const modal = el('div', 'modal')
    modal.style.cssText = 'width:520px;max-width:92vw;max-height:85vh;overflow:auto'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-label', t('runs', 'runs.compute.title'))
    modal.append(el('div', 'modal-header', t('runs', 'runs.compute.title')),
      el('div', 'muted', t('runs', 'runs.compute.observed', { time: target.last_seen_at ?? t('runs', 'runs.compute.unknown') })))
    const mode = el('select', 'input')
    for (const [value, label] of [['cpu', t('runs', 'runs.compute.cpu')], ['nvidia', t('runs', 'runs.compute.gpu')]]) {
      const option = el('option', '', label); option.value = value!; mode.append(option)
    }
    mode.setAttribute('aria-label', t('runs', 'runs.compute.mode'))
    mode.value = String(request?.runner_profile_id ?? project.execution.runner_profile_id).includes('_gpu_') ? 'nvidia' : 'cpu'
    const devices = el('div')
    const selected: string[] = []
    const order = el('div', 'mono')
    const updateOrder = () => { order.textContent = selected.map((id, i) => t('runs', 'runs.compute.order', { logical: String(i), device: id })).join('; ') }
    for (const device of target.native_observation?.gpu_devices ?? []) {
      const label = el('label', 'row')
      label.style.cssText = 'gap:8px;overflow-wrap:anywhere'
      const checkbox = el('input'); checkbox.type = 'checkbox'
      checkbox.onchange = () => { if (checkbox.checked) selected.push(device.index); else selected.splice(selected.indexOf(device.index), 1); updateOrder() }
      label.append(checkbox, el('span', '', `${device.index} ${device.name ?? ''} ${device.uuid}`)); devices.append(label)
    }
    const allLabel = el('label', 'row')
    const all = el('input'); all.type = 'checkbox'
    all.onchange = () => { devices.hidden = all.checked; order.hidden = all.checked }
    allLabel.append(all, el('span', '', t('runs', 'runs.compute.all')))
    const gpu = el('div'); gpu.append(devices, order, allLabel)
    mode.onchange = () => { gpu.hidden = mode.value === 'cpu' }; gpu.hidden = mode.value === 'cpu'
    const error = el('div', 'muted')
    const actions = el('div', 'row'); actions.style.cssText = 'justify-content:flex-end;gap:8px;margin-top:12px'
    const cancel = el('button', 'hbtn', t('runs', 'runs.compute.cancel'))
    const submit = el('button', 'hbtn primary', t('runs', 'runs.compute.submit'))
    const finish = (value: { compute: DockerCompute; runner_profile_id: string } | null) => { release(); overlay.remove(); resolve(value) }
    cancel.onclick = () => finish(null)
    submit.onclick = () => {
      try {
        const compute = runCompute(mode.value as 'cpu' | 'nvidia', selected, all.checked)
        finish({ compute, runner_profile_id: runComputeProfile(String(request?.runner_profile_id ?? project.execution.runner_profile_id), compute) })
      } catch { error.textContent = t('runs', 'runs.compute.required') }
    }
    overlay.onclick = event => { if (event.target === overlay) finish(null) }
    overlay.onkeydown = event => { if (event.key === 'Escape') finish(null) }
    actions.append(cancel, submit); modal.append(mode, gpu, error, actions); overlay.append(modal); root.append(overlay)
    const release = trapFocus(overlay, null); mode.focus()
  })
}
