#!/usr/bin/env bash
# Warm the JVM/Maven dependency caches the offline probe e2es depend on.
# The gradle probe runs `--offline` and the maven probe runs `mvn -o`; both need ~/.gradle and ~/.m2
# already populated, or the e2es fail RED (or, when the runner binary is missing, silently SKIP). This
# warms them from the vendored fixtures — the local twin of the CI jvm leg's warm steps
# (.github/workflows/ci.yml). Idempotent; safe to re-run.
#
# Gradle warms off the vendored wrapper + your JDK — no system `gradle` needed. Maven is optional: it
# warms only when a usable `mvn` is found — set GUTCHECK_MVN to an mvn binary, or put mvn on PATH. Keep
# GUTCHECK_MVN exported in the shell that later runs `npm test` (the maven e2es gate on that var).
set -uo pipefail

DRY=0
GRADLE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --gradle-only) GRADLE_ONLY=1 ;;
    -h|--help) echo "usage: warm-caches.sh [--dry-run] [--gradle-only]"; exit 0 ;;
    *) echo "warm-caches: unknown arg '$1' (usage: warm-caches.sh [--dry-run] [--gradle-only])" >&2; exit 2 ;;
  esac
  shift
done

# Resolve fixtures relative to THIS script, so the tool works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
GRADLE_FIX="$REPO/test/fixtures/jvm-project"
MVN_FIX_SINGLE="$REPO/test/fixtures/maven-project"
MVN_FIX_REACTOR="$REPO/test/fixtures/maven-reactor"

# Resolve mvn: GUTCHECK_MVN wins (fail closed if set-but-unusable), else mvn on PATH, else none.
MVN=""
if [ "$GRADLE_ONLY" -eq 0 ]; then
  if [ -n "${GUTCHECK_MVN:-}" ]; then
    if [ -x "$GUTCHECK_MVN" ]; then
      MVN="$GUTCHECK_MVN"
    else
      echo "warm-caches: GUTCHECK_MVN='$GUTCHECK_MVN' is not an executable (unset it to auto-detect, or point it at a real mvn)" >&2
      exit 2
    fi
  elif command -v mvn >/dev/null 2>&1; then
    MVN="$(command -v mvn)"
  fi
fi

JAVA=""
if command -v java >/dev/null 2>&1; then JAVA="$(command -v java)"; fi

GRADLE_STATUS="skip"
MAVEN_STATUS="off"

warm_gradle() {
  if [ -z "$JAVA" ]; then
    echo "warm-caches: gradle → SKIP (no java on PATH)"
    GRADLE_STATUS="skip"; return 0
  fi
  if [ "$DRY" -eq 1 ]; then
    echo "warm-caches: [dry-run] gradle → cd $GRADLE_FIX && java -cp gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain test --console=plain"
    GRADLE_STATUS="dry"; return 0
  fi
  echo "warm-caches: warming gradle ($GRADLE_FIX) ..."
  if ( cd "$GRADLE_FIX" && "$JAVA" -cp gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain test --console=plain ); then
    echo "warm-caches: warmed gradle"; GRADLE_STATUS="ok"; return 0
  fi
  echo "warm-caches: FAILED gradle" >&2; GRADLE_STATUS="fail"; return 1
}

warm_maven() {
  if [ "$GRADLE_ONLY" -eq 1 ]; then
    echo "warm-caches: maven → SKIP (--gradle-only)"; MAVEN_STATUS="off"; return 0
  fi
  if [ -z "$MVN" ]; then
    echo "warm-caches: maven → SKIP (no mvn — set GUTCHECK_MVN or put mvn on PATH)"; MAVEN_STATUS="skip"; return 0
  fi
  local rc=0 dir
  for dir in "$MVN_FIX_SINGLE" "$MVN_FIX_REACTOR"; do
    if [ "$DRY" -eq 1 ]; then
      echo "warm-caches: [dry-run] maven → cd $dir && $MVN -q test"
      continue
    fi
    echo "warm-caches: warming maven ($dir) ..."
    if ( cd "$dir" && "$MVN" -q test ); then
      echo "warm-caches: warmed maven ($dir)"
    else
      echo "warm-caches: FAILED maven ($dir)" >&2; rc=1
    fi
  done
  if [ "$DRY" -eq 1 ]; then MAVEN_STATUS="dry"; return 0; fi
  if [ "$rc" -eq 0 ]; then MAVEN_STATUS="ok"; else MAVEN_STATUS="fail"; fi
  return "$rc"
}

RC=0
warm_gradle || RC=1
warm_maven || RC=1
echo "warm-caches: done (gradle=$GRADLE_STATUS maven=$MAVEN_STATUS)"
exit "$RC"
