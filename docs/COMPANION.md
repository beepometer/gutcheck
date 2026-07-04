# Running Gutcheck alongside superpowers

Gutcheck's skill format was adapted from [superpowers](https://github.com/obra/superpowers), but Gutcheck no
longer ships a methodology layer — the inherited brainstorming / planning / TDD / debugging / review skills have
been removed. So the two now **compose cleanly**: there is almost nothing left to collide.

## The division of labor

- **superpowers = the capability layer.** It makes the agent *capable*: brainstorm → plan → implement → TDD →
  debug. It drives the work.
- **Gutcheck = the verification layer.** The deterministic checker + self-testing meta-guard, the mutation probe,
  the verify-as-you-write Stop-hook loop, and a small set of verification disciplines (oracle construction,
  citation and input verification). It checks the work.

superpowers *writes* the test; Gutcheck *proves it isn't hollow*. One drives, the other verifies.

## Setup

Just install both. Gutcheck contributes its mechanical core — the `gutcheck` mutation probe, the `gutcheck
lint` static triage, and the opt-in `Stop`-hook loop that re-probes the tests an agent just changed — none of
which duplicates superpowers' methodology. The only residual overlap is around test review; Gutcheck's verdict
is execution-proven (it breaks the function under test and watches whether the test notices), so prefer it for
test soundness. There is no methodology collision left to manage.
