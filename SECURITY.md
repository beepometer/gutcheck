# Security Policy

## What Gutcheck is, security-wise

Gutcheck is a local developer tool: a CLI (also packaged as a GitHub Action and a Claude Code
plugin) that verifies a diff by mutating copies of your functions and rerunning your own tests. It
exposes no network services and sends no telemetry. The npm package has no dependencies and no
install scripts.

The security-relevant surface:

- The probe executes the repository's own test code, exactly as running the test suite yourself
  would. Point it only at repositories whose tests you would run anyway.
- Mutations are applied to a temporary work copy, never to your checkout.
- The Claude Code plugin's session hook writes one file, `gutcheck-baseline`, inside the
  repository's `.git` directory; the Stop hook runs the probe with a 120-second budget and can be
  disabled per repo with a `.gutcheck-off` file.
- The GitHub Action runs the probe on the checked-out ref with the workflow's own permissions; it
  needs `pull-requests: write` only for the sticky comment.

## CI deployment posture

- Keep the workflow trigger as `on: pull_request` (as shipped in [`ci/gutcheck.yml`](ci/gutcheck.yml)
  and in the `beepometer/gutcheck` action). GitHub withholds repository secrets from fork-PR runs on
  this trigger.
- Never rewire it to `pull_request_target` with a checkout of the PR head. That combination runs
  untrusted test code with your repository's secrets; no input of this action needs them.
- Pin `uses: beepometer/gutcheck@...` to a released tag or a full commit SHA rather than a mutable
  ref.

The action's `fail-on-hollow` input (default `'true'` — see [action.yml](action.yml)) can be set to
`'false'` for an advisory-only mode that reports without failing the job.

## Reporting a vulnerability

Report privately via a
[GitHub Security Advisory](https://github.com/beepometer/gutcheck/security/advisories/new) rather
than a public issue, so it can be triaged before disclosure.

## Supported versions

Gutcheck is pre-1.0; only the latest released version receives fixes.
