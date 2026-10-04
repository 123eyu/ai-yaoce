#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
xcrun swiftc -swift-version 5 Sources/ModelHealth.swift Sources/ModelHealthSettingsView.swift scripts/verify-model-health.swift -o build/verify-model-health
build/verify-model-health
