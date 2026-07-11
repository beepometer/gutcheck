#!/usr/bin/env bash
# Gutcheck deterministic gate.
# Default: the fast coherence check (commands.check). --full: the whole test suite
# (commands.testFull, falling back to commands.test). Reads gutcheck.config.json for the
# calibrated commands, so it is identical across adopters — only the config differs.
# Eats its own dog food: plain command, exit captured, no pipe-masking.
#
# PASS iff the command exits 0 AND (commands.buildSuccessLine is unset OR present in the output).
# Exit code is the primary signal. commands.buildSuccessLine is a PASS-ONLY banner regex (e.g.
# gradle's 'BUILD SUCCESSFUL') — set it for runners that can exit 0 on a masked/cached failure
# (the masked-failure pathology of cached/incremental build runners); leave it null for runners whose exit code is authoritative
# (node:test, jest, cargo, go). NOTE: do NOT grep commands.buildPassLine here — that token is the
# pass-OR-fail banner and matches the FAILED line too, so it cannot gate success.
set -uo pipefail

CONFIG="${GUTCHECK_CONFIG:-gutcheck.config.json}"
FULL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1 ;;
    --config) CONFIG="${2:-}"; shift ;;
    -h|--help) echo "usage: gate.sh [--full] [--config <path>]"; exit 0 ;;
    *) echo "gutcheck gate: unknown arg '$1' (usage: gate.sh [--full] [--config <path>])" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -f "$CONFIG" ]; then
  echo "gutcheck gate: config not found at '$CONFIG' (pass --config <path> or set GUTCHECK_CONFIG)" >&2
  exit 2
fi

# Pull a commands.<key> value from the JSON config. Node is present (the checker is Node).
# A malformed config yields an empty value -> the gate fails CLOSED ("no command configured", exit 2).
read_cmd() {
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(j.commands||{})[process.argv[2]];process.stdout.write(v==null?"":String(v))}catch{}' "$CONFIG" "$1"
}

if [ "$FULL" -eq 1 ]; then
  CMD="$(read_cmd testFull)"; [ -z "$CMD" ] && CMD="$(read_cmd test)"
  LABEL="full suite"
else
  CMD="$(read_cmd check)"
  LABEL="coherence check"
fi
SUCCESS_LINE="$(read_cmd buildSuccessLine)"

if [ -z "$CMD" ]; then
  echo "gutcheck gate: no command configured for the $LABEL (commands.check / commands.testFull / commands.test) in $CONFIG" >&2
  exit 2
fi

LOG="$(mktemp -t gutcheck-gate.XXXXXX)"
bash -c "$CMD" > "$LOG" 2>&1
EXIT=$?

BANNER_OK=1
if [ -n "$SUCCESS_LINE" ] && ! grep -qE "$SUCCESS_LINE" "$LOG"; then BANNER_OK=0; fi

if [ "$EXIT" -eq 0 ] && [ "$BANNER_OK" -eq 1 ]; then
  echo "gutcheck gate: PASS ($LABEL)"
  rm -f "$LOG"
  exit 0
fi
echo "gutcheck gate: FAIL ($LABEL — exit $EXIT$([ "$BANNER_OK" -eq 0 ] && echo ', success banner absent'))"
tail -30 "$LOG"
echo "full log: $LOG"
exit 1
