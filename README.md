# diff-speed-01-run-20261126

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/Siksuk72/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/Siksuk72/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A fast, exact drop-in for makefun-diff 1.0.0: it returns make.fun's own patch of
two texts, byte for byte, in a fraction of the house baseline's CPU time.

## How it works

`solve.js` (dependency-free, no network, no file reads) diffs two texts by the
rule in the kit: lines cut after every `\n`, longest common prefix then
suffix, then Myers's greedy search with deletion winning ties, and the patch
rendered with 3 lines of context, hunks merged across at most 6 kept lines,
`%` after a line that ends its text without a newline.

Three things make it fast:

1. **Lines are interned to integer ids once** — in two namespaces, so a bare
   last line never collides with the same characters ending in `\n`. Every
   comparison after that is an integer comparison; the search never touches a
   string.
2. **The Myers search keeps its V trace in one flat `Int32Array` reused
   across cases** (it grows by doubling when a larger edit distance needs
   it), so there is no per-depth allocation and no garbage per case. A stored
   value is `x+1`, so `0` means "no path here".
3. **The backtrack re-decides each depth's edit with the same rule the
   forward pass used**, so the recovered script is the rule's own script, not
   merely a shortest one.

Everything is fixed-effort — no clock, no randomness, no environment reads —
so two runs return byte-identical answers. `main.ts` reads every case from
`/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir for answers.json> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards</sub>
