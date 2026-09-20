#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Real CPU processes and Kernel/CAS/signature roundtrips; NVIDIA is mocked.
pnpm exec vitest run tests/unit/container-native-runner.test.ts tests/unit/container-native-kernel.test.ts tests/unit/container-native-isolation.test.ts tests/unit/container-native-drift.test.ts tests/unit/native-environment-admission.test.ts tests/unit/native-gpu-lock.test.ts tests/unit/run-compute-model.test.ts tests/unit/plugin-default-mode.test.ts tests/unit/migrations.test.ts
