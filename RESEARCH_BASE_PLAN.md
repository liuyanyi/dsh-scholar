# Research Base Plan

## 1. Base

This fork is the long-term research workstation base derived from `lzszq/dsh-scholar`.

- Upstream baseline commit: `086b19a2fbd7824dd71dde7ea2043f22888606e0`
- Development branch: `research-base`
- Deployment model: single user, single project
- Runtime model: DSH Scholar runs inside an existing GPU-enabled research container
- Human role: the human remains the workflow orchestrator and approves research direction, design, execution, and release decisions

The goal is to preserve DSH Scholar's research-state model while adapting its execution assumptions to the actual research environment.

## 2. Architecture decisions

Three components have clear ownership boundaries.

### DSH

DSH is the agent and tool runtime.

It owns:

- model/provider selection;
- tool registry and tool execution;
- permissions and approvals;
- sessions and conversation state;
- skills and subagents.

DeepSeek and local vLLM models should be connected through normal DSH providers.

Codex integration should use a provider/adapter that keeps DSH as the authoritative tool runtime. OAuth-based unofficial access is out of scope.

### DSH Scholar

DSH Scholar remains the authoritative research-state layer.

We retain its existing concepts and workflow, including:

- Human Gates;
- Brief / Scope;
- frozen literature corpus;
- Idea and Experiment Contract;
- code/data snapshots;
- Runs and RunManifest;
- Evidence and Claims;
- manuscript workspace;
- review and release gates.

The first stage should not redesign these abstractions.

### Research container

The existing GPU research container is the authoritative execution environment.

Formal research work should not require Docker-in-Docker.

The container already provides the controlled environment for:

- Python / uv;
- CUDA / NVIDIA GPU;
- project source code;
- experiment execution;
- LaTeX toolchain;
- Codex/other agent executables when installed.

## 3. Phase 1: container-native execution

Add a first-class formal execution target for the current research container.

Proposed target kind:

```text
container-native
```

It must be distinct from the existing `local-process` target. `local-process` remains limited to trusted development/smoke tasks.

The new target must support formal job kinds such as:

- baseline;
- pilot;
- formal;
- reproduce;
- analysis where applicable;
- latex-compile.

The new execution path should preserve the existing Scholar provenance chain:

```text
Experiment Contract
  -> frozen Code/Data/Tex snapshot
  -> ExecutionPlan
  -> container-native execution
  -> metrics/artifacts/logs
  -> RunManifest
  -> Evidence
  -> Claim
```

No nested container is required.

### Environment provenance

A container-native run should record an environment fingerprint sufficient to identify the execution environment. Candidate fields include:

- container image identity when available;
- OS / architecture;
- Python version;
- CUDA version;
- visible GPU model/device identifiers;
- dependency or lock-file hash;
- relevant runtime versions.

The exact schema should be designed before implementation.

## 4. Phase 2: Codex as a DSH-native harness/provider

Codex should be usable directly from DSH/Scholar conversations without creating a second independent tool world.

Target ownership model:

```text
Codex reasoning / thread
        |
        v
DSH tool calls
        |
        +-- filesystem
        +-- shell
        +-- web
        +-- Scholar research tools
        +-- skills/subagents
```

DSH remains authoritative for tool permission, execution, trajectory, and audit.

The preferred integration should therefore:

- use the supported Codex app-server / official Codex integration path;
- expose Codex as a normal selectable DSH provider/harness where possible;
- route environment operations through DSH tools;
- avoid relying on unofficial OAuth/subscription-access mechanisms;
- avoid parallel Codex-owned and DSH-owned shell/filesystem execution paths.

Codex integration is intentionally separated from Phase 1 so that the execution model can be stabilized first.

## 5. Human-in-the-loop workflow

The system is not intended to run an autonomous multi-agent research organization.

Expected usage:

```text
Human + primary agent
  -> discuss
  -> settle design / plan
  -> persist design artifact
  -> human chooses executor/model
  -> implementation / experiment / analysis
  -> human reviews result
  -> return to discussion
```

Different agents may work on the same project, but coordination is primarily through the human and durable project artifacts rather than hidden agent-to-agent chat context.

## 6. Non-goals for the initial fork

Do not initially redesign:

- the Scholar state machine;
- Gate semantics;
- Evidence/Claim semantics;
- literature model;
- experiment contracts;
- release workflow;
- multi-user support;
- multi-workspace/project management;
- autonomous agent delegation.

Do not add provider-specific backends for local vLLM or DeepSeek when normal DSH provider support is sufficient.

## 7. Implementation order

1. Lock the upstream/DSH compatibility baseline.
2. Add schema and migration support for `container-native`.
3. Add the container-native Runner/Profile/Target path.
4. Preserve snapshots, metrics, artifacts, RunManifest and Evidence behavior.
5. Add container-native `latex-compile`.
6. Add UI/Settings support for the new execution target.
7. Add focused tests and update acceptance documentation.
8. Validate a real GPU experiment inside the current container.
9. Integrate a DSH-native Codex provider/harness.
10. Validate the complete human-in-the-loop workflow on one real research project.

## 8. Upstream policy

Keep `main` suitable for tracking upstream.

Project-specific development should happen on `research-base` and feature branches derived from it.

When syncing upstream, preserve the architectural decisions in this document rather than resolving semantic conflicts by reverting to nested Docker execution.
