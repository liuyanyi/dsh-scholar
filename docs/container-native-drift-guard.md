# Native 环境 Pin 与 GPU 租约

本阶段在已实现的 container-native、真实 GPU smoke 与可选隔离基础上增加环境漂移防护，不改变 Research Workflow，不处理 Codex Provider、真实 TeX 或发布流程。

## 环境身份

采用 NativeEnvironmentSnapshot 作为 native 的实际环境身份。`ExecutionPlan.image.digest` 和 Manifest 的 `configured:<digest>` 保留兼容语义，不再把它们当作 native runtime 已匹配 OCI image 的证明。`DSH_RESEARCH_CONTAINER_IMAGE` 仍是可选部署声明，不能替代环境 pin。

Fingerprint V2 区分两类事实：

- `dependency_lock_hash`：冻结输入中的声明依赖文件 hash，沿用原字段。
- `actual_environment_hash`：实际 NativeEnvironmentSnapshot 的确定性 SHA-256。

Snapshot 包含 OS/架构、Node 版本及 executable 内容 hash、Python 版本及 executable 内容 hash、Python prefix 的 hash、实际 installed distributions、CUDA toolkit 版本、NVIDIA driver 版本和可见 GPU UUID 集合。Python inventory 通过所选解释器的 `importlib.metadata` 读取，包名归一化、排序，每项包含 name/version 和 installed RECORD 内容 hash。不导出 prefix 明文、完整 env、token 或 pip 配置。

Runner 的 PATH 决定目标默认 Python 环境；应先激活所选 uv venv 再启动 Runner，每个不同 Python 环境使用独立 Target。直接以 `python`/`python3`/绝对 Python 路径启动时，按实际 executable 再采集 inventory；执行器路径相同但 venv 不同也会通过 prefix/distributions 区分。Python 存在但 inventory 采集失败时拒绝执行，不将错误当作空环境。

## 审批与执行

1. Target 的认证 heartbeat 上报 V2 `actual_environment_hash`。
2. Contract Gate 审批时，Kernel 要求新鲜观测，并固定 `approval.native_environment={target_id,sha256}`。审批后不可变。
3. baseline/pilot/formal/reproduce 提交必须匹配该批准 Target 和环境；变更返回 `environment_changed`。旧的已批准 Contract 若没有 native pin，不自动补写，必须使用新版本重新审批。
4. Kernel 在 Job payload 和签名 ExecutionPlan 固定 `expected_environment_hash`。formal/confirmatory 的 Protocol `pins.environment` 使用该 hash；非 native 仍使用原 Target config hash。Target revision/config hash 继续单独固定并校验。
5. 排队期间 heartbeat 已显示环境变化时，不再认领该旧 pin 的 Job；需要恢复批准的环境，或通过新的 Contract/Protocol 提交新 Job，旧任务不会自动重 pin。
6. Runner 在启动前重新采集实际环境；隔离 preflight 后再核对，任何不一致在实验执行前以 environment 类失败结束。正常退出后再采集一次，检测到运行期间漂移也不能成功完成。
7. Snapshot 以 `manifest` 类 Artifact 注册，规范化内容 hash 等于 `actual_environment_hash`。签名 RunManifest 引用 `native_environment_artifact`。Kernel 检查 Artifact 所属项目、内容与 hash、审批/Job pin、fingerprint 事实及 GPU UUID 一致。

Settings 显示最新实际环境 hash；heartbeat 是观测，Contract 中的审批 pin 才是任务预期，不会被后续 heartbeat 覆盖。TeX 当前保持原有流程，本阶段不要求它具备 Contract native pin。

## GPU 排他与恢复

此前 CLI 每次只认领一个 Job，但多个 Runner 实例仍可竞争同一设备；已有 Job 租约本身不提供 GPU 级排他。本阶段增加两层控制：

- Kernel 在提交时把 selector 解析为观测到的 UUID，写入 `native_gpu_uuids`；`all` 预留全部可见设备。在现有 `BEGIN IMMEDIATE` 事务中，只有与全部 running native Job 的 GPU UUID 不相交时才认领。多个 Kernel 连接使用同一数据库时仍互斥；不同 Target 别名也按 UUID 冲突。资源所有权复用 durable Job owner/generation/token，不增加第二套租约状态。
- Runner 使用 `/usr/bin/flock` 对 UUID 文件加排他锁，锁由沙箱外父进程持有直到实验退出。同一主机的 Runner 必须使用同一个锁目录：默认 `/tmp/dsh-native-gpu-locks`，可通过服务环境 `DSH_NATIVE_GPU_LOCK_ROOT` 指定绝对路径；不同容器共享设备时应挂载同一个锁目录。目录必须属于服务用户、不可被其他用户写入，服务用户应一致。不要删除仍被使用的锁文件，也不要为每个 Target 配置互不相同的目录。

完成和取消释放数据库调度容量；过期 Job 沿用 `recoverExpiredLeases` 恢复并递增下一次 attempt 的 generation。旧进程仍占卡时 flock 拒绝新实验（`native_gpu_busy`），不会因数据库租约已恢复就重叠执行。native 续租被 fencing 拒绝或本地 deadline 到期时终止进程；另用 `/usr/bin/timeout` 给 GPU 进程树加独立期限，使 Runner 被 SIGKILL 后的遗留工作仍有时间上限。默认超时精度为秒级，正常运行继续受原有毫秒级 Runner timeout 约束。

这不是 GPU 硬件访问隔离，不会阻止不遵守此锁协议的外部训练任务，也不限制显存。脱离进程组的恶意后代、独立重启的服务以及不共享锁目录的部署仍需宿主监督；有条件时结合 cgroup 隔离。锁文件可保留复用，文件存在不代表锁仍被持有。

## 检测边界

本阶段是审批绑定和 drift guard，不是完整不可变 runtime filesystem：

- 可以发现标准安装/升级造成的 distribution version 或 RECORD 变化、解释器或 venv 切换、Node binary、CUDA/driver/GPU 集合变化。
- 不逐字节重算全部 site-packages；手工修改包文件但不改 metadata/RECORD、editable source 变化可能无法检测。
- 不冻结所有 Node package、系统动态库、外部 executable、字体、数据服务或通过脚本自行选择的另一套 runtime。
- 启动前/结束后两次核对不能排除期间发生又恢复的瞬时修改；inherited 网络也不能保证所有外部输入已冻结。

因此不能据此宣称与不可变 OCI image 完全等价。真正的只读内容寻址项目 venv、完整文件校验、可信 OCI 证明、受控 SecretRef 与更严格的启动器约束仍是独立后续工作。

## Docker 路径审计

仓库静态审计发现以下实际依赖，并非只有文档示例：

| 文件 | 依赖 |
| --- | --- |
| `evals/demo-full-flow.sh` | `/work/train.js`、`/work/data.json`、`/outputs/metrics.json` |
| `evals/demo-standalone-flow.sh` | 同类训练命令和输出路径 |
| `evals/golden-path-v2/run-golden-v2.sh` | `/work/<script>`、冻结 data 路径及 `/outputs` |
| `evals/mnist-readme/run-mnist.sh` | baseline/formal 训练命令与输出文件使用绝对路径 |
| `evals/clean-room-rerun.sh` | 内联代码直接写 `/outputs/metrics.json`；本轮不修改发布验收 |

默认 native 不提供 `/work`、`/outputs` 挂载别名；optional isolation 当前也不额外提供别名。保留旧 Docker/SSH 执行行为，不等于保证任意 Docker 专用实验无需调整即可换 Target。新的 native 实验使用相对路径与 DSH_WORK_DIR/DSH_OUTPUTS_DIR；已有实验若迁移路径语义，需冻结新代码并按现有流程重新批准。仅 `output_contract` 中的 `/outputs/metrics.json` 由现有输出读取逻辑识别，不等价于脚本能直接访问该绝对路径。

## 验证与存储

新增测试覆盖实际 dependency/RECORD 漂移、审批时 V2 要求、提交与认领拒绝漂移、不可自动重 pin、跨 Kernel GPU 排他、租约恢复/fencing、真实 flock 冲突与取消后释放、续租挂起时 deadline 终止、伪造 Snapshot Artifact/环境摘要拒绝。原真实 Blackwell GPU baseline 在启用新 pin 后再次通过。

另在 `/tmp/dsh-native-drift-venv` 独立 uv 环境真实执行 packaging 24.2 → 25.0 升级；声明 requirements 不变、实际环境 hash 改变。复现：

```sh
uv venv --python 3.12 /tmp/dsh-native-drift-venv
DSH_TEST_DRIFT_PYTHON=/tmp/dsh-native-drift-venv/bin/python pnpm exec vitest run tests/unit/container-native-drift.test.ts
```

只将该变量指向专用测试 venv；此 opt-in 测试会安装/升级 packaging。普通回归不联网安装依赖。真实 GPU 复现命令仍见 [验收记录](container-native-validation.md)。

没有新增 SQL migration：沿用 `0039` / schema version 36，Contract body、Job payload、Target observation 与 Artifact 均使用现有持久化结构。旧 Docker/SSH 数据和历史 migration checksum 不改写。

最终回归：完整构建、UI typecheck、文档检查通过；主套件 164 个文件、1869 项通过、1 项硬隔离实测跳过，另以非 root 用户通过 10 项权限敏感测试。主套件显式开启真实 GPU 与真实 uv 漂移用例。Manifest 11 项、Contract/Protocol 绑定 12 项、Evidence 13 项、fencing 15 项、Target 身份 5 项安全回归全部通过，共 56 项。
