// Fast exact line diff: returns makefun-diff 1.0.0's patch of { old, new }.
//
// The rule, in short: cut both texts into lines after every "\n" (a last line
// without one is a line too), keep the longest common prefix, then the longest
// common suffix of what is left, and diff the middle with Myers's greedy search
// (furthest point per diagonal, deletion winning a tie, no edge pruning, snakes
// followed to the end). Then render the patch: one header line, hunks of at most
// 3 kept lines of context around each change run, runs at most 6 kept lines
// apart sharing a hunk, deletions before insertions, "%" after a line that ends
// its text without a newline, and the header alone when the texts are identical.
//
// How this is fast (same answers, less work than the reference):
//   - Lines are interned to small integer ids once, in two namespaces: lines
//     that end with "\n" and the one bare last line, which are different lines
//     even when their characters match. Every later comparison is then an
//     integer comparison, and the Myers search never touches a string.
//   - The search keeps its V trace in one flat Int32Array that is reused across
//     cases (it grows by doubling when a larger edit distance needs it), so no
//     per-depth allocation and no garbage per case. A stored value is x+1, the
//     old lines consumed plus one, so 0 means "no path here" and a fresh buffer
//     needs no clearing beyond the few slots the search itself writes.
//   - The search and the backtrack that recovers the edit script both use the
//     same tie-break the rule states, so the script is the rule's script, not
//     merely a shortest one.
//
// Everything is fixed-effort: no clock, no randomness, no environment reads
// feed into any decision, so two runs return byte-identical answers. No
// dependencies, no network, no file reads.

/** The patch's first word, and the context a hunk shows around a change run. */
const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;

/** A line's op in the patch. */
const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

/** Run kinds in the recovered edit script. */
const RUN_KEEP = 0;
const RUN_DELETE = 1;
const RUN_INSERT = 2;

// ---------------------------------------------------------------- interning

/**
 * The lines of one text, each as an integer id, plus the line's characters.
 * Two namespaces keep a bare last line ("abc") apart from a terminated line
 * ("abc\n"): they are different lines, so they must never share an id.
 */
function tokenize(text, internTerminated, internBare, linesById) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const count = last + (parts[last] !== '' ? 1 : 0);
  const ids = new Int32Array(count);
  const strs = new Array(count);
  for (let i = 0; i < last; i++) {
    const part = parts[i];
    let id = internTerminated.get(part);
    if (id === undefined) {
      id = linesById.length;
      internTerminated.set(part, id);
      linesById.push(part + '\n');
    }
    ids[i] = id;
    strs[i] = linesById[id];
  }
  if (parts[last] !== '') {
    const part = parts[last];
    let id = internBare.get(part);
    if (id === undefined) {
      id = linesById.length;
      internBare.set(part, id);
      linesById.push(part);
    }
    ids[last] = id;
    strs[last] = linesById[id];
  }
  return { ids, strs };
}

// ---------------------------------------------------------------- the search

/**
 * The V trace, one flat buffer reused across cases. V[d] starts at
 * d*d + 4*d and holds 2d+5 slots; slot j = k+d+2 carries diagonal k's stored
 * value, x+1 (0 = no path). Slots 0, 1 and 2d+3, 2d+4 are padding, always 0,
 * so the edge diagonals read a "no path" there without a special case.
 * The buffer grows by doubling when a deeper search needs more room.
 */
const trace = {
  buf: new Int32Array(4096 * 4096 + 6 * 4096 + 5),
  cap: 4096,
};

/** Grow the trace buffer so depth d fits, carrying the depths written so far. */
function traceGrow(d) {
  while (d > trace.cap) {
    const nextCap = trace.cap * 2;
    const next = new Int32Array(nextCap * nextCap + 6 * nextCap + 5);
    next.set(trace.buf);
    trace.buf = next;
    trace.cap = nextCap;
  }
}

/**
 * Myers's greedy search over the interned middle slices A[0..N), B[0..M),
 * returning the merged edit runs [{ kind, count }] in order. The forward pass
 * stores every depth's V row in the trace; the backtrack then walks it from
 * the end, re-deciding each depth's edit with the same rule the forward pass
 * used, so the recovered script is the forward pass's own script.
 */
function myersRuns(A, B, N, M) {
  if (N === 0 && M === 0) return [];
  let buf = trace.buf;
  // Depth 0: the snake from the start of both slices.
  let x = 0;
  let y = 0;
  while (x < N && y < M && A[x] === B[y]) {
    x++;
    y++;
  }
  buf[0] = 0;
  buf[1] = 0;
  buf[2] = x + 1;
  buf[3] = 0;
  buf[4] = 0;
  if (x >= N && y >= M) return [];
  const kf = N - M;
  let D = -1;
  for (let d = 1; d <= N + M; d++) {
    traceGrow(d);
    buf = trace.buf;
    const base = d * d + 4 * d;
    const pbase = (d - 1) * (d - 1) + 4 * (d - 1);
    const top = 2 * d + 2;
    // An insertion from diagonal k+1 is valid while the new lines it would
    // consume stay inside the new slice: stored <= M + j - d - 1 at slot j.
    let limj = M - d + 1;
    // yy = xx - k, and k = j - d - 2, so yy = xx - j + d + 2.
    const offc = d + 2;
    // The deletion candidate of slot j is the previous slot's insertion
    // candidate, so it rides along instead of being read twice.
    let sm = 0;
    for (let j = 2; j <= top; j += 2) {
      const sp = buf[pbase + j];
      // Deletion's x is sm (stored x+1 of the path it extends); insertion's
      // is sp - 1. An invalid candidate reads -1 and loses; on a tie the
      // deletion wins, which is the rule's tie-break.
      const dv = sm !== 0 && sm <= N ? sm : -1;
      const iv = sp !== 0 && sp <= limj ? sp - 1 : -1;
      let xx = dv >= iv ? dv : iv;
      if (xx < 0) {
        buf[base + j] = 0;
        sm = sp;
        limj += 2;
        continue;
      }
      let yy = xx - j + offc;
      while (xx < N && yy < M && A[xx] === B[yy]) {
        xx++;
        yy++;
      }
      buf[base + j] = xx + 1;
      sm = sp;
      limj += 2;
    }
    buf[base + 0] = 0;
    buf[base + 1] = 0;
    buf[base + top + 1] = 0;
    buf[base + top + 2] = 0;
    // Only the final diagonal can have reached both ends.
    if (kf >= -d && kf <= d) {
      const jf = kf + d + 2;
      if ((jf & 1) === 0 && buf[base + jf] === N + 1) {
        D = d;
        break;
      }
    }
  }
  if (D < 0) throw new Error('diff: the search ended without reaching both ends');

  // Backtrack: from (D, kf) down to (0, 0), re-deciding each depth's edit.
  const rev = [];
  let d = D;
  let j = kf + D + 2;
  x = buf[D * D + 4 * D + j] - 1;
  while (d > 0) {
    const pbase = (d - 1) * (d - 1) + 4 * (d - 1);
    const xm = buf[pbase + j - 2];
    const xp = buf[pbase + j];
    const canDel = xm !== 0 && xm <= N;
    const canIns = xp !== 0 && xp <= M + j - d - 1;
    const isDel = canDel && (!canIns || xm + 1 >= xp);
    const xs = isDel ? xm : xp - 1;
    const snake = x - xs;
    if (snake > 0) rev.push([RUN_KEEP, snake]);
    rev.push([isDel ? RUN_DELETE : RUN_INSERT, 1]);
    x = xs - (isDel ? 1 : 0);
    j = isDel ? j - 2 : j;
    d--;
  }
  if (x > 0) rev.push([RUN_KEEP, x]);
  // Reverse, merging neighbours of one kind.
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const [kind, count] = rev[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === kind) last[1] += count;
    else runs.push([kind, count]);
  }
  return runs;
}

// ---------------------------------------------------------------- the patch

/** make.fun's own patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('diff: the input is { old, new }, two strings');
  }
  const internTerminated = new Map();
  const internBare = new Map();
  const linesById = [];
  const a = tokenize(input.old, internTerminated, internBare, linesById);
  const b = tokenize(input.new, internTerminated, internBare, linesById);
  const n = a.ids.length;
  const m = b.ids.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a.ids[prefix] === b.ids[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a.ids[n - 1 - suffix] === b.ids[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push([RUN_KEEP, prefix]);
  for (const r of myersRuns(a.ids.subarray(prefix, n - suffix), b.ids.subarray(prefix, m - suffix), n - prefix - suffix, m - prefix - suffix)) {
    runs.push(r);
  }
  if (suffix > 0) runs.push([RUN_KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const [kind, count] of runs) {
    if (kind === RUN_KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === RUN_DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) {
        const line = a.strs[at];
        if (line.endsWith('\n')) out.push(KEEP, line);
        else out.push(KEEP, line, '\n%\n');
      }
      for (let i = 0; i < c.dels; i++) {
        const line = a.strs[c.o + i];
        if (line.endsWith('\n')) out.push(DELETE, line);
        else out.push(DELETE, line, '\n%\n');
      }
      for (let i = 0; i < c.ins; i++) {
        const line = b.strs[c.p + i];
        if (line.endsWith('\n')) out.push(INSERT, line);
        else out.push(INSERT, line, '\n%\n');
      }
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) {
      const line = a.strs[at];
      if (line.endsWith('\n')) out.push(KEEP, line);
      else out.push(KEEP, line, '\n%\n');
    }
  }
  return out.join('');
}
