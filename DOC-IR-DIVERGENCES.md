# Doc-IR spike — divergence report

Companion to DOC-IR-DESIGN.md. Produced by the validation harness
(`test/doc-ir/harness/`) comparing the Doc-IR spike against the current
`FormatPrinter` on every input captured from a full formatter test-suite run.

Spike code: `javascript/packages/formatter/src/doc-ir/`. First measured
2026-07-13; re-measured on each rebase onto upstream `main` (latest:
2026-08-08, base `9a51d724`).

**Status:** both printers ship side by side behind `formatter.printer` /
`--printer doc-ir`, default `classic`, so nothing below changes anyone's
output until the default flips (design §9.4). `--compare` prints these
divergences for a real project.

Three bugs the re-measurements caught, all now fixed on the branch:

1. **Idempotency broke (2 inputs)** on glued control flow too long to fit:
   the construct broke internally on pass 1, which made it *authored
   multiline* on pass 2, flipping the inline-eligibility test that was keyed
   on authored line count — so pass 2 put a newline at a glued boundary.
   Line count is not invariant under formatting; gluedness is, so
   eligibility now hangs on the boundary gaps instead.
2. **A glued body boundary could still break** (`…overflows<% end %>!`
   became `…overflows\n<% end %>!`, adding a rendered space before `!`).
   Glued ERB body boundaries now lower to plain concatenation, matching the
   rule already applied to inline elements. A hardcoded newline before
   `<% end %>` in rescue/ensure chains, which this exposed, went with it.
3. **Nested multi-line HTML comments lost their indentation** (2026-08-05):
   the body and closing `-->` were emitted as though the comment sat at
   column 0. The body was carried as literal text, which by construction
   refuses re-indentation; it is now a Doc the layout engine indents. Full
   account in §R — it is the clearest example so far of the comparison
   catching something the fixture suite did not.

## Reproduce

```sh
cd javascript/packages/formatter

# 1. Capture the corpus (instruments Formatter.format during the full suite)
CORPUS_FILE=/tmp/corpus.jsonl yarn vitest run --config vitest.corpus.config.ts

# 2. Replay both printers and write the report
RUN_DOC_IR_HARNESS=1 CORPUS_FILE=/tmp/corpus.jsonl REPORT_FILE=/tmp/report.json \
  yarn vitest run test/doc-ir/harness/replay-harness.test.ts
```

## Headline numbers

Earlier columns are kept because the *composition* of the difference has
changed across rebases, not just the totals — upstream has been fixing the
same bug family, so which inputs diverge moves even when the rate holds.

| Metric | 2026-08-08 | 2026-08-07 (= 08-06, 08-05) | 2026-08-04 (= 08-03, 08-02) | 2026-08-01 | 2026-07-30 | 2026-07-13 |
| --- | --- | --- | --- | --- | --- | --- |
| Corpus (unique inputs) | 1204 | 1189 | 1163 | 1099 | 1081 | 971 |
| Compared (parse ok, not scaffold/ignored) | 1091 | 1076 | 1051 | 987 | 969 | 860 |
| **Exact match with current formatter** | **896 (82.1%)** | 889 (82.6%) | 863 (82.1%) | 815 (82.6%) | 797 (82.2%) | 724 (84.2%) |
| Exact + blank-line-policy-only diffs | 963 (88.3%) | 956 (88.8%) | 930 (88.5%) | 885 (89.7%) | 867 (89.5%) | 792 (92.1%) |
| Layout-only diffs (same content, different break points) | 44 | 37 | 37 | 27 | 27 | 15 |
| Content diffs (all in categories below) | 84 | 83 | 84 | 75 | 75 | 53 |
| Spike crashes | 0 | 0 | 0 | 0 | 0 | 0 |
| **Idempotency failures** (format∘format ≠ format) | **0 / 1091** | 0 / 1076 | 0 / 1051 | 0 / 987 | 0 / 969 | 0 / 860 |
| Reparse-structure diffs — spike | 113 | 111 | 108 | 106 | 117 | 113 |
| Reparse-structure diffs — current formatter (baseline) | 155 | 154 | 152 | 152 | 151 | 140 |
| **Spike-only reparse diffs** | **2** (1 §E deliberate, **1 regression** — §S) | 1 (§E, deliberate) | 1 (§E, deliberate) | 1 | 1 | 1 |
| Corpus wall-time — current / spike | 549ms / 462ms | 555ms / 460ms | 521ms / 449ms | 487ms / 425ms | 485ms / 418ms | 461ms / 408ms |

08-05 carried two rebases and is reported with 08-06 and 08-07 as one column,
at its final state (base `25c4a90b`). The two intermediate readings on 08-05
were: at base `0796d0fc` before the §R fix — 871 exact (82.0%), 41 layout-only,
113 spike reparse diffs, **3** spike-only; and after it — 875 exact (82.4%), 37
layout-only, 111 and 1.

**Suite caveat from 08-08 onward:** three rewriter/Tailwind-sorter integration
tests fail (`test/rewriters/formatter-integration.test.ts` ×2,
`test/rewriters/custom-rewriters.test.ts` ×1) — the sorter loads but leaves
class order untouched. They fail identically on plain `upstream/main`, so they
are upstream's, not this branch's; `tailwindcss` 3.4.19 is installed, so it is
not a missing peer dependency. Suspect #2073 (bundles now externalise declared
dependencies instead of inlining them), which rewrote the rewriter's rollup
config in this same range. Unrelated to the printer: the harness replays
captured inputs through both printers directly and never goes through a
rewriter.

The exact-match rate moved down ~2 points between 07-13 and 07-30 even though
both printers got better, for a specific reason: upstream's #1863/#1884 fixed
the *cheap* half of the glued-boundary problem (don't insert whitespace
between glued siblings) while the spike also enforces the *expensive* half —
a glued boundary may never break even when the line overflows or the
construct spans several lines. Eight inputs that previously matched now
diverge because the classic printer expands glued control flow (`<% 5.times
do %>OK<% rescue %>ERR<% end %>` → five lines) and the spike preserves it.
Those are rendering-preserving on the spike's side and rendering-changing on
the classic side, so the direction of the divergence is the argument for it,
not against it. Categories §C/§F below cover them.

**08-01 movement (upstream #1916, #1917, #1923, #1924).** Both printers
converged slightly: exact match +18 inputs, and the spike's
reparse-structure diffs fell 117 → 106 while the classic printer's held at
~152. Two of those fixes are worth naming because of *where* they land:

- **#1924 (`<br>` alternating between glued and split form) converged onto
  the spike's behaviour.** `<p>One<br> Two<br> Three</p>` is now byte-identical
  from both printers, where the classic one previously isolated each `<br>`
  on its own line. Note what the bug was: output that alternated between two
  forms across passes — a non-idempotency, the class of defect the Doc-IR
  layout rules out structurally rather than per-shape.
- **#1916 (`herb:disable` comment moving after tag) did not converge.** The
  classic printer still relocates `<DIV> <%# herb:disable rule-one %>` to
  `<DIV>Content.</DIV> <%# herb:disable rule-one %>`; §B still applies.

Category composition is otherwise unchanged. Caveat for anyone re-running
this: the report's `samples` arrays are capped (60 per category), so counting
categories from the samples undercounts and drifts between runs — the
category totals above come from the full `counts`, and per-category claims
here were checked by formatting the specific inputs with both printers.

**08-02 movement (upstream #1834, #1926, #1949, #1950, and 41 other commits).**
**Category §D is resolved: upstream adopted width-only attribute wrapping**
(#1834 "Wrap attributes based on `maxLineLength` only"), which is the policy
decided in design §9.3. `<div id="a" class="b" data-x="c" data-y="d">Content</div>`
is now byte-identical from both printers; the attribute-count rule is gone
from the classic printer too. That is the second design decision upstream has
independently arrived at, after the `<br>` instability in #1924.

Absolute exact matches rose 815 → 863 on a corpus that grew by 64 inputs, so
the *rate* dipped slightly (82.6% → 82.1%) while the count improved.
Layout-only diffs rose 27 → 37; the new ones are all one shape —
ERB control flow in *attribute position*, where the classic printer expands
the body across three lines and the spike keeps the authored single line:

```erb
<div <% if disabled? %> disabled <% end %> id="element" …>
classic:  <% if disabled? %>\n    disabled\n  <% end %>
spike:    <% if disabled? %> disabled <% end %>
```

Whitespace-collapsed these are equal, hence "layout-only"; it is category §C
(authored-inline control flow is preserved) showing up inside open tags.

**08-03 and 08-04 movement: none.** Two consecutive rebases (onto `b490ecd9`,
10 commits, then onto `96ebd558`, 12 commits) moved no metric: all three runs
are byte-identical — same corpus size, same category counts, same reparse
counts — hence the shared column. Neither range touches
`javascript/packages/formatter`. 08-03 was nine linter rules/CLI changes
(#1954, #1960, #1962–#1969) plus the `tsc` 7.0 upgrade (#1956); 08-04 was
four more linter rules, the Playground autofix tab (#1974), Ruby
`Location`/`Position`/`Range` `zero` helpers (#1979), and RBS/Rust/CI
housekeeping.

Each range carried exactly one native change, and neither reaches printing:

- 08-03, `src/analyze/ternary_conditionals.c` (#1969) pads ternary branch
  bodies with spaces for the new rule's autocorrect — a linter-facing field.
- 08-04, `src/prism/prism_helpers.c` (#1976) stops treating a ternary `?` as
  a `then` keyword. This one *could* have reached the formatter, so it was
  checked directly rather than inferred from the aggregate: `<% if admin? ?
  true : false %>`, the `unless` form, and a ternary inside an attribute
  value all format identically before and after, and the condition is
  preserved verbatim by both printers. The two ERB-body cases still diverge
  by category §C (the classic printer expands authored-inline control flow,
  the spike keeps it), but so does plain `<% if x then %>T<% end %>`, which
  has no ternary in it — the divergence is §C, not the parser fix.

Wall-time drifted 527/447 → 510/439 → 521/449ms, which is run-to-run noise.

Category composition and every per-category claim below therefore carry over
from 08-02 unchanged — including §B (#1916 `herb:disable` relocation still
unconverged) and §D (still resolved). A rebase that lands no formatter
commits needs no category re-verification; one that lands any does.

**08-05 movement (upstream #1998, #1991, #1970, and 15 other commits) — the
first rebase since 08-02 that lands formatter commits, and the first that
caught a spike regression.** Upstream #1998 taught the classic printer to
preserve the indentation of a multi-line HTML comment nested below the top
level. The spike did not follow, and emitted the pre-#1998 output, with the
body *and* the closing `-->` laid out as if the comment sat at column 0, at
any nesting depth. That one defect moved layout-only 37 → 41 and spike-only
reparse diffs 1 → 3. **Fixed on the branch the same day (§R)**, which is why
the column above reads 1 again.

The harness earned its keep here: `spikeOnlyReparseDiff` had been pinned at 1
since 07-13, so a move to 3 was unambiguous, and it surfaced within one rebase
of upstream fixing the same defect on their side. The exact-match rate would
not have carried the signal — it moved 82.1% → 82.0% across a corpus that also
grew, which is indistinguishable from noise.

Everything else moved benignly: the corpus grew 1163 → 1175 on #1998's and
#1991's new tests, and content diffs fell 84 → 83. With the fix in, exact
matches rose 863 → 875 (82.1% → 82.4%).

**08-05 second rebase (upstream #2015 and 8 other commits) — convergence, in
the spike's own bug family.** #2015 stops the classic printer deleting
whitespace between text and an ERB tag inside an `else`/`elsif`/`when`/`in`/
`rescue`/`ensure` branch: `<span><% if a %>A<% else %>B <%= d %><% end %></span>`
kept its space in the `if` branch but lost it in every other branch. That is
the significant-whitespace family this design exists to fix (§5), and the
spike already produced the corrected output.

The measurement shows it cleanly: the corpus grew by 14 inputs and exact
matches rose by exactly 14 (875 → 889, 82.4% → 82.6%), with every other
category unchanged — so all 14 new inputs match byte-for-byte, and nothing
moved between categories. Verified directly on the issue's reproduction and
the `elsif` variant: both printers now agree and round-trip the source.

Two `case`/`when` and `begin`/`rescue` inline variants still differ, but only
by §C (the classic printer expands authored-inline control flow; the spike
keeps it). The whitespace inside those branches is now preserved by both —
that part converged.

This is the fourth upstream convergence onto a spike behaviour: #1924 (`<br>`
instability), #1834 (width-only attribute wrapping, §D), #1998 (nested comment
indentation, where the spike was behind and followed), and now #2015.

**08-06 movement: none** (23 commits, base `30ba2a09`). Every metric is
byte-identical to 08-05, hence the shared column; the formatter package is
untouched (linter rules, config YAML anchors/merge keys, Language Server
completion, docs).

This range is the counter-example to reading an unchanged aggregate as an
all-clear, so the native changes were checked by hand rather than inferred:

- **`AutoCloseOmittedTagsVisitor` (#1188)** sounds like it rewrites element
  structure, which would reach the formatter directly. It does not: it is
  Ruby-only, under `lib/herb/engine/`, and never enters the C parser or the
  JS pipeline.
- **`src/parser.c`, 149 lines (#1425)** is the largest parser diff in weeks
  and is purely mechanical — eager `hb_array_init` for `AST_NODE->errors`
  replaced by lazy `NULL` and pointer-to-pointer plumbing. No production
  rule, token, or node shape changes.
- **128 KB arena pages (#1379)** and the lazy `hb_array_T` allocation are
  allocator behaviour, invisible to the AST.

Headers changed here, and so did `wasm/Makefile`, so this rebase needed the
full `rm -rf wasm/obj` rebuild (journal step 4).

**08-07 movement: none** (20 commits, base `25c4a90b`). Formatter package
untouched again; the range is Language Server features (partial hover,
definition, extract-to-partial), linter fixes, and Rust/Playground work. Two
changes were checked rather than assumed:

- **`src/analyze/render_nodes.c` (#2044)**, the only native change, stops
  flagging `render layout:` as missing its block when a block is in fact
  present. That is error reporting, not structure — and no corpus input has
  the shape, so the aggregate could not have spoken for it either way.
  Checked directly: `<%= render layout: "shared/box" do %>…<% end %>` parses
  with zero errors and both printers agree and round-trip it. (The inline
  one-liner variant still differs by §C, as it did before.)
- **`javascript/packages/core` (#2058)** matters because the formatter
  depends on it, but the diff is two new modules plus an alphabetised export
  list — additive, no behaviour change. (Upstream's re-sort left a duplicate
  `html-constants` export line; harmless in ESM.)

**08-08 movement (upstream #2059 and 21 other commits) — a second spike
regression, this one destructive.** #2059 teaches the classic printer to
preserve *author-expanded* multi-line ERB tags: where the author put `<%=` on
a line of its own and `%>` on a line of its own, that shape is kept. The spike
pulls the code up onto the opening delimiter and the closing delimiter up onto
the last code line.

Its 15 new corpus inputs split 7 exact / 7 layout-only / 1 content diff, which
is why layout-only rose 37 → 44 and the exact *rate* slipped 82.6% → 82.1%
while the count rose 889 → 896. Seven of those are cosmetic — same code,
delimiters placed differently:

```erb
author + classic:        spike:
<%=                      <%= link_to(
  link_to(                   "First",
    "First",                 url
    url                    ) %>
  )
%>
```

The eighth is not cosmetic, and it is why spike-only reparse diffs went 1 → 2:
with a heredoc in the tag, pulling `%>` up puts it on the terminator line, so
`TEXT %>` stops terminating the heredoc and the emitted Ruby no longer parses
as the author's. Tracked as **§S**, open.

Note what the two signals did here. The exact-match rate *fell* while the
printer's agreement improved on 7 of 15 new inputs — noise, as usual.
`spikeOnlyReparseDiff` moved by exactly one, and that one was the only input
in the whole corpus whose output changed meaning.

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

### D. Attribute-count rule dropped — ~~divergence~~ **RESOLVED upstream (2026-08-02)**

Decided (design §9.3): wrapping is purely width-driven. `>3 attributes →
always break` is gone.

```html
<div id="element" class="bg-gray-300" another="attribute" final="one">Content</div>
before: 9 lines (count rule)      spike: unchanged (71 cols)
```

Upstream adopted this in #1834 ("Wrap attributes based on `maxLineLength`
only"), so both printers now agree and this is no longer a divergence — no
arbitration needed. What remains in the same area is only §C/§E: ERB control
flow *in attribute position* still expands under the classic printer while
the spike keeps the authored line (counted under layout-only diffs).

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

### K. A single glued comment body line keeps its indent instead of growing one (0 corpus diffs)

Introduced by the §R fix, and the only intentional divergence in it. For

```html
<div>
  <!--
    a -->
</div>
```

the classic printer measures the body's left edge while *excluding* the last
line — and here the only body line is also the last, so it measures against
column 0 and adds a full level. That makes the shape non-idempotent: the body
gains an indent level on every pass (4 → 8 → 12 → …), which the harness's
idempotency check would fail. The spike measures every non-blank body line,
so `a` stays where the author put it and reformatting is a fixpoint.

No corpus input has this shape, so it costs nothing measurable; it is recorded
because it is a deliberate refusal to match the classic printer byte-for-byte.

## S. Regression (open): author-expanded multi-line ERB tags are collapsed, breaking heredocs

**Open. A defect in the spike, not a decision.** Found by the 08-08 rebase;
upstream's #2059 fixed the same question on their side by preserving the
authored shape.

Where the author expanded an ERB tag — `<%=` alone on its line, `%>` alone on
its line — the spike pulls the code up onto the opening delimiter and the
closing delimiter onto the last code line. On 7 corpus inputs that is merely
cosmetic (§layout-only). On the eighth it changes what the Ruby means:

```erb
source + classic:              spike:
<%=                            <%= tag.pre(<<~TEXT)
  tag.pre(<<~TEXT)                 significant
    significant                      leading
      leading                    whitespace
    whitespace                   TEXT %>
  TEXT
%>
```

`TEXT %>` is no longer a heredoc terminator — a terminator line may not carry
trailing content — so the output is not the author's program. This is the
first spike divergence that produces invalid Ruby rather than different
whitespace, which is why it is filed here and not among the categories.

The likely shape of the fix, by analogy with §R: the ERB tag's inner code is
currently normalised into a single-line form and re-emitted, so the authored
line structure is discarded before layout ever sees it. An authored newline
between the opening delimiter and the code is a fact the gap classifier (§5)
already knows how to represent — a `hardline` in the tag's Doc — and heredoc
bodies are content that must not move at all, i.e. the one legitimate use of
`literalline` (see §R for the converse mistake). Not yet attempted.

## R. Regression (fixed): nested multi-line HTML comments lost their indentation

**Found by the 08-05 rebase, fixed the same day** — the first genuine
regression the harness has surfaced, as opposed to a deliberate difference.
Upstream fixed the same defect in the classic printer in #1998, one rebase
earlier. Kept here as the worked example of what the comparison is for.

The spike laid out the comment body, and the closing `-->`, as though the
comment sat at column 0, at any nesting depth:

```html
<div>
  <div>
    <div>
      <!--                      spike:  <!--
        <p>deep</p>                 <p>deep</p>
      -->                       -->
    </div>
```

`formatHTMLCommentInner` gained a `baseIndent` third parameter in #1998 and
the spike called it with two — but **passing the argument was not the fix**.
The spike had no `baseIndent` to pass: it lowered the comment through
`literalText`, whose `literalline` separators exist precisely to suppress
re-indentation, and lowering cannot know how deep the layout engine will place
a node. Indentation is a layout property in this design, and that lowering
tried to carry it as string content.

The fix stops treating the body as literal text and lowers it as a Doc, so the
engine supplies the base indentation:

```ts
[open, indent([hardline, join(hardline, bodyLines)]), hardline, close]
```

`bodyLines` keeps only each line's indentation *relative* to the body's own
left edge (one corpus case has a deliberately ragged body). Two shapes needed
care: content on the opening line (`<!-- text`) has no measurable left edge, so
the body flattens, as it does in the classic printer; and a closing marker the
author glued to the last body line (`… b -->`) stays glued, so the `hardline`
before it is conditional. §K records the one place the fix declines to copy the
classic printer. Covered by 11 cases in `test/doc-ir/lower.test.ts`.

Result: layout-only 41 → 37, spike-only reparse diffs 3 → 1 (§E only), exact
matches 871 → 875, idempotency failures still 0.

## Layout-only diffs (44)

Same content and spacing, different wrap points. Sources:

- Class-value token wrapping uses the true remaining width at the value's
  indent instead of the current `maxLineLength − indent − 6` constant, so
  tokens occasionally wrap one word later.
- Fill wrapping packs words up to the limit where the current word-wrapper
  sometimes breaks a word earlier (both stay ≤ 80 columns).
- ERB control flow in attribute position (see the 08-02 movement note).
- One inline element whose only child is an authored-multiline comment
  (`<span>\n  <!-- … -->\n</span>`), which the spike inlines because it fits.
- Author-expanded multi-line ERB tags collapsed onto their delimiters (7 of
  them) — the cosmetic half of §S.

## Known limitations of the spike (not design decisions)

- **Open regression:** author-expanded multi-line ERB tags are collapsed,
  which breaks heredocs — see §S.
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
