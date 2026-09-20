# Research Base 计划

## 1. 基线与定位

本仓库是基于 `lzszq/dsh-scholar` 的长期科研工作台分支，用于构建一个单用户、单项目、Human-in-the-loop 的科研环境。

当前基线：

- Upstream：`lzszq/dsh-scholar`
- Upstream 基线提交：`086b19a2fbd7824dd71dde7ea2043f22888606e0`
- 长期开发分支：`research-base`
- 使用方式：单用户、单 Project
- 运行方式：DSH Scholar 运行在一个已经具备 GPU、CUDA、Python 与科研依赖的长期容器中
- 人的角色：人负责研究方向、方案确认、任务分配、结果判断与最终发布决策

本 Fork 的目标不是重新设计一套 Research OS，而是在保留 DSH Scholar 现有科研状态模型的基础上，使它适配实际科研工作环境。

## 2. 总体架构原则

系统分成三个明确层次：DSH、DSH Scholar 和 Research Container。三者职责保持清晰，避免模型、工具、科研状态和执行环境相互侵入。

### 2.1 DSH：唯一 Agent / Tool Runtime

DSH 负责 Agent 与工具运行时，包括：

- 模型与 Provider 选择；
- Tool Registry 与工具执行；
- 权限、审批和执行策略；
- Session 与 Conversation；
- Skills；
- Subagents。

DeepSeek 与本地 vLLM 模型均通过 DSH 正常 Provider 接入，不在 Scholar 内新增模型专用后端。

Codex 后续也应作为 DSH 体系中的 Harness/Provider 接入。目标是保留 Codex 的推理与 Agent 能力，同时让文件、Shell、Web、Scholar Research Tools 等环境操作统一经过 DSH Tool Runtime。

Codex 集成只考虑官方支持的 CLI、App Server、SDK 或其他明确支持的接口，不采用第三方提取、转发或复用 ChatGPT OAuth / 订阅凭据的方案。

### 2.2 DSH Scholar：唯一 Research State

DSH Scholar 继续作为科研状态的权威来源。

第一阶段保留现有核心模型，不重新设计：

- Human Gate；
- Brief / Scope；
- Frozen Corpus；
- Idea；
- Experiment Contract；
- Code / Data Snapshot；
- Run 与 RunManifest；
- Evidence；
- Claim；
- Manuscript Workspace；
- Review；
- Release Gate。

Agent 可以讨论、提出方案、编写代码和执行任务，但正式科研状态仍由 Scholar 的已有流程管理。

### 2.3 Research Container：正式执行环境

DSH Scholar 将运行在一个已经准备好的 GPU Research Container 内。

该容器本身就是科研执行环境，通常已经包含：

- Python / uv；
- CUDA / NVIDIA GPU；
- 项目源码；
- 实验依赖；
- Git；
- LaTeX 工具链；
- Codex 或其他 Agent CLI。

因此正式实验和论文编译不应再强制创建第二层 Docker Container。

我们将把“当前 Research Container”作为 Scholar 的一种正式 Execution Target，而不是把它伪装成现有的 `local-process`。

## 3. 第一阶段：Container Native Runner

第一阶段只解决一个问题：

> 让 DSH Scholar 可以在当前 GPU Research Container 中直接执行正式实验和 LaTeX 编译，同时完整保留现有科研追溯链。

新增正式执行目标：

```text
container-native
```

它与现有目标并列：

```text
local-process       # trusted development / smoke
local-docker        # 现有 Docker Runner
container-native    # 当前 Research Container
remote-ssh          # 远程 Runner
```

`local-process` 的原语义保持不变，仍然只用于开发和 smoke，不允许通过修改名称或降低校验来承载正式实验。

Container Native Runner 需要支持：

- baseline；
- pilot；
- formal；
- reproduce；
- analysis（适用时）；
- latex-compile。

新的执行路径必须继续保持：

```text
Experiment Contract
        ↓
Frozen Code / Data / TeX Snapshot
        ↓
ExecutionPlan
        ↓
Container Native Runner
        ↓
Logs / Metrics / Artifacts
        ↓
RunManifest
        ↓
Evidence
        ↓
Claim
```

不引入 Docker-in-Docker。

Target 描述执行环境与能力；每个 Run 单独选择 GPU。普通 native 提供受信任科研代码的 best-effort 隔离，不要求 cgroup 委派或 namespace 权限。软件环境审批 pin 与本次设备分配分开记录：仅换卡不修改 Target、不重启 Runner，也不因此重新审批新的软件 pin Contract/Protocol。

具体工程设计见：

`docs/container-native-runner-plan.md`

## 4. 第二阶段：Codex 作为 DSH 原生 Harness

第二阶段再处理 Codex。

目标不是在 Scholar 内增加一套独立 Codex 工具体系，而是：

```text
Codex reasoning / thread
          ↓
      DSH Tool Calls
          ↓
  ┌───────┼─────────┐
  │       │         │
Files    Shell     Web
                    │
             Scholar Research Tools
```

DSH 继续负责：

- Tool catalog；
- Tool permission；
- Tool execution；
- trajectory；
- session / audit；
- Scholar tools 的访问。

这样无论当前使用 DeepSeek、本地 vLLM 还是 Codex，科研工作流和工具面都保持一致。

Codex 集成不与第一阶段 Container Native Runner 混在同一个开发任务中。先稳定执行环境，再接入 Codex。

## 5. Human-in-the-loop 工作方式

本系统不是为了构建全自动多 Agent 科研组织。

预期工作方式是：

```text
人 + 当前主 Agent
        ↓
讨论问题
        ↓
确定设计 / 实验方案
        ↓
把决定固化成项目文档
        ↓
人选择执行模型 / Harness
        ↓
实现 / 实验 / 分析
        ↓
人检查结果
        ↓
回到讨论与下一轮设计
```

不同 Agent 可以在同一个 Project 上工作，但协调主要通过：

- 人的任务分配；
- Git；
- 设计文档；
- Experiment Contract；
- Run / Artifact；
- Evidence / Claim；
- Manuscript。

不依赖隐藏的 Agent-to-Agent 对话上下文作为科研事实来源。

## 6. 第一阶段不做的事情

当前 Fork 第一阶段不处理以下内容：

- 不重新设计 Scholar State Machine；
- 不改变 Gate 语义；
- 不改变 Evidence / Claim 语义；
- 不重写 Literature / Corpus 模型；
- 不改变 Experiment Contract；
- 不重写 Release Workflow；
- 不增加多用户能力；
- 不增加多 Workspace / 多 Project 管理；
- 不增加自动 Multi-Agent Orchestration；
- 不为 DeepSeek 或本地 vLLM 编写 Scholar 专用 Provider；
- 不在 Container Native Runner 开发中同时实现 Codex Provider。

## 7. 实现顺序

当前实现顺序固定为：

1. 固定 Upstream 与 DSH 兼容基线；
2. 完成 `container-native` 的 schema 与 migration；
3. 完成 RunnerTarget / RunnerProfile / readiness；
4. 完成 Container Native execution adapter；
5. 保持 Snapshot、Metrics、Artifact、RunManifest、Evidence 链不变；
6. 支持 Container Native `latex-compile`；
7. 补充 Settings / UI；
8. 补充单元测试、安全测试和验收文档；
9. 在真实 GPU Research Container 中完成一次正式实验验证；
10. 再开始 Codex 的 DSH-native Harness/Provider 集成；
11. 使用一个真实科研项目验证完整 Human-in-the-loop 工作流。

## 8. 版本与 Upstream 策略

`main` 用于尽可能保持与 upstream 的同步关系。

我们的长期改动放在：

```text
research-base
```

以及从其派生的 feature branch 中。

DSH Scholar 与 DSH 本身都仍处于快速迭代阶段，因此实际部署应固定：

```text
DSH exact version
+
DSH Scholar exact commit
```

而不是持续追踪 latest。

同步 upstream 时，应优先保留本文已经确定的架构决策。特别是正式实验运行在当前 Research Container 是本 Fork 的明确设计，不应在解决 merge conflict 时被无意恢复成必须嵌套 Docker。
