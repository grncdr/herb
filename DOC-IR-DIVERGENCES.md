# Doc-IR spike — divergence report

Companion to DOC-IR-DESIGN.md. Produced by the validation harness
(`test/doc-ir/harness/`) comparing the Doc-IR spike against the current
`FormatPrinter` on every input captured from a full formatter test-suite run.

Date: 2026-07-13. Spike code: `javascript/packages/formatter/src/doc-ir/`.

**Status update (2026-07-14):** the Doc-IR printer is now wired in as *the*
printer (`Formatter.format` → `printWithDocIR`) and the replaced modules are
deleted. The numbers below were measured against the old `FormatPrinter`
before its deletion; the comparison harness that produced them lives in git
history (the current `replay-harness.test.ts` is a reduced quality gate:
idempotency + reparse-equality only). The divergences now manifest as **137
failing fixture expectations across 33 test files** — every one falls into a
category below and awaits the §9.1 arbitration before the fixtures are
re-cut. The `test.fails` marker for #609 (`tag.span do`) is flipped to a
passing test; #1729 Case B renders correctly and only its exact-match
expectation remains open (§C / reflow at exactly 80 columns).

## Reproduce (as originally measured)

```sh
cd javascript/packages/formatter

# 1. Capture the corpus (instruments Formatter.format during the full suite)
CORPUS_FILE=/tmp/corpus.jsonl yarn vitest run --config vitest.corpus.config.ts

# 2. Replay and write the report (originally: both printers compared;
#    now: idempotency + reparse-equality gate)
RUN_DOC_IR_HARNESS=1 CORPUS_FILE=/tmp/corpus.jsonl REPORT_FILE=/tmp/report.json \
  yarn vitest run test/doc-ir/harness/replay-harness.test.ts
```

## Headline numbers

| Metric | Value |
| --- | --- |
| Corpus (unique inputs) | 971 |
| Compared (parse ok, not scaffold/ignored) | 860 |
| **Exact match with current formatter** | **724 (84.2%)** |
| Exact + blank-line-policy-only diffs | 792 (92.1%) |
| Layout-only diffs (same content, different break points) | 15 |
| Content diffs (all in categories below) | 53 |
| Spike crashes | 0 |
| **Idempotency failures** (format∘format ≠ format) | **0 / 860** |
| Reparse-structure diffs — spike | 113 |
| Reparse-structure diffs — current formatter (baseline) | 140 |
| **Spike-only reparse diffs** | **1** (§E, deliberate) |
| Corpus wall-time — current / spike | 461ms / 408ms |

The four `test.fails` cases of the significant-whitespace family (#1729 A–D,
including the two deferred ones) all produce their target output under the
spike (`test/doc-ir/lower.test.ts`).

The shared ~113/140 reparse-structure diffs are text-edge whitespace at block
boundaries (e.g. `</p>.` → `</p>\n.`) — a normalization both printers perform;
the harness measures the spike **relative to the current formatter**, hence
the spike-only count is the regression signal.

## Intentional divergence categories

### A. Blank lines: preserve-only, capped at one (largest category — 68 pure + part of the content diffs)

Decided policy (design §4): the formatter never inserts blank lines; authored
ones are preserved, capped at one. The current `SpacingAnalyzer` inserts blank
lines between multiline siblings, around multiline control flow, at tag-group
boundaries, etc. Every fixture that expects those inserted blanks diverges.

```erb
<%= render "a" %>            current:  <%= render "a" %>
<p>text</p>                            ␣
                                       <p>text</p>
spike: unchanged (no blank was authored)
```

One insertion survives (design §4): a blank line after doctype/XML
declarations.

### B. herb:disable placement is structural (~14 diffs)

The spike lowers same-source-line `herb:disable` comments as `lineSuffix`
docs: they land at the end of whatever output line their anchor ends up on
(including the attribute's own line inside a broken open tag). Comments
authored on their own line stay where they are.

The current formatter splices comments into rendered output by substring
search, which the corpus shows misplacing them: own-line comments pulled to
`<% end %>`/`</DIV>` lines, stacked comments reordered (`rule-one`/`rule-two`
inverted), comments merged onto 120-column lines, and document-leading
comments hoisted. The spike keeps author placement; a comment annotating an
attribute stays on that attribute's line so the directive keeps applying.

### C. Control flow and blocks authored on one source line stay inline when they fit (~10 diffs)

```erb
<%= tag.span do %>This should stay on one line<% end %>
current: expands to 3 lines        spike: unchanged
```

This is the generalization that fixes #609 (Case D) and #1729's inline-if
(Case B). Whether a construct breaks is decided by its *authored* line
structure (multiline gaps lower to hardlines) plus width — not by node type.

Conflicting specs needing arbitration (design §9.1):
- `test/html/text-content.test.ts` "ERB block tag with inline content should
  stay on one line" asserts the *expanded* output with the TODO
  `// TODO: expect(result).toEqual(source)` — the spike implements the TODO.
- `test/erb/erb.test.ts` inline `link_to`/`for`/`while` specs expect
  expansion; the spike preserves the authored one-liner.

### D. Attribute-count rule dropped (~8 diffs)

Decided (design §9.3): wrapping is purely width-driven. `>3 attributes →
always break` is gone.

```html
<div id="element" class="bg-gray-300" another="attribute" final="one">Content</div>
current: 9 lines (count rule)      spike: unchanged (71 cols)
```

### E. Width accounting covers the whole output line (~6 diffs, incl. the 1 spike-only reparse diff)

The current printer measures the open tag *alone* against `maxLineLength`,
so trailing content can push lines past the limit (corpus shows 90–113-column
lines kept "inline", partly because conditional attributes are dropped from
the measurement). The spike measures the real line. Where the body of a
*block* element breaks as a result, rendering is unchanged; the harness's one
spike-only reparse diff is exactly such a case
(`<div id="test"<% if … %>…>Content</div>`, a 90-column line under the
current printer).

For *inline* elements the spike never breaks glued boundaries
(`…>Link</a>` stays glued; over-long lines are accepted) — breaking there
would add rendered whitespace, which is the current printer's own behavior it
sometimes violates (it emits `> Link </a>` with added spaces).

### F. Authored-multiline inline-element content is preserved (~3 diffs)

```erb
<span>                              current: <span><% if valid? %>Valid<% else %>Invalid<% end %></span>
  <% if valid? %>
    Valid
  <% end %>
</span>                             spike: unchanged
```

The current collapse *removes rendered whitespace* around `Valid` (the
authored newlines render as spaces); the spike preserves the authored
structure and hence the rendering.

### G. Punctuation is governed by source gaps, not heuristics (~2 diffs)

Current glues a bare punctuation word across an authored newline
(`<em>this</em>\n: it works!` → `</em>: it works!`), changing rendering. The
spike renders what the gap classifier sees: space stays space, glue stays
glue (`<%= name %>'s` still works — it was always glued in source).

### H. `<br>`/`<hr>` placement (~4 diffs)

Both printers break the visual line after `<br>` in broken paragraphs. The
current printer also isolates `<br>` on its own line, splitting even
source-glued `text.<br>`; the spike keeps glued `,<br>` attached (consistent
with the #469 fixture) and starts a new line at the *next* gap.

### I. Multiline attribute values force the attribute-per-line form (~2 diffs)

Decided (design §4). A value containing a source newline (e.g. multiline
`data-content`, `placeholder`) forces the open tag into attribute-per-line
form; the current printer leaves the tag on one line with an embedded newline
in the middle of the attribute list. Value text is preserved verbatim either
way. Authored multi-line `class` values (>80 chars normalized) keep their
authored line structure, exactly like the current formatter.

### J. Empty ERB tags render as `<% %>`, not `<%%>` (1 diff)

`<%%` is the ERB literal-escape; the current printer's `<%%>` output is
hazardous and not a formatting fixpoint (it reformats to `<%% >`). The spike
emits `<% %>` / `<%# %>`, which are stable.

## Layout-only diffs (15)

Same content and spacing, different wrap points. Two sources:

- Class-value token wrapping uses the true remaining width at the value's
  indent instead of the current `maxLineLength − indent − 6` constant, so
  tokens occasionally wrap one word later.
- Fill wrapping packs words up to the limit where the current word-wrapper
  sometimes breaks a word earlier (both stay ≤ 80 columns).

## Known limitations of the spike (not design decisions)

- `HTMLConditionalElementNode` (element with conditional open *and* close
  tags) has a basic lowering; only smoke-tested against the corpus.
- The `-6`-free class wrapping and the whole-line width accounting produce
  the layout-only diffs above; if bit-compatibility mattered more than
  simplicity, both could be matched exactly.
- Rewriters, CLI and LSP are untouched (behind the `Formatter.format()` seam,
  as scoped in design §8).

## Maintainer arbitration needed (design §9.1)

1. Blank-line policy (§A) intentionally rewrites the largest share of
   existing fixture expectations — sign-off needed since it changes default
   output for most templates.
2. The §C spec conflicts: `text-content.test.ts:382` (TODO-marked) and the
   inline `link_to`/loop expansions in `test/erb/erb.test.ts` contradict the
   whitespace-preservation targets; the spike sides with the latter.
3. §E/§F/§G/§H are cases where the current output changes rendered
   whitespace or exceeds the width limit and the spike does not; proposed as
   fixes, listed here because they alter existing fixture expectations.
