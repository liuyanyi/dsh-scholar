# 当前科研容器 Runner

本功能按 [实现计划](container-native-runner-plan.md) 接入现有 Research Workflow。`container-native` 是正式 Target/Profile，不是 `local-process` 的别名；不涉及 Codex Provider。

## 启用

1. 在长期科研容器安装项目所需 executable、Python/CUDA 依赖及 TeX 工具链。Runner 不安装依赖，也不启动 Docker。
2. 在 Kernel 的 `secretRoot/runner-targets/target_container_native_v1.token` 配置目标身份令牌，文件权限为 `0600`。沿用现有 Kernel bearer、service token、Runner signing key 注册机制。
3. 在 Scholar Settings 启用「当前科研容器」。内置 `target_container_native_v1` 默认禁用，不替换既有 Docker 默认目标。
4. CPU 使用 `profile_container_native_cpu_v1`；GPU 使用 `profile_container_native_gpu_v1`，Target 需要 `nvidia` capability。`native_compute` 为 `{ "mode": "cpu" }` 或 `{ "mode": "nvidia", "devices": "all" }` / 数字设备 ID 数组。Settings 提供 CPU/NVIDIA 和设备选择，不接受任意 env、host path 或命令注入。
5. 启动 Runner，提供与现有部署相同的鉴权环境变量：

```sh
pnpm runner --mode container-native --target-id target_container_native_v1 --kernel http://127.0.0.1:7412
```

身份变量包括 `DSH_SCHOLAR_KERNEL_TOKEN`、`DSH_SCHOLAR_SERVICE_TOKEN`、`DSH_SCHOLAR_RUNNER_TARGET_TOKEN`；它们不会传给实验子进程。生产应沿用 `--key-file` 持久化签名密钥。目标获得新鲜的认证 heartbeat 后才能提交任务。修改 Target 配置会递增 revision 并清空 health，须重新 heartbeat。

Project 选择该 Target 后默认绑定 CPU/GPU native profile；可以通过原有 `execution.runner_profile_id` 设置切换。native profile 只能绑定 native Target；Docker profile 仍只绑定 local-docker/remote-ssh；isolated-subprocess 仍只能用于 local-process trusted smoke。

## 输入与输出

baseline/pilot/formal/reproduce 保持 approved Contract、冻结代码/数据快照、image pin、Protocol（适用时）、预算和 Gate 校验。Runner 在全新临时目录物化 CAS 输入，校验代码 archive、文件和数据 hash，不从用户工作树读取正式输入。

- 工作目录为冻结代码根。
- `DSH_OUTPUTS_DIR` 指向本次 Run 输出目录；代码应向其写入标准 MetricsFileV1。output contract 继续使用 `metrics.json` 或 `/outputs/metrics.json`。
- `DSH_DATA_DIR` 包含冻结 data artifacts，文件名为 artifact ID 去掉 `sha256:` 后的 hash。
- `DSH_RUN_ID`、`DSH_CONTRACT_ID`、`DSH_SEED` 与原有 provenance 规则一致。
- 不把 Docker 专用绝对路径 `/work`、`/outputs` 自动替换为宿主路径；native 实验使用上述变量或相对路径。
- deterministic analysis worker 保持原路径；交互 PTY 使用现有 LocalPtyAdapter，输出不自动成为 Evidence。

进程使用 argv spawn、独立进程组，支持实时 stdout/stderr、退出 signal、超时、日志限额和取消；终止时回收同组子进程。环境仅继承 PATH、locale、必要 Python/CUDA 动态库配置，过滤 Provider、Scholar、Codex、SSH 凭据及 NODE_OPTIONS/PYTHONPATH 等隐式加载入口。

## 环境与隔离事实

默认 native profile 的 `network_policy=inherited` 显式继承父容器网络，Target 必须声明 `network-inherited`。新增以下可选 Profile，通过原有 `execution.runner_profile_id` 选择；`<compute>` 替换为 `cpu` 或 `gpu`：

| Profile | 网络 | CPU / 内存 / PID |
| --- | --- | --- |
| `profile_container_native_<compute>_v1` | 继承 | 父容器边界 |
| `profile_container_native_<compute>_resources_v1` | 继承 | 每任务 cgroup v2 |
| `profile_container_native_<compute>_offline_v1` | 独立 network namespace，无外网 | 父容器边界 |
| `profile_container_native_<compute>_isolated_v1` | 独立 network namespace，无外网 | 每任务 cgroup v2 |

所有模式均保留超时、日志限额和取消。资源 Profile 固定为 1 CPU、1024 MiB 内存、256 PID，写入 `cpu.max`、`memory.max`、`pids.max`，同时禁用该任务 swap 并启用组 OOM。CPU 是调度配额，不是专属 CPU 核；内存上限不包含 GPU 显存。Profile/hash 与 ExecutionPlan 的 limits 必须一致。

隔离模式要求 Linux 和 `/usr/bin/bwrap`，父容器允许 bubblewrap 所需的 mount/PID/IPC/UTS namespace；断网额外要求 network namespace。资源模式还要求部署者提供可写的 cgroup v2 委派目录，通过 Runner 服务环境 `DSH_NATIVE_CGROUP_ROOT=/sys/fs/cgroup/<delegated-directory>` 指定。父目录需预先启用 `cpu memory pids` 控制器，支持 `memory.swap.max` 和 `cgroup.kill`；Runner 不修改父容器配额、不自动提权，也不把此路径传给实验环境或接受 Job 指定路径。隔离的实际可用性由每次启动 preflight 确认，Target online 不代表具备 namespace/cgroup 权限。

每次 Run 创建独立 cgroup，先加入再 exec，避免先运行后附加的竞态。bubblewrap 将根文件系统只读挂载、仅本次工作目录可写，挂载独立 proc，去除 capabilities，并在父进程退出时结束沙箱；这也阻止实验通过 cgroup 文件解除配额。结束、失败、取消和超时均回收 cgroup 内残留进程并删除目录。先使用相同启动器运行 `true` 做 preflight；不可用即 environment 失败，绝不静默退回继承模式。Runner 本身被 SIGKILL 或宿主崩溃后的空 cgroup 目录需由部署维护清理。

这些模式不是不可信代码的完整保密沙箱：容器其他可读文件仍可见，`/dev` 供 GPU 使用；独立 network namespace 不阻断通过文件系统路径访问的 Unix socket。凭据仍应放在实验用户不可读的位置。默认模式保持原有文件系统访问行为。

GPU 启动前查询 `nvidia-smi`，验证当前可见设备与 typed selector；使用 `CUDA_VISIBLE_DEVICES` 限制实验可见设备，不使用 Docker `--gpus`，也不把该变量宣称为硬件隔离。无可用设备或指定设备不在父容器可见集合时，以 environment 类失败结束。

每次实际执行前采集版本化 fingerprint：OS/架构、Node/Python、CUDA toolkit/驱动、GPU ID、冻结依赖锁 hash、compute，以及实际网络/资源隔离状态。未知版本或镜像身份记录 `null`；不采集完整 env、无关宿主路径或 secret。部署可通过 `DSH_RESEARCH_CONTAINER_IMAGE=repository@sha256:...` 提供当前容器镜像身份，这是部署声明，Runner 不通过 Docker 验证。

`ExecutionPlan.image.digest` 保留为配置 pin。native Manifest 的 `container_digest=configured:<digest>`，不会声称运行过该 digest 的子容器；`execution_environment` 包含配置 pin、fingerprint 与确定性 SHA-256。字段纳入原有 Ed25519 签名，Kernel 校验 fingerprint hash、image pin、compute、隔离模式及实际硬资源 limits。资源模式记录 `resource_isolation=cgroup-v2` 和 `enforced_limits`，断网记录 `network_isolation=network-namespace`；旧默认 fingerprint 仍合法。Logs/Metrics/PDF 等 Artifact 沿用现有注册与 Manifest 引用，Evidence/Claim 完成校验不变。Settings heartbeat 展示的是父容器环境观测，本次实验的权威 fingerprint 在签名 Manifest 中。

## TeX

authoritative/preview build 仍通过原 API 冻结 TexWorkspaceSnapshot，逐文件 hash 验证，在临时输出目录执行当前容器的 engine，最多三轮。主 engine 缺失会在 preflight 以 `environment: native_executable_missing` 失败；冻结输入包含 `.bib` 时检查 bibtex，使用 biblatex 默认后端时检查 biber。第一轮产生 `.bcf` 则运行 biber，含 bibliography 的 `.aux` 则运行 bibtex，其失败会让构建失败。固定 engine 白名单、路径检查、`-no-shell-escape`、diagnostics、PDF/log/aux/bbl/blg/fls 收集与 stale 判定保留。并发编辑只让 PDF stale，不改变已冻结的编译输入。真实 TeX 发行版及 bibliography 工作流须在部署验收中确认。

## 验证状态

自动验证包括 CPU 真实子进程、Kernel/HTTP/CAS/签名往返、冻结 TeX（fixture engine）、旧数据库升级、schema/readiness 与 mocked NVIDIA。现有 Docker E2E、remote、Evidence、release/clean-room 测试没有删除。

2026-09-20 已使用独立 uv 环境通过真实 Blackwell GPU 矩阵计算，以及 approved baseline 的 Snapshot/CAS/HTTP/签名 Manifest 链路。结果与复现命令见 [GPU 与隔离验收记录](container-native-validation.md)。当前宿主 cgroup 只读、禁止 namespace，硬隔离成功路径尚待具备委派权限的环境实测；自动测试覆盖参数、资源控制写入、preflight 失败和清理。真实 TeX、浏览器及完整科研生命周期验收仍见 [人工验收](manual-acceptance.md)，本轮不处理 TeX 或发布流程。
