#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Real CPU processes and Kernel/CAS/signature roundtrips; NVIDIA is mocked.
pnpm exec vitest run tests/unit/container-native-runner.test.ts tests/unit/container-native-kernel.test.ts tests/unit/container-native-isolation.test.ts tests/unit/migrations.test.ts
