# Container Native GPU 与隔离验收

日期：2026-09-20。使用 `research-base` 当前工作树；测试数据、SQLite 和 CAS 均为独立临时目录，不更改既有研究项目。TeX 和发布流程不属于本轮范围。

## 本轮逐次选卡与环境身份解耦

基线 `4521714`，分支 `research-base`；没有回退已有提交。本轮没有人工指定并确认可用的真实 GPU，因此未执行真实 GPU 计算，也未自动遍历或占用共享设备。以下 GPU 行为使用 mock NVIDIA 观测和真实 CPU 子进程验证，不能当作真实 CUDA 多卡验收。

已覆盖：同一 Target/Contract 分别选卡、显式 all 固定、CPU 不继承历史 GPU 默认值、顺序与 UUID 启动、父级可见范围、设备消失拒绝、GPU 锁冲突与独立设备、重试固定、baseline 原子接口与幂等冲突、软件 pin 不随 GPU 集合变化、实际依赖与驱动漂移、签名/设备/环境篡改拒绝、旧 Contract 不自动补 pin、旧 Job 与 V2 签名 Manifest 校验、ResearchClient/Agent 参数以及选卡 UI 模型。普通 native 的 CPU 执行不要求 namespace/cgroup 权限，严格 Profile 的失败行为保持不变。

最终执行命令与结果：

```sh
pnpm run build
pnpm --filter @dsh-scholar/research-ui typecheck
pnpm run verify:docs
pnpm exec vitest run --exclude tests/unit/chat-agent-bridge.test.ts
runuser -u nobody -- /usr/bin/node node_modules/vitest/vitest.mjs run tests/unit/chat-agent-bridge.test.ts --no-cache --configLoader runner
bash tests/security/run-manifest-tests.sh
bash tests/security/run-formal-binding-tests.sh
bash tests/security/run-fencing-tests.sh
bash tests/security/run-runner-target-identity-tests.sh
bash tests/security/run-evidence-tests.sh
git diff --check
```

- 构建、UI 类型检查、23 份文档检查及补丁检查通过。
- 主套件 165 个文件、1877 项通过、2 项跳过、0 失败；含 Docker/remote/local-process 既有单元回归。跳过真实硬隔离与独立 uv 安装升级用例。
- 原有权限敏感套件在 root 下有一项无法模拟 chmod 拒绝；使用上列非 root 命令单独复验，10 项全部通过。合计单元测试 1887 项通过、2 项跳过。
- 安全回归：Manifest 11、Contract/Protocol 12、fencing 15、Target 身份 5、Evidence 13，共 56 项通过、0 失败。
- 本地临时数据目录的 standalone 服务启动并返回 HTTP 200；浏览器视觉/点击验收、真实 GPU 单卡/多卡顺序及真实严格隔离成功路径仍待人工验证。没有执行真实 Docker/SSH E2E。

真实 GPU 后续验收须先人工确认两张可用设备，再按下面的 opt-in 测试命令替换编号。新运行应看到 `CUDA_VISIBLE_DEVICES=GPU-...`，不是数字；多卡核对 `cuda:0`/`cuda:1` 与提交顺序一致。不要将下面基线的 GPU 7 记录当作该设备当前空闲的保证。

## 此前基线真实 GPU：通过

独立 uv 环境：`/tmp/dsh-native-gpu-venv`，Python 3.12.3，PyTorch 2.7.1+cu128，CUDA wheel 12.8，NVIDIA 驱动 595.91.07。选择物理设备 7：NVIDIA RTX PRO 6000 Blackwell Server Edition，compute capability 12.0。没有修改系统 Python 或其他 GPU 任务。

`tests/fixtures/native-gpu-smoke.py` 在一个 GPU 上计算 512×512 矩阵乘法，与 CPU 结果逐元素比较。最大绝对误差为 0，PyTorch 峰值 tensor 分配 11,665,408 bytes（约 11.1 MiB，不含驱动/context 内存）。未安装 NumPy 会产生可选桥接警告，本测试不使用 NumPy。

同一程序还通过 `container-native-kernel.test.ts` 执行真实 approved baseline：Contract 审批、冻结 Code/Data Snapshot、依赖版本文件 hash、SQLite/CAS、HTTP claim/complete、MetricsFileV1、Artifacts 和 Ed25519 签名 Manifest 均通过。测试拒绝重新签名后的错误环境 hash、伪 Docker digest 及不符 Profile 的隔离声明。这不是完整 formal/confirmatory、Evidence/Claim 科研生命周期或多卡训练验收。

复现（替换设备号，并确保该设备有足够空闲资源）：

```sh
uv venv --python 3.12 /tmp/dsh-native-gpu-venv
uv pip install --python /tmp/dsh-native-gpu-venv/bin/python -r tests/fixtures/native-gpu-requirements.txt
CUDA_VISIBLE_DEVICES=7 uv run --python /tmp/dsh-native-gpu-venv/bin/python --no-project tests/fixtures/native-gpu-smoke.py
PATH=/tmp/dsh-native-gpu-venv/bin:$PATH DSH_TEST_GPU_PYTHON=/tmp/dsh-native-gpu-venv/bin/python DSH_TEST_GPU_DEVICE=7 pnpm exec vitest run tests/unit/container-native-kernel.test.ts
```

Node/pnpm 版本沿用项目要求。普通单元测试不设置 `DSH_TEST_GPU_PYTHON` 时只运行 CPU；GPU 用例只有显式设置此变量才运行。依赖版本文件记录本次实际安装的完整版本集合，随 GPU 代码一起进入冻结 Snapshot；它不是 wheel 文件 hash 锁。

## 可选硬隔离：实现完成，宿主成功路径待验证

当前环境 `/sys/fs/cgroup` 是只读 cgroup v2，`unshare --net true` 返回 `Operation not permitted`。没有修改宿主挂载或申请 privileged 容器。当前机器不能实测资源/网络隔离成功执行。

已自动验证：默认模式无隔离依赖；断网、资源、组合 Profile；cgroup 控制器和文件系统检查；CPU/内存/swap/PID 控制写入；先加入 cgroup 再 exec；argv 不插值实验命令；preflight 失败后不执行实验；cgroup kill、删除、等待回收；Kernel 拒绝不匹配的隔离 Manifest。上述成功控制写入和 namespace 启动用例使用 mock，不作为宿主内核硬隔离证据。

具备 bubblewrap namespace 权限及 cgroup 委派的部署环境可执行：

```sh
DSH_NATIVE_CGROUP_ROOT=/sys/fs/cgroup/<delegated-directory> DSH_TEST_NATIVE_ISOLATION=1 pnpm exec vitest run tests/unit/container-native-runner.test.ts
```

运行前将占位目录替换为实际部署路径。该 opt-in 用例检查实验内 network namespace 不同、无路由、实际 cgroup 配额、无法写回解除限制、签名环境事实以及结束后目录回收。普通测试中明确跳过。

后续仍需真实环境故障验收：CPU 持续节流、触发内存 OOM/PID 上限、取消与超时过程中残留后代清理、GPU 与硬隔离同时启用、长期并发任务，以及 Runner 被 SIGKILL 后的部署回收。资源 limits 不限制显存，CUDA_VISIBLE_DEVICES 不是设备访问安全边界。

## 数据库与兼容性

沿用本次 container-native 基础实现的 `0039_container_native_targets`，schema version 36；保留旧 Target 行及历史 migration checksum，新增默认禁用的 native Target 与 compute/observation JSON 字段。可选隔离只增加固定 Profile 和可选 fingerprint 字段，不需要额外数据库 migration。默认两个 native Profile、既有 local-process/local-docker/remote-ssh 的配置 hash 和执行选择保持不变。

## 基础实现验证（d15307e）

- 全部模块与插件构建、UI typecheck、文档检查、`git diff --check` 通过。
- 主单元回归含真实 GPU：161 个文件，1857 项通过，1 项真实硬隔离测试显式跳过。
- `chat-agent-bridge.test.ts` 的权限语义测试另以非 root 用户执行，10 项通过；合计 1867 项通过。
- Manifest 安全回归 11 项、Evidence 13 项、正式实验 Contract/Protocol/Snapshot 绑定 12 项全部通过。
- 独立 uv 环境的 25 个依赖版本与已提交的 requirements 文件一致。

后续环境 pin/GPU 租约增量及最新验证结果见 [环境 Pin 与 GPU 租约](container-native-drift-guard.md)。
