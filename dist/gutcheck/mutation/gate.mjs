// mutation/gate.mjs — the Stop-hook gate CORE, harness-agnostic. Ported verbatim from
// hooks/check-changed-tests (now a thin `exec node ... gate --harness=<h>` caller) so more agent-loop
// integrations can share the same probe-gate logic behind a small harness-adapter interface: one adapter
// = how to read the world (parseEvent) + how to speak back (renderBlock/renderVoice/renderResidue).
// Everything else below is shared, harness-agnostic gate logic.
//
// runGate() owns, in order: the harness event parse (fail-open on a malformed/unrecognized event), the
// per-repo opt-outs (.gutcheck-off walked up-tree, GUTCHECK_HOOK=off), the git prerequisite (fail-open if
// not a repo or git is missing), baseline resolution (<git-dir>/gutcheck-baseline, falling back to HEAD),
// the diff-hash memo (read/write), loop-guard dispatch (one forced retry, then residue-only), the probe
// invocation, and verdict-to-message building (block / clean voice / residue — the exact strings the bash
// hook built). Every error path fails OPEN: null means "print nothing", same as the bash hook's exit 0.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUTCHECK_PATH = fileURLToPath(new URL('./gutcheck.mjs', import.meta.url));

// One harness adapter = how to read the world and how to speak back. `claude` is the Claude Code Stop
// hook's own JSON-line protocol.
export const HARNESSES = {
  claude: {
    // parseEvent(stdinText) -> { gate: boolean, loopActive: boolean }
    //   gate=false → print nothing, exit 0 (malformed stdin: fail-open — a NEW guard the bash hook's own
    //   embedded `node -e` parser never had, since Claude Code always sends valid JSON; no existing test
    //   exercises malformed input, so this adds safety without touching pinned behavior).
    parseEvent(stdinText) {
      try {
        const parsed = JSON.parse(stdinText);
        return { gate: true, loopActive: !!parsed && parsed.stop_hook_active === true };
      } catch {
        return { gate: false, loopActive: false };
      }
    },
    channels: { block: true, voice: true, residue: true },
    renderBlock(reason) { return JSON.stringify({ decision: 'block', reason, hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason } }); },
    renderVoice(msg) { return JSON.stringify({ systemMessage: msg }); },
    renderResidue(msg) { return JSON.stringify({ systemMessage: msg }); },
    // Claude Code's own stop_hook_active flag IS its loop guard — the memo one-shot mechanic below is for
    // harnesses that lack (or only partially cover) that protocol flag. Explicit so the field is never
    // silently absent; behavior must stay byte-identical to pre-Task-4 (test/agent-hook.test.mjs pins it).
    memoOneShot: false,
  },
  // Codex CLI's Stop hook: same stop_hook_active loop-guard semantics as Claude Code, but the block
  // channel is a plain {decision, reason} — Codex uses `reason` as the next turn's continuation prompt
  // and has no hookSpecificOutput envelope (that field is Claude-Code-specific). voice/residue: a
  // clean-run systemMessage on exit 0 is UNCONFIRMED for Codex, so both channels stay OFF — fail toward
  // silence, never toward noise, until a live pilot confirms the channel exists.
  codex: {
    parseEvent(stdinText) {
      try {
        const parsed = JSON.parse(stdinText);
        return { gate: true, loopActive: !!parsed && parsed.stop_hook_active === true };
      } catch {
        return { gate: false, loopActive: false };
      }
    },
    channels: { block: true, voice: false, residue: false },
    renderBlock(reason) { return JSON.stringify({ decision: 'block', reason }); },
    memoOneShot: false, // same reasoning as claude — stop_hook_active is the loop guard here too.
  },
  // Cursor's `stop` hook cannot block the turn: it returns {followup_message}, which Cursor auto-submits
  // as the NEXT USER message (Cursor caps auto-follow-ups via its own loop_limit, default 5). Protocol:
  // stdin {status: 'completed'|'aborted'|'error', loop_count}. Gate ONLY a clean completion — an
  // aborted/errored turn is not ours to re-prompt. loop_count>0 means Cursor already auto-submitted our
  // last followup_message and the agent stopped again on it: treat exactly like stop_hook_active (allow
  // the stop, never force a second retry from here). voice/residue stay OFF — a followup_message on a
  // clean run or a post-retry residue notice would re-open the turn, which is noise, not signal.
  //
  // memoOneShot: true — Cursor's own loop_count only catches a second stop after ITS OWN auto-resubmit;
  // nothing else stops runGate from blocking again on some LATER, unrelated stop event that happens to
  // still carry the SAME unfixed diff. The memo one-shot guard is the belt-and-braces backstop described
  // at the guard's implementation below.
  cursor: {
    parseEvent(stdinText) {
      try {
        const parsed = JSON.parse(stdinText);
        if (!parsed || parsed.status !== 'completed') return { gate: false, loopActive: false };
        return { gate: true, loopActive: Number(parsed.loop_count) > 0 };
      } catch {
        return { gate: false, loopActive: false };
      }
    },
    channels: { block: true, voice: false, residue: false },
    renderBlock(reason) { return JSON.stringify({ followup_message: reason }); },
    memoOneShot: true,
  },
  // GitHub Copilot coding agent's `agentStop` hook (aliased `Stop`), registered via repo files under
  // `.github/hooks/*.json` — must live on the DEFAULT branch — and executed inside the agent's own cloud
  // VM. The stdin payload carries NO loop-guard flag at all (unlike claude/codex's stop_hook_active), so
  // loopActive is always false and the memo one-shot guard below is the ONLY thing that can stop a second
  // block on an unfixed diff — mandatory, not a backstop. Gating mirrors claude/codex's own posture: any
  // stdin that parses as JSON counts as a valid agentStop event (the hooks.json registration is what
  // already scopes this script to that one event; no separate event-name field is documented to re-check
  // here) — malformed/empty stdin fails open, same as every other adapter.
  copilot: {
    parseEvent(stdinText) {
      try {
        JSON.parse(stdinText);
        return { gate: true, loopActive: false };
      } catch {
        return { gate: false, loopActive: false };
      }
    },
    // voice/residue MUST stay OFF: memoOneShot harnesses have no loop flag, so the stamp at the
    // `out !== null` site in runGate() below treats ANY non-null output as a block. Turning voice or
    // residue on here would let a clean-run or residue message get stamped blockedAt and then have its own
    // later message wrongly suppressed as "already blocked" — see that site's comment for the full
    // invariant.
    channels: { block: true, voice: false, residue: false },
    renderBlock(reason) { return JSON.stringify({ decision: 'block', reason }); },
    memoOneShot: true, // no loop-guard flag exists in the copilot protocol — mandatory, not a backstop.
  },
  // Google Antigravity's `Stop` hook, registered via `hooks.json` in `.agents/` (workspace-local) or
  // `~/.gemini/config/` (every session). stdin carries {terminationReason, fullyIdle, conversationId,
  // workspacePaths, ...} and NO loop-guard flag — memoOneShot is mandatory here too. Gate ONLY a clean,
  // fully-idle stop: terminationReason==='model_stop' && fullyIdle===true. NEVER gate 'error' or
  // 'max_steps_exceeded' — re-entering an already-broken loop from here is exactly how a gate becomes a
  // hang, not a fix.
  antigravity: {
    parseEvent(stdinText) {
      try {
        const parsed = JSON.parse(stdinText);
        if (!parsed || parsed.terminationReason !== 'model_stop' || parsed.fullyIdle !== true) {
          return { gate: false, loopActive: false };
        }
        return { gate: true, loopActive: false };
      } catch {
        return { gate: false, loopActive: false };
      }
    },
    // voice/residue MUST stay OFF — same invariant as copilot above (see that entry's comment and the
    // stamp-site comment in runGate() below).
    channels: { block: true, voice: false, residue: false },
    // Antigravity's verb for "prevent the stop and inject this text" is 'continue', not 'block' — same
    // {decision, reason} shape, different vocabulary.
    renderBlock(reason) { return JSON.stringify({ decision: 'continue', reason }); },
    memoOneShot: true, // no loop-guard flag exists in the antigravity protocol — mandatory, not a backstop.
    // Antigravity may invoke the hook with cwd pointed somewhere other than the workspace root, or with
    // multiple workspace roots open (only the first is used here — see the README's multi-root
    // limitation). workspacePaths[0], when present and a non-empty string, overrides the gate directory;
    // any other shape (absent, empty array, non-string entries, non-array value) falls back to cwd rather
    // than throwing or silently gating nothing. This is the one optional per-harness hook runGate() reads
    // (see its use below) — inert for every harness that doesn't define it.
    dirFromEvent(stdinText) {
      try {
        const parsed = JSON.parse(stdinText);
        const wp = parsed && parsed.workspacePaths;
        if (Array.isArray(wp) && typeof wp[0] === 'string' && wp[0].length > 0) return wp[0];
      } catch {}
      return null;
    },
  },
};

// ---- git plumbing (argv-form execFileSync only — never a shell string) ----
function gitOut(dir, args, input) {
  try { return execFileSync('git', ['-C', dir, ...args], { input, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' }).trim(); }
  catch { return null; }
}
function gitOutRaw(dir, args) {
  try { return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }); }
  catch { return ''; }
}
function gitOk(dir, args) {
  try { execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function gitHashObjectStdin(input) {
  try { return execFileSync('git', ['hash-object', '--stdin'], { input, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

// Per-repo opt-out: honored from cwd up to the git toplevel, so a repo-root .gutcheck-off also covers an
// agent working in a subdirectory/package of the repo. Bounded: stops at the git toplevel (normal case),
// at `dir` itself when the toplevel is unresolvable, and — belt-and-braces — at the dirname fixpoint
// ("/"), so a pathological env can never spin this loop forever.
function gutcheckOffUpTree(dir) {
  const top = gitOut(dir, ['rev-parse', '--show-toplevel']) || dir;
  let d = dir;
  for (;;) {
    if (existsSync(join(d, '.gutcheck-off'))) return true;
    if (d === top) break;
    const p = dirname(d);
    if (p === d) break;
    d = p;
  }
  return false;
}

// Shared by both the loop-guard's read-only memo consult and the main path's probe cache: computes the
// session BASELINE, then the diff-scoped memo path + key. Pure git/stat plumbing — never probes, never
// writes. Fails soft: any git error leaves memo/memoKey null, so every caller degrades cleanly to "no memo".
function memoLookup(dir) {
  let baseline = 'HEAD';
  const gitDirRel = gitOut(dir, ['rev-parse', '--git-dir']);
  let gitDirAbs = null;
  if (gitDirRel) {
    gitDirAbs = isAbsolute(gitDirRel) ? gitDirRel : join(dir, gitDirRel);
    const baselineFile = join(gitDirAbs, 'gutcheck-baseline');
    if (existsSync(baselineFile)) {
      let cand = '';
      try { cand = readFileSync(baselineFile, 'utf8').replace(/\s/g, ''); } catch {}
      if (cand && gitOk(dir, ['cat-file', '-e', `${cand}^{commit}`])) baseline = cand;
    }
  }
  // Memoize per diff-hash: Stop fires every turn of a long session; an unchanged diff must not re-probe.
  // Key = tracked diff vs baseline + untracked-file identity (path/size/mtime — editing an untracked test
  // file changes its mtime). Payload = the raw prove JSON. Any failure → re-probe.
  let memo = null, memoKey = null;
  if (gitDirAbs) {
    // Scope-key the memo FILE (not just the key inside it) by working directory: two sessions in
    // different packages of one repo share the git-dir, so a fixed filename means the second session's
    // write clobbers the first's cache outright. Fall back to the unsuffixed name if hashing fails.
    const scopeSuffix = (gitHashObjectStdin(dir) || '').slice(0, 12);
    memo = scopeSuffix ? join(gitDirAbs, `gutcheck-memo-${scopeSuffix}`) : join(gitDirAbs, 'gutcheck-memo');
    const diffOut = gitOutRaw(dir, ['diff', baseline]);
    const untrackedOut = gitOutRaw(dir, ['ls-files', '--others', '--exclude-standard']);
    // fs.statSync (size + mtimeMs) REPLACES the bash hook's GNU-first `stat -c || stat -f` dance (one
    // portable call instead of two OS-specific ones). This changes the untracked-file KEY DERIVATION
    // relative to the old bash version — a one-time memo MISS on upgrade per repo (harmless: it just
    // re-probes once), never a behavior change. The tracked-diff leg (the only leg most memo keys ever
    // exercise) is untouched — see the memo cross-version tests in test/gate-core.test.mjs.
    const untrackedLines = untrackedOut.split('\n').filter(Boolean).map((f) => {
      try {
        const st = statSync(join(dir, f));
        return `${f} ${st.size} ${Math.floor(st.mtimeMs / 1000)}`;
      } catch { return ''; }
    }).filter(Boolean).join('\n');
    const combined = diffOut + (untrackedLines ? untrackedLines + '\n' : '');
    memoKey = gitHashObjectStdin(combined);
  }
  return { baseline, memo, memoKey };
}

function readMemo(memo, memoKey) {
  if (!memo || !memoKey || !existsSync(memo)) return null;
  let text; try { text = readFileSync(memo, 'utf8'); } catch { return null; }
  const nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  if (firstLine !== memoKey) return null;
  const payload = nl === -1 ? '' : text.slice(nl + 1);
  return payload || null;
}
function writeMemo(memo, memoKey, payload) {
  if (!memo || !memoKey) return;
  try { writeFileSync(memo, `${memoKey}\n${payload}`); } catch {}
}

// RESIDUE SIGNAL (loop-guard retry turn): the agent used its one forced retry and either didn't fix the
// flagged hollow(s) or the diff is otherwise unchanged. Consult the memo the block turn wrote — NEVER
// re-probe (this path must stay instant and must never itself trigger another block/retry cycle). Ported
// verbatim from the bash hook's second embedded `node -e` program.
function buildResidue(jsonText, harness) {
  let r; try { r = JSON.parse(jsonText); } catch { return null; }
  const h = (r && r.hollow) || [];
  const failing = ((r && r.inconclusive) || []).filter((i) => /^baseline /.test(i.why));
  const failingReal = (r && r.scored > 0) ? failing : []; // scored>0 = the runner demonstrably works
  const all = h.concat(failingReal);
  if (!all.length) return null;
  const items = all.map((x) => `${x.file}:${x.line} '${x.name}'`);
  const shown = items.slice(0, 3).join(', ');
  const more = items.length > 3 ? ` +${items.length - 3} more` : '';
  const msg = `gutcheck: finishing with ${all.length} still-hollow test(s) flagged and not fixed: ${shown}${more}`;
  return harness.channels.residue ? harness.renderResidue(msg) : null;
}

// Parse the prove JSON and, if there are proven-hollow tests OR genuinely-failing changed tests, build a
// Stop-hook block. Already-failing tests (the `baseline Xp/Yf` bucket) block ONLY when another block
// SCORED: a working runner proves those failures are the tests' own, while an ALL-baselines-failed
// wipeout usually means the runner cannot run them at all and must never nag the agent over runner noise.
// Ported verbatim from the bash hook's third embedded `node -e` program (the block+clean-voice builder).
function buildVerdict(jsonText, harness) {
  let r; try { r = JSON.parse(jsonText); } catch { return null; }
  const h = (r && r.hollow) || [];
  const failing = ((r && r.inconclusive) || []).filter((i) => /^baseline /.test(i.why));
  const failingReal = (r && r.scored > 0) ? failing : []; // scored>0 = the runner demonstrably works
  if (!h.length && !failingReal.length) {
    // Nothing to block — the hook is otherwise silent, so on the common clean run give it a voice: a
    // NON-BLOCKING systemMessage, but only when the agent actually changed probeable functions
    // (r.changeSummary present with fns>0). No changed function stays exactly as silent as before.
    const cs = r && r.changeSummary;
    if (cs && cs.fns > 0) {
      const unverifiable = cs.unverifiable || 0;
      const sameDiffProven = cs.sameDiffProven || 0;
      const notProbed = cs.notProbed || 0;
      const provenPart = sameDiffProven > 0 ? ` (${sameDiffProven} via tests changed in this diff)` : '';
      const notProbedPart = notProbed > 0 ? `, ${notProbed} not probed (cap)` : '';
      const msg = `gutcheck: of ${cs.fns} function(s) you changed — ${cs.proven} proven${provenPart}, ${cs.untested} with no binding test${unverifiable > 0 ? `, ${unverifiable} unverifiable` : ''}${notProbedPart}. (npx gutcheck --explain <file:line> for a receipt.)`;
      return harness.channels.voice ? harness.renderVoice(msg) : null;
    }
    return null;
  }
  const parts = [];
  if (h.length) {
    // Disambiguate the survivor by its SUT file when the pair evidence is present (survivorPairs); an old
    // cached memo written before this fix has hollow entries with no survivorPairs at all, so this falls
    // back to the bare-name rendering rather than crashing or printing "undefined".
    const lines = h.map((x) => {
      const pairs = x.survivorPairs;
      const who = (pairs && pairs.length) ? pairs.map((p) => `${p.fn}() (${p.sutRel})`).join(', ') : `${(x.survivors || []).join(', ')}()`;
      return `  - ${x.file}:${x.line} '${x.name}' — stays green even when ${who} returns a wrong value.`;
    });
    parts.push(
      `gutcheck: ${h.length} test(s) you just changed are HOLLOW — they pass even when the function is gutted, ` +
      `so they don't actually test it. Fix them (receipt: gutcheck --explain <file:line>): assert the real expected ` +
      `value (not one re-derived from the function under test), then finish:\n${lines.join('\n')}`);
  }
  if (failingReal.length) {
    // Append a sanitized one-line tail of the runner's own captured output — the last 3 non-empty lines,
    // joined and capped, so the agent sees the real failure text instead of just a pass/fail count. TAP
    // bookkeeping (`#...`/plan lines) is dropped first so the kept last-3 carries real signal.
    const lines = failingReal.map((x) => {
      const tapNoise = /^\s*(#|\d+\.\.\d+)/;
      const tail = x.detail ? String(x.detail).trim().split('\n').filter((l) => l.trim() && !tapNoise.test(l)).slice(-3).join(' | ').slice(0, 300) : '';
      return `  - ${x.file}:${x.line} '${x.name}' (${x.why})${tail ? ` — runner said: ${tail}` : ''}`;
    });
    parts.push(
      `gutcheck: ${failingReal.length} test(s) you just changed already fail before any mutation — they verify nothing until they pass. ` +
      `Run them and fix the failure before finishing:\n${lines.join('\n')}`);
  }
  const reason = parts.join('\n\n');
  return harness.channels.block ? harness.renderBlock(reason) : null;
}

// runGate({ harnessName, dir, stdinText, env }) -> string|null   (the stdout payload, null = silence)
export function runGate({ harnessName, dir, stdinText, env = {} }) {
  const harness = HARNESSES[harnessName];
  if (!harness) return null; // unknown harness → fail-open, silent

  let event;
  try { event = harness.parseEvent(stdinText); } catch { event = { gate: false, loopActive: false }; }
  if (!event || !event.gate) return null;

  // Optional per-event dir resolution (antigravity's workspacePaths override — see that entry above): a
  // flag-like hook that is inert for every harness that doesn't define `dirFromEvent`, so `gateDir` is
  // exactly `dir` unchanged for claude/codex/cursor/copilot.
  let gateDir = dir;
  if (harness.dirFromEvent) {
    let override = null;
    try { override = harness.dirFromEvent(stdinText); } catch { override = null; }
    if (override) gateDir = override;
  }

  let realDir; try { realDir = realpathSync(gateDir); } catch { realDir = gateDir; } // match the bash hook's `pwd -P` (physical path)

  if (gutcheckOffUpTree(realDir)) return null;
  if ((env.GUTCHECK_HOOK || '') === 'off') return null;
  if (!gitOut(realDir, ['rev-parse', '--git-dir'])) return null; // not a repo, or git itself is unavailable

  if (event.loopActive) {
    // LOOP GUARD: the agent already got its one forced attempt — allow the stop, never block again.
    const { memo, memoKey } = memoLookup(realDir);
    const residueJson = readMemo(memo, memoKey);
    if (!residueJson) return null;
    return buildResidue(residueJson, harness);
  }

  const { baseline, memo, memoKey } = memoLookup(realDir);
  let json = readMemo(memo, memoKey) || '';
  if (!json) {
    // Single front door: self-check included (a broken probe exits 2 with empty stdout → fail-open
    // below), no full-suite fallback (a Stop must stay fast), probe cap + time budget bound worst-case
    // latency under the harness's own timeout.
    try {
      json = execFileSync(process.execPath, [
        GUTCHECK_PATH, realDir, '--json', '--no-fallback', `--since=${baseline}`, '--max-probes=20', '--time-budget=90',
      ], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    } catch (e) { json = (e && e.stdout) ? e.stdout.toString() : ''; }
    // Never memoize a run that didn't happen: a scopeError payload (probe-lock refusal, unresolvable
    // scope) cached under this diff-hash would suppress every later gate on the same diff. Unparseable
    // output is equally uncacheable — never-cache-empty extends to never-cache-broken. The payload still
    // flows to buildVerdict below, which yields on it (no hollow rows → no block).
    let ranReal = false; try { ranReal = !JSON.parse(json).scopeError; } catch {}
    if (json && ranReal) writeMemo(memo, memoKey, json);
  }
  if (!json) return null;

  // MEMO ONE-SHOT GUARD (flag-gated on harness.memoOneShot — claude/codex never set it, so this whole
  // block is inert for them: no read, no write, byte-identical behavior, per test/agent-hook.test.mjs).
  // Scoped by memoKey (the diff-hash), not by harness name: `blockedAt` rides on the SAME memo payload the
  // probe result already lives in, keyed the same way, so it survives independently of which one-shot
  // harness wrote it. An old-format payload with no `blockedAt` field (written before this guard existed,
  // or by a harness that never sets it) parses to `undefined`, which never equals memoKey — so it blocks
  // normally the first time any one-shot harness sees it, then gets stamped for next time.
  if (harness.memoOneShot) {
    let prior; try { prior = JSON.parse(json); } catch { prior = null; }
    if (prior && prior.blockedAt === memoKey) return null; // already blocked once on this exact diff — refuse to reblock
  }

  const out = buildVerdict(json, harness);
  if (harness.memoOneShot && out !== null) {
    // CONSTRAINT, not an observation: every memoOneShot harness MUST keep voice and residue OFF. This
    // stamp treats ANY non-null `out` as a block — it has no way to tell a block apart from a clean-voice
    // message from here. If a memoOneShot harness ever turned voice on, a clean run would get stamped
    // blockedAt and then have its OWN later voiced message wrongly suppressed as "already blocked". Given
    // the constraint holds (every memoOneShot harness above keeps voice off), buildVerdict's clean-voice
    // branch always returns null for them, so out !== null can only be the block branch — but that
    // conclusion depends on the constraint; it does not enforce it. Stamp blockedAt and persist so the
    // very next stop on this same diff-hash is refused above instead of blocking twice. If the payload
    // fails to (re)parse, skip the write rather than risk replacing a good cache with something malformed
    // or empty — the block we already computed above still returns; worst case is one extra unguarded
    // block next time, never a corrupted memo (never-cache-empty).
    let stamped; try { stamped = JSON.parse(json); } catch { stamped = null; }
    if (stamped) { stamped.blockedAt = memoKey; writeMemo(memo, memoKey, JSON.stringify(stamped)); }
  }
  return out;
}
