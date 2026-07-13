# Dev Journal — ERB control-flow / block whitespace formatting

Context: the significant-whitespace bug family (see
`javascript/packages/formatter/test/html/whitespace-preservation.test.ts`,
issues #1729, #469, #609, …). Four cases were still reproducing on `main` and
tracked as `test.fails`. Goal: make them pass without regressing other
formatter specs, with minimal changes.

## Fixed (small, no regressions)

**Case A — #1729:** text directly following an ERB output inside an `if` block
(`<%= user.name %>'s dog`) was split onto its own line.

**Case C — #1729 / @grncdr:** a comma (and adjacent `<br>`) directly after an
ERB output inside an `if` block was pushed onto its own line.

Root cause: `visitERBIfNode` / `visitERBElseNode` rendered statements with a
bare `visitAll(node.statements)`, so every statement landed on its own line and
any text/punctuation directly touching the preceding ERB was separated from it.
(`visitERBBlockNode` / `visitERBRenderNode` already routed through richer
dispatch.)

Fix: render control-flow statements via `visitElementChildren` in a new
"control-flow mode" (`elementBodyMode = false`) that:
- keeps one statement per line (preserving the one-ERB-output-per-line behavior
  from #1210 — HTML-style text-flow collapsing is *not* applied here), but
- appends content that is *directly source-adjacent* (no whitespace between) to
  the preceding node onto the same line, via a new, control-flow-only predicate
  `isSourceAdjacentToPrevious` (stricter than `shouldAppendToLastLine`: a
  preceding text node ending in whitespace, or an intervening whitespace-only
  node, disqualifies — so newline-separated ERB outputs stay separate), and
- skips the automatic blank-line-between-siblings insertion (which `visitAll`
  never did, and which otherwise regressed a herb:disable spec).

This is isolated to the control-flow path; HTML element bodies and `do`/`end`
blocks are unchanged. Full non-CLI suite stays green (1163 passing, same as
baseline; the pre-existing 74 CLI failures are environment-related and
unrelated to formatter logic).

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
