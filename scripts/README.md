# scripts/—Gutcheck deterministic gate

- `gate.sh`—runs the fast coherence check (`commands.check` from `gutcheck.config.json`).
  `gate.sh --full` runs the whole test suite (`commands.testFull`, falling back to `commands.test`).
  Plain command, exit captured, no pipe-masking. PASS iff exit 0 (and, when set, the pass-ONLY
  `commands.buildSuccessLine` banner is present—for build tools that can exit 0 on a masked failure).
  Config path: `./gutcheck.config.json` by default; override with `--config <path>` or `$GUTCHECK_CONFIG`.
  Each `commands.*` value must be a **self-contained command string** the gate runs verbatim—no
  shell functions or env that must be sourced first, and **no pipe-masking inside the command** (e.g.
  `… | tail`), which would swallow the real exit code the gate relies on.
- `hooks/pre-push`—runs `gate.sh` before a push; aborts on failure (`git push --no-verify` to override).
- `install-hooks.sh`—one-time per clone: sets `git config core.hooksPath scripts/hooks`.
- `build-plugin.mjs`—assembles the installable plugin at `dist/gutcheck` by copying source files
  verbatim (`npm run build:plugin`).
- `warm-caches.sh`—warms the JVM/Maven dependency caches the offline probe e2es need, from the
  vendored fixtures (the local twin of the CI jvm leg's warm steps). Gradle warms off the vendored
  wrapper + your JDK—no system `gradle`. The gradle e2es gate only on a usable `java` (plus
  `GUTCHECK_GRADLE_E2E` on CI legs); locally they always run, and on a cold cache they **fail**—the
  probe runs Gradle `--offline`—so run this after a `~/.gradle` purge. Maven is optional: it warms
  only when a usable `mvn` is found—set `GUTCHECK_MVN` to an mvn binary (or put mvn on PATH), and
  keep it exported for the `npm test` run; the maven e2es gate on that var and **silently skip**
  without it (same after a `~/.m2` purge—warm before trusting a green run). `--dry-run` prints the
  plan; `--gradle-only` skips maven.

The gate enforces only the *mechanical* disciplines (coherence, forbidden-locators, bad-test shapes).
The judgment disciplines stay in the skills and are followed by agents—deliberately not mechanized.
