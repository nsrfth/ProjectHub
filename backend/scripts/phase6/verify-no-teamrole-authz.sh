#!/usr/bin/env bash
# Phase 6 Gate B: prove zero AUTHORIZATION reads of the legacy TeamRole enum
# remain outside the known fallback sites. Run from backend/.
# Exit 0 = clean; 1 = sites remain (listed).
set -euo pipefail
cd "$(dirname "$0")/../.."
# The four known fallback sites in requirePermission.ts are the removal target;
# anything ELSE comparing membership.role to MANAGER/MEMBER is a stray
# authorization read that Phase 6 must also clean up.
HITS=$(grep -rn "\.role === 'MANAGER'\|\.role === 'MEMBER'" src \
  | grep -v "requirePermission.ts" \
  | grep -v "// legacy-display" || true)
if [ -z "$HITS" ]; then
  echo "GATE B CLEAN — no stray TeamRole authorization reads outside requirePermission.ts"
  exit 0
fi
echo "GATE B FAILED — stray TeamRole reads:"
echo "$HITS"
exit 1
