#!/usr/bin/env bash
# Install the Gutcheck git hooks (version-controlled under scripts/hooks/).
# core.hooksPath is a LOCAL config (opt-in per clone, by git's security design).
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath scripts/hooks
chmod +x scripts/hooks/* scripts/gate.sh 2>/dev/null || true
echo "Installed: core.hooksPath = scripts/hooks (pre-push gate active)."
echo "Uninstall: git config --unset core.hooksPath"
