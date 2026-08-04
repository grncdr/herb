# Dev Journal — ERB control-flow / block whitespace formatting

Context: the significant-whitespace bug family (see
`javascript/packages/formatter/test/html/whitespace-preservation.test.ts`,
issues #1729, #469, #609, …). Four cases were still reproducing on `main` and
tracked as `test.fails`. Goal: make them pass without regressing other
formatter specs, with minimal changes.

## Fixed upstream (our patch was superseded — 2026-07-30)

**Case A — #1729:** text directly following an ERB output inside an `if` block
(`<%= user.name %>'s dog`) was split onto its own line.

**Case C — #1729 / @grncdr:** a comma (and adjacent `<br>`) directly after an
ERB output inside an `if` block was pushed onto its own line.

Root cause: `visitERBIfNode` / `visitERBElseNode` rendered statements with a
bare `visitAll(node.statements)`, so every statement landed on its own line and
any text/punctuation directly touching the preceding ERB was separated from it.

We fixed this locally by rendering control-flow statements through
`visitElementChildren` in a "control-flow mode" that appended
source-adjacent content via a new `isSourceAdjacentToPrevious` predicate.
**That commit was dropped when rebasing onto upstream**, because upstream
fixed both cases independently in #1863 ("don't add or remove whitespace at
glued content boundaries") and #1884 ("preserve whitespace for inline element
edges punctuation"), and arrived at a cleaner factoring of the same idea:
`visitStatements` + `visitElementChildren(body, parent, { allowBlankLines })`.
Verified before dropping: with upstream's printer alone, both fixture cases
pass. The fixtures remain as regression guards, now crediting the upstream
issues.

## Deferred (need architectural changes — NOT attempted)

**Case D — #609:** `<%= tag.span do %>This should stay on one line<% end %>`
should stay on one line; it is currently expanded to three lines.

This is a *known, documented* limitation, not an oversight. The existing spec
`test/html/text-content.test.ts:382` ("ERB block tag with inline content should
stay on one line") asserts the current multiline output and carries the TODO:
*"we need to wait for the parser to transform this as a HTMLElementNode"* plus
`// TODO: expect(result).toEqual(source)`. The design keeps `do`/`end` blocks
multiline (see the `<%= link_to "/" do %>…<% end %>` specs in
`test/erb/erb.test.ts`, which expect expansion). Inlining `tag.*` helper blocks
requires the parser to emit an `HTMLElementNode` for them; a formatter-only fix
would contradict an existing passing spec (i.e. cause a regression). Blocked on
parser work — out of scope for a minimal, regression-free formatter change.

**Case B — #1729 (second example):**
```erb
<p>
  Hello<% if owner %> <%= owner.name %>'s dog<% end %>!
  It's time for your walk.
</p>
```
The inline `<% if %>…<% end %>` is embedded mid-text in a paragraph. With the
Case A/C fix the inner text is now glued correctly, but the whole `if` is still
pulled onto its own line. That reintroduces a rendered space in the falsy
branch: with `owner` falsy the source renders `Hello!`, but the reformatted
output renders `Hello !` (the newline between `Hello` and the empty `if` becomes
a space). So the current output is genuinely wrong for this case, not merely
cosmetically different.

A correct fix requires the text-flow engine to treat an `ERBIfNode` (and its
`elsif`/`else` chain) as an *inline atomic unit* that participates in the
parent's text flow and renders inline when it fits — today `isTextFlowNode`
only accepts `ERBContentNode`, inline `HTMLElementNode`, and text. This is a
substantial change to the analyzer + engine + inline rendering of control flow,
with a high regression risk against the large existing if/block spec suite. The
issue reporter themselves noted they are "not picky … as long as it doesn't
change what gets rendered," but exact preservation needs the inline treatment.
Deferred as a larger, separately-scoped change.

Both deferred cases remain `test.fails` in the fixtures file, documenting the
target behavior and the blocking reason.

---

# Dev Journal — Doc-IR spike (2026-07-13)

Implementing the spike from DOC-IR-DESIGN.md §7. Modules live in
`javascript/packages/formatter/src/doc-ir/`; the current formatter is not
touched.

## doc.ts + layout.ts

- `doc.ts`: the IR from §3 verbatim, plus `join` and `literalText` (splits
  newline-containing strings into `literalline`-separated parts, since Doc
  strings must not contain newlines).
- `layout.ts`: independent port of Prettier's `printDocToString` semantics —
  command stack of `[indent, mode, doc]`, `propagateBreaks` pre-pass,
  bounded-lookahead `fits()`, Prettier's pairwise fill algorithm (measure
  `[content, sep, nextContent]` to decide each separator), lineSuffix
  buffering flushed at line breaks and at end of document, trailing-whitespace
  trim on break emission (indentation-only lines become empty — this is what
  makes blank lines come out clean).
- No `align`/`indentIfBreak`/`trim` variants — not needed by the lowering
  sketches; add on demand.
- Gotcha caught by unit tests: my own width arithmetic, twice — the engine was
  right and the test expectations were wrong. `fits()` measures against
  `maxLineLength` inclusive (a line of exactly 80 cols is legal), matching the
  current formatter's `<=` checks.

## gaps.ts + lower.ts + harness (iteration log)

Corpus: instrument `Formatter.format` during a full suite run (971 unique
inputs); replay both printers per input, categorize diffs, check idempotency
and reparse-equality (structural signature, whitespace/quote/ERB-spacing
normalized). Key metric additions: `spikeOnlyReparseDiff` (inputs where the
spike changes parse structure but the current formatter doesn't — the true
regression list) and a current-formatter reparse baseline (~140/860 inputs
reparse-differ under the current formatter too, all text-edge whitespace at
block boundaries).

Bugs found by the harness, in order:

1. **Parser drops whitespace nodes inside open tags** (`<div <% if %> a="1"`):
   sibling-walk classification saw everything glued. Fix: classifier reads
   the source text between node locations (lines 1-based, columns 0-based);
   sibling walk stays as fallback. This is why `LowerOptions.source` exists.
2. **Punctuation gluing was wrong**: current formatter *preserves* `Lorem .`
   (space before punctuation); my always-glue rule over-applied. Source gaps
   decide; no punctuation special-case at all.
3. **Inline elements inside fill runs must be atoms**: a too-long
   `<strong>…</strong>` was breaking internally mid-flow. Atoms render flat
   (unbounded width) unless they contain hard breaks or lineSuffixes.
4. **`<br>`/`<hr>` end the visual line**: split the fill at line-breaking
   elements, joined with group-mode separators (breaks when the paragraph
   breaks, keeps authored spacing when it fits inline).
5. **`<%%>` hazard**: empty ERB tags must keep one inner space — `<%%>` is
   the ERB literal-escape and wasn't a formatting fixpoint (the current
   formatter emits `<%%>`; the spike diverges deliberately).
6. **HTMLConditionalOpenTagNode** fell through to IdentityPrinter, which
   mangles it (`<divclass="a">` — whitespace nodes are gone). Lowered via its
   inner conditional; the generic if-lowering produces exactly the expected
   shape.
7. **Whitespace-sensitivity at inline-element boundaries**: glued boundaries
   of inline elements must never break (a newline there adds rendered
   whitespace). They lower to plain concatenation; over-long lines are the
   lesser evil (same trade-off as the current formatter).
8. **case/when hardcoded hardlines** broke authored-inline
   `<span><% case %>…</span>` (rendering change). Now gap-driven like
   if/else; multiline-authored cases still produce the classic layout.
9. **herb:disable placement**: same-source-line comments become lineSuffixes
   (they land at the end of whatever line their anchor ends up on — including
   after a broken open tag's `>`); own-line comments stay put and never join
   fill runs; leading suffixes require an opening anchor (document-level
   `herb:disable` headers stay at the top). lineSuffix docs are never baked
   into flattened atoms.
10. **Attribute-position control flow normalizes glued boundaries to spaces**:
    `id="a"<% if %>class=…` would render invalid HTML; the current formatter
    repairs this and so do we.
11. **Authored multi-line class values** (>80 normalized) keep their authored
    line structure, matching `formatClassAttribute`; width-driven token
    wrapping applies otherwise.

Harness snapshot after these fixes: 81.7% exact, 89.5% exact+blank-only-diff,
0 idempotency failures, 1 spike-only reparse diff (a case where the *current*
formatter under-measures conditional attributes and emits a 90-col line; the
spike breaks the body instead — rendering-equivalent for a block element).
Spike is ~20% faster than the current printer on the corpus.

Second iteration round (12–16): byte-column decoding for the source index
(the parser reports UTF-8 byte columns; "Français" was shifting every gap
slice on its line), br/hr starting fresh visual lines when preceded by
whitespace, ERB yield/render-without-body treated as ERB leaves in text flow
and merging, block-level child elements forcing the parent body open
(matches current), content-preserving open tags staying flat only while they
themselves fit, and the design's one blank-line insertion exception after
doctype/XML declarations.

## Final spike numbers (2026-07-13)

860 corpus inputs compared: **84.2% exact**, **92.1%** exact+blank-policy,
15 layout-only, 53 content diffs — every one in a documented category (see
DOC-IR-DIVERGENCES.md). **0 idempotency failures (860/860)**, **1 spike-only
reparse divergence** (deliberate non-replication of a current-printer width
bug), 0 crashes. Corpus wall-time 408ms vs 461ms for the current printer —
and that is with lowering re-rendering atoms via the layout engine; no
`capture()`-style speculative visitation anywhere.

All four whitespace-family target behaviors (#1729 A/B/C, #609 D) pass as
positive expectations in `test/doc-ir/lower.test.ts`. Full formatter suite
(1201 tests + 36 spike tests) green; the current formatter is untouched —
the spike lives entirely under `src/doc-ir/` behind its own entry point
(`printWithDocIR`).

## Printer knob + --compare (2026-07-14)

Design §9.4 revised from "replace outright" to an opt-in knob, so the merge
no longer waits on fixture arbitration:

- `FormatOptions.printer: "classic" | "doc-ir"` (default `classic`);
  `Formatter.format` dispatches at the old one-line seam (formatter.ts).
- `.herb.yml`: `formatter.printer` added to `FormatterConfigSchema`
  (`@herb-tools/config` — schema is `.strict()`, so the field had to be
  declared; config dist rebuilt) and flows through `Formatter.from` and
  hence the language server. Precedence: per-call option > constructor
  option > config.
- CLI: `--printer <classic|doc-ir>` (validated), stderr banner when doc-ir
  is active, and `--compare` — formats every target (stdin, files, globs,
  or configured files) with BOTH printers and prints a unified diff;
  writes nothing; incompatible with `--check`. Safe because
  `Formatter.format` re-parses per call (the classic printer's
  herb:disable collector mutates the AST it prints).
- `src/line-diff.ts`: dependency-free LCS unified diff (hunks, 3 context
  lines). New tests: `test/printer-selection.test.ts` (told apart by the
  4-attribute rule: classic breaks, doc-ir keeps inline — pick a source
  UNDER 80 cols or doc-ir breaks the body by whole-line accounting) and
  `test/line-diff.test.ts`.
- Note: `tsc --noEmit` has one pre-existing TS7022 error in
  format-printer.ts (`textFlowResult`) unrelated to this change.

## Rebased onto upstream main (2026-07-30)

Branch `feature/formatter-doc-ir-rebased`, 9 commits (was 10). Upstream had
moved 30 commits ahead. What the rebase taught us:

- **Our classic-printer patch was superseded and dropped.** Upstream fixed
  cases A and C in #1863/#1884 with a cleaner factoring (`visitStatements` +
  `visitElementChildren(body, parent, { allowBlankLines })`). Verified before
  dropping by running our fixtures against upstream's printer alone: both
  pass. Dropping the commit also dropped its `test.fails` → `test` flips, so
  those markers were re-flipped by hand and now credit the upstream issues.
- One real conflict beyond that: upstream's `FormatPrinter` takes `this.herb`
  as a third argument. Trivial merge with the printer-knob dispatch.
- Rebuild after rebasing: `control_type.c` changed, so the wasm has to be
  rebuilt, then core → node-wasm → config → printer → tailwind → rewriter.
  Skipping this silently tests against a stale parser.
- Upstream added `positionFromOffset(source, offset)` in `core/src/position.ts`
  documenting columns as **UTF-16 character** columns, while `gaps.ts` is
  built on the empirically verified fact that *parser* columns are **UTF-8
  bytes**. Both can be true (different producers), but it is a trap: if the
  parser ever switches to character columns, `SourceIndex.charColumn` becomes
  a no-op that must be deleted, and the failure mode is silent (only
  multibyte lines misformat). Worth raising upstream.
- Re-measuring the corpus caught two genuine spike bugs (see
  DOC-IR-DIVERGENCES.md status section): idempotency broke on glued control
  flow that overflows, because inline-eligibility was keyed on authored line
  count, which formatting itself changes — it now hangs on boundary
  gluedness, which formatting preserves. And a glued body boundary could
  still break, adding rendered whitespace; glued ERB boundaries now lower to
  plain concatenation like inline elements already did. Cost: 8 exact matches
  (the classic printer expands glued control flow, we preserve it), gain: 0
  idempotency failures and 2 fewer rendering-changing divergences.

## Keeping the branch current (daily loop procedure)

Run on each rebase onto `upstream/main`:

1. `git fetch --multiple upstream origin`. If not behind and origin is in
   sync, stop — don't create a backup branch for a no-op. (Plain
   `git fetch upstream origin` fails: the second argument is read as a
   refspec, not a second remote, so nothing is fetched and the
   behind-count then reads 0 off stale refs.)
2. Back up: `git branch backup/formatter-doc-ir-pre-rebase-<date>` at the old
   tip (local only; these are rebase-equivalent snapshots, so they are not
   pushed — only `d8e7d5ea`, the genuinely different pre-rebase history, is
   on origin).
3. `git rebase upstream/main`.
4. **If any of `src/`, `include/`, `templates/`, `wasm/` changed**, rebuild
   before testing: templates → wasm → core → node-wasm → config → printer →
   tailwind-class-sorter → rewriter. Skipping this tests a stale parser.

   **When headers change (`src/include/**`), `rm -rf wasm/obj` first.** The
   wasm Makefile's dependency tracking does not catch header changes, so an
   incremental build links stale object files and every parse then fails with
   `RuntimeError: function signature mismatch`. Symptom to recognise: nearly
   the *entire* suite fails at `Herb.parse`, including tests untouched by the
   rebase — that is a build artifact, never a formatter regression. Diagnose
   by reading one failure's stack (it points into `wasm:/wasm/...`), not by
   bisecting formatter code. On 2026-08-02 this presented as 1283 failures
   that a clean rebuild reduced to 3.
5. Full formatter suite (exclude `test/cli/**`, `test/cli.test.ts` — those
   fail for environment reasons here).
6. Re-measure the divergence report: capture a fresh corpus, replay, update
   the table and the movement notes in DOC-IR-DIVERGENCES.md. Upstream is
   actively fixing the same bug family, so the numbers go stale on almost
   every rebase.

   **`rm -f $CORPUS_FILE` first — the capture appends.** Re-running it in a
   session that already captured once doubles the file (1281 → 2562 lines).
   The harness dedupes to unique inputs, so the report still looks sane and
   the totals still land on the same numbers; the tell is the raw line count,
   not anything in the report. Delete the report too, so a failed replay
   cannot be read as a fresh one.

   When a range lands **no** `javascript/packages/formatter` commits, expect
   every metric to be byte-identical and say so, rather than presenting the
   same numbers as a new measurement. Still check any native change by hand:
   confirm it cannot reach printing (parse a construct it touches through
   both printers), because the aggregate cannot distinguish "no effect" from
   "no coverage".
7. `git push --force-with-lease origin feature/formatter-doc-ir`. If the
   lease is refused, stop and report — do not resolve unattended.

Harness caveat: `samples` arrays in the JSON report are capped at 60 per
category, so counting categories from samples undercounts and drifts run to
run. Use `counts` for totals and verify per-category claims by formatting the
specific input with both printers (`--compare`, or `format(src, { printer })`).

`test/printer-selection.test.ts` needs an input the two printers disagree on.
As upstream converges, discriminators die: the original one (four attributes
on a fitting line) stopped working when #1834 adopted width-only wrapping.
It now uses the blank-line policy (§A), which only changes when the default
flips. If those tests fail with both printers producing identical output,
the discriminator converged — pick a new one from the divergence categories
rather than "fixing" the printer.

Things a future session should know:
- Parser locations: lines 1-based, columns 0-based **UTF-8 bytes**.
- Whitespace nodes inside open tags are dropped by the parser — sibling-walk
  gap classification is impossible there; the source index is required.
- `IdentityPrinter` mangles `HTMLConditionalOpenTagNode` (loses open-tag
  whitespace) — never fall back to it for those.
- The corpus/report live in the session scratchpad (`corpus.jsonl`,
  `report.json`); regenerate with the two commands at the top of
  DOC-IR-DIVERGENCES.md.
