# Container Native Runner 实现计划

实现记录和部署说明见 [当前科研容器 Runner](container-native-runner.md)。默认通过显式 `network_policy=inherited` 表达父容器网络；2026-09-20 按追加需求提供可选 cgroup v2、断网及组合 Profile，默认行为保持兼容。Manifest 使用 `configured:` image pin 与签名环境指纹。真实 GPU 小规模计算和 baseline 签名链路已通过，硬隔离受宿主权限限制尚待成功路径验收，见 [验收记录](container-native-validation.md)。本轮不处理 TeX 和发布流程。

后续审查补强见 [Native 环境 Pin 与 GPU 租约](container-native-drift-guard.md)：实际 Python inventory、Contract 审批环境 pin、ExecutionPlan expected hash 和 GPU UUID 排他已接入原流程；不把环境记录等同于完整不可变文件系统。

## 1. 目标

本阶段为 DSH Scholar 增加一种正式执行模式：

```text
container-native
```

它表示：

> DSH Scholar 已经运行在一个受控的 GPU Research Container 中，正式实验与 LaTeX 编译直接在当前容器内执行，不再创建第二层 Docker Container。

该模式不是现有 `local-process` 的重命名，也不能通过放宽 `local-process` 的限制实现。

当前目标是：

- 保留 DSH Scholar 的正式实验治理模型；
- 保留 Snapshot、ExecutionPlan、RunManifest、Artifact、Evidence、Claim；
- 让 baseline / pilot / formal / reproduce / latex-compile 可以直接在当前容器执行；
- 继续保留现有 `local-docker` 与 `remote-ssh` 路径；
- 不在本阶段处理 Codex Provider 或 Agent Harness。

## 2. 当前问题

上游 DSH Scholar 的正式执行环境以“任务再进入一个 digest-pinned 容器”为基本假设。

当前主要模型为：

```text
RunnerTargetKind
├── local-process
├── local-docker
└── remote-ssh

RunnerProfileMode
├── local-docker
└── isolated-subprocess
```

其中：

- `local-process` 只允许 trusted development / smoke；
- secure kinds 使用 `isolated-subprocess` 会被 Kernel 以 `container_execution_required` 拒绝；
- formal / reproduce / latex-compile 等路径依赖 container image、compute 与 RunnerProfile pin；
- LaTeX build 同样通过固定 TeX Live image 执行。

我们的部署方式不同：

```text
GPU Host
  ↓
长期 Research Container
  ├── DSH
  ├── DSH Scholar
  ├── Python / uv
  ├── CUDA / NVIDIA GPU
  ├── Git
  ├── LaTeX
  └── /workspace/project
```

因此再创建第二层容器既没有必要，也可能因为 Docker socket 不存在、Docker-in-Docker 未配置或安全策略受限而无法运行。

## 3. 设计原则

### 3.1 Container Native 是正式执行目标

新增：

```text
RunnerTargetKind += container-native
RunnerProfileMode += container-native
```

语义为：

> 当前 DSH Scholar 所在的 Research Container 是正式、受控、可追溯的执行环境。

它必须允许 secure kinds。

### 3.2 不复用 local-process

不得：

- 把 `container-native` 映射成 `local-process`；
- 删除 `isolated-subprocess` 的 trusted-smoke 限制；
- 为了跑通正式实验而绕过 `container_execution_required`；
- 让普通宿主进程执行自动获得 formal 资格。

`local-process` 原行为保持不变。

### 3.3 不破坏科研追溯链

Container Native 只改变“程序最终在哪里执行”。

以下流程保持原有语义：

```text
Experiment Contract
  ↓
Code / Data Snapshot
  ↓
Job
  ↓
ExecutionPlan
  ↓
Runner
  ↓
Metrics / Artifacts
  ↓
RunManifest
  ↓
Evidence
  ↓
Claim
```

不得把正式实验退化成普通 shell command。

### 3.4 第一阶段优先兼容，不大改 ExecutionPlan

当前 `ExecutionPlan`、remote runner 和 RunManifest 已经围绕 image/compute pin 建立了大量校验和测试。

第一阶段不建议全面重构成新的 ExecutionEnvironment discriminated union。

优先策略：

- 增加 `container-native` target/profile；
- 保留现有 `ExecutionPlan.image` 与 `compute` 字段，以减少破坏面；
- 对 container-native 增加明确的 environment provenance；
- 后续如果证明 image 字段在 container-native 下语义长期不合理，再单独设计 ExecutionPlan v2。

不要在本阶段为了“架构更漂亮”重写 local/remote ExecutionPlan。

## 4. 数据模型改动

### 4.1 RunnerTargetKind

文件：

```text
packages/research-schemas/src/runner-target.ts
```

由：

```ts
local-process | local-docker | remote-ssh
```

扩展为：

```ts
local-process | local-docker | container-native | remote-ssh
```

Container Native：

- 不需要 remote connection；
- 不携带 SSH SecretRef；
- 不要求 Docker runtime metadata；
- 可以声明 `linux`、`nvidia`、`gpu`、`container-native` 等 capability。

建议增加 builtin target：

```text
target_container_native_v1
```

显示名建议：

```text
Current Research Container
```

是否默认 enabled 可由实现阶段结合安装环境决定；不应覆盖现有 `local-docker` 默认 target。

### 4.2 RunnerProfileMode

文件：

```text
packages/research-schemas/src/runner-profile.ts
```

新增：

```text
container-native
```

建议增加两个 profile：

```text
profile_container_native_cpu_v1
profile_container_native_gpu_v1
```

GPU profile 明确要求 target 具有 NVIDIA/GPU capability。

Container Native Profile 仍保留：

- limits；
- network policy；
- capability；
- config hash；
- enabled；
- opaque profile id。

### 4.3 Profile 与 Target 兼容关系

文件：

```text
packages/research-kernel/src/runner-environment-readiness.ts
```

需要形成明确矩阵：

| RunnerProfileMode | 合法 Target |
| --- | --- |
| isolated-subprocess | local-process |
| local-docker | local-docker / 当前已有合法 remote container 路径 |
| container-native | container-native |

不得允许：

```text
container-native profile → local-process
```

也不得静默 fallback。

GPU profile 与 target capability 不匹配时继续 hard fail。

## 5. 数据库迁移

当前 `runner_targets.kind` 有数据库 CHECK：

```sql
CHECK (
  kind IN (
    'local-process',
    'local-docker',
    'remote-ssh'
  )
)
```

因此新增 enum 不足以完成升级。

需要新增 migration：

1. 创建允许 `container-native` 的新 `runner_targets` 表；
2. 保留所有已有字段、revision、identity、runtime、connection 等数据；
3. 将旧表数据完整迁移；
4. 重建索引；
5. 插入 builtin container-native target 时使用幂等策略；
6. 更新 `SCHEMA_VERSION`；
7. 更新 migration checksum / storage migration 文档；
8. 增加旧数据库升级测试。

要求：

- 已有 local-process/local-docker/remote-ssh 行逐条保持；
- 不能在 migration 中自动把旧 local-process 改成 container-native；
- migration 可重复打开数据库，不产生重复 builtin target。

涉及文件至少包括：

```text
packages/research-kernel/src/migrations.ts
packages/research-kernel/src/runner-target-registry.ts
docs/storage-migrations.md
tests/unit/migrations.test.ts
tests/unit/runner-target-registry.test.ts
```

## 6. ExecutionPlan

文件：

```text
packages/research-schemas/src/execution-target.ts
```

第一阶段继续使用现有 ExecutionPlan schema，并加入 `container-native` target kind。

### 6.1 Image 字段处理

现有 secure Job 强制：

```text
image.digest = repository@sha256:...
```

Container Native 不再使用该 image 创建子容器，但第一阶段为了兼容 plan hash、Job pin、remote/local 共用 manifest 与已有测试，不直接删除该字段。

实现时应明确区分：

- `image.digest`：Scholar 配置与执行计划的环境 pin 之一；
- `container-native`：不会执行 `docker run <image.digest>`。

必须避免在代码和文档中声称“Container Native 实际运行于该 digest 对应的子容器”。

如果当前运行容器镜像身份可通过环境变量或部署元数据得到，可额外记录 observed runtime identity；得不到时允许明确记录 unknown，而不是伪造。

### 6.2 Environment Fingerprint

Container Native 正式运行必须生成环境指纹。

第一版建议新增一个独立、可版本化结构，例如：

```ts
{
  schema_version: 1,
  execution_kind: 'container-native',
  os: ...,
  arch: ...,
  node_version: ...,
  python_version: ...,
  cuda_version: ...,
  nvidia_driver_version: ...,
  gpu_devices: [...],
  dependency_lock_hash: ...,
  container_image_identity: string | null
}
```

具体字段允许在实现前根据当前 Runner 结构调整，但需要满足：

- 只记录可观测事实；
- 获取失败不伪造；
- 环境指纹参与 RunManifest / Artifact provenance；
- 不包含 secret；
- 不记录无关宿主路径；
- hash 计算确定性。

建议将采集逻辑放在 runner-gateway 独立模块中，不散落在 Kernel。

## 7. ContainerNativeAdapter

主要位置：

```text
workers/runner-gateway/src/
```

新增正式 Adapter，例如：

```text
container-native-target.ts
```

或在现有 ExecutionTarget port 下新增：

```text
ContainerNativeAdapter
```

### 7.1 执行准备

对每个 Job：

1. 校验 ExecutionPlan；
2. 校验 target/profile pin；
3. 创建全新临时工作目录；
4. 从现有 CAS/Snapshot 路径物化冻结 CodeSnapshot；
5. 验证 hash；
6. 物化数据/TeX 输入；
7. 构造经过限制的 environment；
8. 在临时目录内执行 command。

不能直接在用户当前 working tree 上执行 formal Job。

Agent 平时修改：

```text
/workspace/project
```

正式执行仍应该使用：

```text
frozen snapshot
→ temp execution directory
```

确保实验运行期间用户继续编辑项目不会改变当前 Run 输入。

### 7.2 进程执行

使用受控 `spawn` / `execFile`，禁止：

```text
shell: true
```

除非现有 Runner 某个经过安全审计的固定脚本路径必须使用，并且保持原有约束。

需要支持：

- timeout；
- AbortSignal/cancel；
- stdout/stderr streaming；
- max log bytes；
- exit code；
- signal；
- fresh process group；
- 子进程回收。

### 7.3 环境变量

Container Native 不应直接继承整个 DSH 进程环境。

需要定义 allowlist / denylist。

至少避免向实验进程泄露：

- DSH service token；
- Scholar internal token；
- Provider credential；
- Codex credential；
- SSH private key；
- 其他 Agent API Key（除非某个实验 Contract 明确允许且已有受控 secret 机制）。

CUDA/NVIDIA 相关变量、PATH、必要 Python 环境等可按部署场景保留。

### 7.4 GPU

GPU profile：

- target 必须声明 NVIDIA/GPU capability；
- 启动前采集 GPU readiness；
- `devices=all` 时使用当前容器可见设备集合；
- 指定 device 时校验设备存在；
- 不通过 Docker `--gpus` 控制设备。

如需约束单次实验可见 GPU，可以通过受控：

```text
CUDA_VISIBLE_DEVICES
```

实现，但必须由 typed compute 配置产生，而不是允许用户注入任意环境字符串。

### 7.5 网络

现有 profile 的 `network_policy` 只有 `none`，Docker 路径可以通过 `--network none` 实现。

Container Native 无法天然修改父容器网络 namespace。

因此本阶段不能假装 `network_policy=none` 已被技术强制。

必须显式处理：

方案优先级建议：

1. 若当前容器可通过受控工具创建无网络 namespace，使用真正隔离；
2. 若不能，Container Native Target 明确声明 network isolation capability 不可用，并由 readiness/policy 决定哪些 Job 可运行；
3. 禁止“字段仍写 none，但实际完全联网且无任何说明”。

第一版如果无法可靠实现 per-job network isolation，可以将其列为已知能力差异，但必须在 RunManifest / environment provenance 中反映实际状态。

不要因为此问题恢复 Docker-in-Docker 作为强制方案。

## 8. Formal Job 支持范围

Container Native 至少需要支持：

```text
baseline
pilot
formal
reproduce
latex-compile
```

`analysis` 如果当前由 deterministic worker 而非通用 Runner 执行，应保持现状，不为了统一形式强行改道。

`smoke` 可以继续保留现有 local-process fixture，也可以允许 container-native，但不能改变原测试语义。

## 9. Metrics、Artifacts 与 RunManifest

现有流程必须复用。

不要为 Container Native 新建另一套：

- metrics parser；
- artifact upload；
- manifest signer；
- Evidence parser。

继续使用现有：

```text
MetricsFileV1
Artifact
buildRunManifest
signManifest
completeJob
```

### 9.1 RunManifest

当前 `RunManifestInput` 使用：

```text
container_digest
compute
```

第一阶段建议最小扩展：

- 保留 `container_digest` 以兼容既有消费者；
- 新增清晰的 `execution_environment` 或等价字段，记录：
  - `kind=container-native`
  - environment fingerprint / hash
  - observed network isolation
  - observed accelerator

如果 schema/消费者不允许直接加字段，则先将环境指纹作为一个正式 Artifact，并在 manifest 中增加稳定引用。

不得把一个未实际启动的子容器镜像写成“本次实验 container digest”的事实。

## 10. LaTeX Compile

当前 `latex-compile` 同样要求固定 TeX Live Docker image。

Container Native 模式下改为：

```text
Frozen TexWorkspaceSnapshot
        ↓
ContainerNativeAdapter
        ↓
fresh temp dir
        ↓
当前容器中的 pdflatex / xelatex / lualatex / bibtex / biber
        ↓
PDF / log / aux / bbl / blg / fls
        ↓
Artifacts / RunManifest
```

保留：

- frozen revision；
- hash verification；
- 最多构建轮数；
- diagnostics；
- stale PDF 判定；
- no shell escape；
- shell metacharacter/path validation；
- terminal streaming；
- authoritative build 与 preview build 区分。

### 10.1 TeX 安全

即使当前容器受信任，也继续使用：

```text
-no-shell-escape
```

并保持 path 校验。

网络隔离问题与实验相同，必须记录真实执行能力，不能仅沿用 Docker 文案。

如果 TeX 工具缺失，应在 readiness/preflight 阶段明确失败，而不是运行到一半才给模糊环境错误。

## 11. PTY / Interactive Terminal

本阶段不要求把 Scholar 的 Interactive PTY 重写成 Container Native Runner。

PTY 是交互开发面，不是正式 Evidence/Run。

已有：

```text
LocalPtyAdapter
```

可以继续工作。

需要做的只有：

- 类型层不要因为新增 RunnerTargetKind 而破坏 PTY；
- 如果 PTY context schema 必须认识 `container-native` target，则补 enum 与测试；
- 不把 PTY 输出自动升级为 Metrics/Evidence。

## 12. UI / Settings

Scholar Settings 中新增 Current Research Container。

至少显示：

- Target kind：Container Native；
- enabled/draining；
- observed health；
- CPU/GPU capability；
- GPU devices；
- runtime/environment fingerprint 摘要；
- network isolation 状态；
- 当前绑定的 profile。

推荐文案：

```text
当前科研容器
在 DSH Scholar 所在的当前容器内直接运行正式实验，不创建嵌套 Docker 容器。
```

UI 不暴露任意 command、host path 或环境变量注入输入框。

## 13. Readiness / Preflight

Container Native Target 在执行 formal Job 前至少检查：

- target enabled；
- target 不在 draining；
- runner online；
- profile/target mode 匹配；
- snapshot 可物化；
- command 合法；
- Python/实验 executable 可启动；
- GPU profile 下 NVIDIA runtime 可用；
- 指定 GPU 存在；
- latex-compile 下要求的 TeX engine 存在；
- 环境指纹可以生成；
- 输出目录可写。

readiness 失败应使用稳定的 environment failure class，不进入实际执行。

## 14. 测试计划

### 14.1 Schema

补充：

```text
runner-target.test
runner-profile.test
execution-target.test
```

验证：

- container-native 能正确 parse；
- connection/runtime 非法组合拒绝；
- target/profile 兼容矩阵；
- GPU capability；
- config hash 稳定。

### 14.2 Migration

验证：

- 旧数据库升级成功；
- 三种旧 target 全保留；
- 新 kind CHECK 生效；
- builtin container-native target 幂等；
- revision/hash 不被错误改变。

### 14.3 Kernel

验证：

- secure Job 可以使用 container-native profile；
- secure Job 仍拒绝 isolated-subprocess；
- profile/target mismatch 422；
- GPU capability mismatch 失败；
- disabled/draining/offline 失败；
- Job pin 包含正确 target/profile revision/hash。

### 14.4 Runner

至少增加：

- baseline 正常执行；
- formal 正常执行；
- command failure；
- timeout；
- cancel；
- log limit；
- snapshot 在运行期间保持冻结；
- metrics 校验；
- artifact 收集；
- manifest 签名；
- env secret 不泄漏；
- GPU readiness；
- GPU device 约束。

### 14.5 TeX

增加：

- container-native compile 成功；
- 缺 TeX executable preflight 失败；
- `-no-shell-escape` 继续生效；
- frozen revision；
- concurrent edit → stale，而非污染当前 build；
- diagnostics；
- PDF/log artifact。

### 14.6 回归

现有以下路径必须不受影响：

- local-process trusted smoke；
- local-docker；
- remote-ssh；
- existing Docker E2E；
- RunnerTarget registry；
- release bundle；
- Evidence；
- clean-room 现有逻辑。

不要为了让新测试通过删除旧 Docker E2E。

## 15. 真实 GPU 验收

自动测试完成后，需要在实际部署容器进行一次人工验收。

建议最小场景：

1. Scholar 运行在 NVIDIA GPU 容器；
2. Settings 识别 Current Research Container；
3. 创建一个最小 Experiment Contract；
4. frozen snapshot；
5. 使用 GPU profile 执行一个 PyTorch/CUDA 小程序；
6. 输出标准 MetricsFile；
7. Job → Run 成功；
8. 生成 RunManifest；
9. Artifact 可查看；
10. Evidence 可以继续走现有流程；
11. 同一容器完成一次 LaTeX compile。

此项在真实环境完成前，文档只能标为：

```text
已实现，真实 GPU 环境待验收
```

不能仅凭 mocked NVIDIA 测试宣称完成。

## 16. 实现时明确禁止的改动

Codex 本轮不得：

- 修改 Scholar State Machine；
- 修改 Human Gate 语义；
- 降低 Evidence / Claim 要求；
- 把 local-process 改成正式 Runner；
- 删除 local-docker；
- 删除 remote-ssh；
- 删除 Docker E2E；
- 重构整套 ExecutionPlan；
- 在同一任务中接入 Codex Provider；
- 增加 DeepSeek/vLLM 专用 Scholar Provider；
- 将 formal Job 直接在用户 working tree 执行；
- 让实验进程继承全部 DSH/模型 credential 环境；
- 用“当前容器本身已经隔离”作为跳过 provenance、snapshot 或 manifest 的理由。

## 17. 建议实现顺序

### Step 1：只改类型和迁移

完成：

- RunnerTargetKind；
- RunnerProfileMode；
- builtin target/profile；
- migration；
- registry/readiness；
- 单元测试。

此阶段不执行真正 Job。

### Step 2：Container Native Adapter

完成：

- snapshot materialization；
- temp execution root；
- process spawn；
- log/timeout/cancel；
- metrics/artifacts；
- RunManifest；
- environment fingerprint。

先跑 CPU。

### Step 3：GPU

完成：

- NVIDIA detection；
- compute/device mapping；
- GPU preflight；
- GPU manifest/provenance。

### Step 4：LaTeX

将 latex-compile 接入相同 adapter。

### Step 5：UI 与文档

完成：

- Settings；
- i18n；
- acceptance docs；
- manual acceptance。

### Step 6：真实环境验收

在实际 GPU Research Container 跑一遍完整链路。

## 18. 完成标准

第一阶段完成的定义是：

> DSH Scholar 在不依赖 Docker-in-Docker 的情况下，可以把当前 GPU Research Container 作为正式 Execution Target，完成受控、可追溯的正式实验和 LaTeX 编译；已有 local-docker/remote-ssh 能力保持兼容；Experiment Contract、Snapshot、RunManifest、Artifact、Evidence 和 Claim 链没有被削弱。

在达到这一标准之前，不进入 Codex Provider 集成阶段。
