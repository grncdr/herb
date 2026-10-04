# Doc-IR spike — divergence report

Companion to DOC-IR-DESIGN.md. Produced by the validation harness
(`test/doc-ir/harness/`), which formats every input captured from a full
formatter test-suite run with both printers and compares the results.

Snapshot: 2026-10-04, upstream base `56645ad6`. This file describes only the
current state; the history of earlier measurements is in git.

Spike code: `javascript/packages/formatter/src/doc-ir/`. Both printers ship
side by side behind `formatter.printer` / `--printer doc-ir`, default
`classic`, so nothing below changes anyone's output until the default flips
(design §9.4). `--compare` prints these divergences for a real project.

## Reproduce

```sh
cd javascript/packages/formatter

# 1. Capture the corpus (instruments Formatter.format during the full suite).
#    The capture appends, so delete an old corpus file first.
CORPUS_FILE=/tmp/corpus.jsonl yarn vitest run --config vitest.corpus.config.ts

# 2. Replay both printers and write the report
RUN_DOC_IR_HARNESS=1 CORPUS_FILE=/tmp/corpus.jsonl REPORT_FILE=/tmp/report.json \
  yarn vitest run test/doc-ir/harness/replay-harness.test.ts
```

The report keeps 60 samples per category by default. Set
`SAMPLE_CAP=Infinity` to keep all of them; the per-category counts below were
made that way.

## Summary

| Metric | Value |
| --- | --- |
| Corpus (unique inputs) | 1267 |
| Compared (parse ok, not scaffold/ignored) | 1149 |
| **Exact match with the classic printer** | **941 (81.9%)** |
| Exact + blank-line-policy-only diffs | 1016 (88.4%) |
| Blank-line-only diffs (§A) | 75 |
| Layout-only diffs (same content, different line breaks) | 39 |
| Content diffs | 94 |
| Spike crashes | 0 |
| **Idempotency failures** (format∘format ≠ format) | **0 / 1149** |
| Reparse-structure diffs — spike | 113 |
| Reparse-structure diffs — classic printer | 162 |
| **Spike-only reparse diffs** | **1** (§E, deliberate) |
| Corpus wall-time — classic / spike | 520ms / 438ms |

How to read it:

- **Spike-only reparse diffs** is the regression signal: inputs where the
  spike changes the parsed structure and the classic printer does not. The
  one remaining is deliberate (§E).
- **Reparse-structure diffs** that both printers share are whitespace at
  block boundaries (`</p>.` → `</p>\n.`), a normalization both perform.
- **The exact-match rate** moves with the corpus and says little alone.

Where the diffs come from (every sample classified by hand):

| Section | Content | Layout-only | Blank-only |
| --- | --- | --- | --- |
| §A Blank lines | (3, mixed) | (2, mixed) | 75 |
| §B `herb:disable` placement | 14 | 1 | |
| §C Authored-inline control flow | 48 | 5 | |
| §E Whole-line width | 15 | 2 | |
| §I Multi-line attribute values | 2 | | |
| §L Whitespace at inline-element edges | 8 | | |
| §M Multi-line inline elements joined | | 5 | |
| §N ERB comments | | 3 | |
| §S Line structure inside ERB tags (defect) | 6 | 11 | |
| §U Whitespace-preserving classes (defect) | | 1 | |
| §V Control-flow bodies not filled (defect) | | 9 | |
| §W Inline siblings broken apart (defect) | 1 | | |
| **Total** | **94** | **39** | **75** |

"Mixed" inputs are counted in the section of their main difference.

## Intentional divergence categories

### A. Blank lines: preserve-only, capped at one

Decided policy (design §4): the formatter never inserts blank lines; authored
ones are preserved, capped at one. The classic printer inserts blank lines
between multi-line siblings, around multi-line control flow and at tag-group
boundaries, and since #2121 it also preserves two authored blank lines.

```erb
<%= render "a" %>            classic:  <%= render "a" %>
<p>text</p>                            ␣
                                       <p>text</p>
spike: unchanged (no blank was authored)
```

The rule also applies next to own-line ERB tags (design §4):
`<%\n=begin %>` + `<span>` + `<%\n=end %>` gets a blank line on each side of
the `<span>` from the classic printer and none from the spike.

One insertion survives: a blank line after a doctype or XML declaration.

### B. `herb:disable` placement is structural

The spike lowers same-line `herb:disable` comments as `lineSuffix` docs: they
land at the end of whatever output line their anchor ends up on. Comments
authored on their own line stay there.

The classic printer moves them. In the corpus it pulls own-line comments onto
`<% end %>` and `</DIV>` lines, appends a comment after the closing tag of the
element it annotated (`<DIV> <%# herb:disable rule-one %>` →
`<DIV>Content.</DIV> <%# herb:disable rule-one %>`), reverses stacked comments,
and hoists repeated `herb:disable all` comments to the top of the document.

### C. Control flow and blocks authored on one line stay inline

```erb
<%= tag.span do %>This should stay on one line<% end %>
classic: expands to 3 lines        spike: unchanged
```

Whether a construct breaks is decided by its authored line structure and by
width, not by node type. Most of these inputs are glued, such as
`<p>A<% if x %>b<% end %>!</p>` and
`<% 5.times do %>OK<% rescue %>ERR<% end %>`. There, the classic
printer's expansion adds whitespace that renders, and the spike's output does
not, so the spike is the one that keeps the rendering.

Control flow in attribute position (`<div <% if disabled? %> disabled <% end %>
…>`) is the same rule: the classic printer spreads it over three lines, the
spike keeps the authored line.

Conflicting specs that need arbitration (design §9.1):
- `test/html/text-content.test.ts` "ERB block tag with inline content should
  stay on one line" asserts the expanded output, with the TODO
  `// TODO: expect(result).toEqual(source)`. The spike implements the TODO.
- `test/erb/erb.test.ts` inline `link_to`/`for`/`while` specs expect
  expansion; the spike keeps the authored one-liner.

### E. Width covers the whole output line

The classic printer measures the open tag alone against `maxLineLength`, so
content after it can push the line past the limit; among the content diffs,
13 classic outputs have lines of 82 to 233 columns where the spike's are
shorter. The spike measures the real line:

```erb
<div id="test"<% if show_class %>class="visible"<% end %> data-value="123">Content</div>

classic (91 columns):
<div id="test" <% if show_class %> class="visible" <% end %> data-value="123">Content</div>

spike (78, 9, 6 columns):
<div id="test" <% if show_class %> class="visible" <% end %> data-value="123">
  Content
</div>
```

This input is the one spike-only reparse diff: the `<div>` text gains
whitespace at its edges, which a block element does not render.

For inline elements, the spike never breaks a glued boundary, because a
newline there would render as a space. It breaks the attributes instead and
keeps `>Link</a>` glued. The classic printer breaks the body there, so
`<a …>Link</a>` and `<button …>Button</button>` gain rendered spaces around
the text.

### I. Multi-line attribute values force one attribute per line

Decided (design §4). A value containing a newline (`data-content`,
`placeholder`) puts the open tag into one-attribute-per-line form. The
classic printer leaves the tag on one line with the newline in the middle of
the attribute list. The value text is preserved either way.

### K. A single glued comment body line keeps its indent

```html
source:        classic:        spike:
<div>          <div>           <div>
  <!--           <!--            <!--
    a -->              a-->        a-->
</div>         </div>          </div>
```

The classic printer measures a comment body's left edge without its last
line. When the only body line is also the last, it measures against column 0
and adds a level on every pass, so the shape is not idempotent. The spike
measures every non-blank body line, so `a` stays where it is. No corpus input
has this shape.

### L. Whitespace at inline-element edges is preserved

```erb
<div><span> <em>x</em> </span></div>
classic: <div><span><em>x</em></span></div>     spike: unchanged
```

The classic printer removes whitespace just inside an inline element, which
removes rendered spaces. The spike keeps it, as one space or a line break.
The same applies to `<span>\n  text\n  <em>x</em>\n</span>` and to a
`<span class="badge">` inside a paragraph.

### M. Multi-line inline elements are joined when they fit (layout-only)

```erb
<nav>                                  spike:
  <a href="/events" class="underline">   <nav>
    All events                             <a href="/events" class="underline"> All events </a>
  </a>                                   </nav>
</nav>
```

Inline elements are laid out by width; their authored line breaks are
whitespace, which collapses to one space when the element fits. The classic
printer keeps the authored lines. Both render the same.

### N. ERB comments (layout-only)

A single-line ERB comment followed by text joins the text's fill in the spike
(`<%# … %> Some text that wraps…`); the classic printer puts the comment on a
line of its own. An empty multi-line comment `<%#\n\n%>` becomes `<%# %>`
(spike) or `<%#  %>` (classic).

## Known defects of the spike

These are not decisions. None of them makes invalid Ruby, and only §U changes
rendering.

### S. Line structure inside ERB tags is not preserved

The spike trims a tag's code and re-emits it, so authored line structure
inside a tag is partly lost:

- `<%=` or `<%` alone on its line is collapsed onto the first code line, and
  `%>` alone on its line onto the last (9 inputs). Upstream #2059 keeps the
  authored shape.
- After a heredoc terminator, the spike puts `%>` in column 0; the classic
  printer indents it to the tag's level (2 inputs). Both are valid Ruby.
- Since #2632, the parser splits a tag that both continues and closes a block
  (`<% else\n  y\nend %>`) into two nodes. The classic printer prints them as
  two tags, `<% else\n  y %>` and `<% end %>`; the spike joins them into one
  tag, `<% else\n  y  end %>` (6 inputs).

The likely fix is to keep an authored newline after the opening delimiter as a
`hardline` in the tag's Doc, and to print the two halves of a split tag with
their own delimiters, as the classic printer does.

### U. Whitespace-preserving classes are ignored

The classic printer keeps the content of elements with the Tailwind classes
`whitespace-pre`, `whitespace-pre-wrap` and `whitespace-pre-line` verbatim.
The spike formats their children normally:

```erb
<div class="whitespace-pre">           spike:
  <span>  a   b  </span>                <div class="whitespace-pre">
</div>                                     <span> a b </span>
                                         </div>
```

Under `whitespace-pre` and `whitespace-pre-wrap` the removed spaces render, so
this changes the page. The corpus has only `whitespace-pre-line`, where runs
of spaces collapse anyway, so the harness counts it as layout-only. Checked by
hand.

### V. Text inside control-flow bodies is not filled

Text runs are filled only in element bodies. Inside an `if` or a block, each
space-separated item gets its own line:

```erb
<% if x %>                    spike:   <% if x %>
  Label <%= a %> : value                 Label
<% end %>                                <%= a %>
                                         : value
                                       <% end %>
```

The rendering is the same, but the classic printer keeps the line, and so
should the spike.

### W. Inline siblings without text between them are broken apart

`<div><span><em>a</em> <em>b</em></span></div>` (44 columns) becomes

```erb
<div>
  <span><em>a</em>
    <em>b</em></span>
</div>
```

Two inline elements with only a space between them are not a fill run, so
they are joined as block parts, with a hard line break. The rendering is the
same, but the line fits and should stay as authored.

## Other limitations

- `HTMLConditionalElementNode` (an element with conditional open *and* close
  tags) has a basic lowering, only smoke-tested against the corpus.
- Class-value wrapping uses the true remaining width at the value's indent,
  not the classic printer's `maxLineLength − indent − 6`, so tokens sometimes
  wrap one word later. Matching it exactly would be possible.
- Rewriters, CLI and LSP sit behind the `Formatter.format()` seam (design §8).

## Maintainer arbitration needed (design §9.1)

1. The blank-line policy (§A) rewrites the largest share of existing fixture
   expectations, so it changes the default output of most templates.
2. The §C spec conflicts: `text-content.test.ts` (TODO-marked) and the inline
   `link_to`/loop expansions in `test/erb/erb.test.ts` contradict the
   whitespace-preservation targets. The spike sides with the latter.
3. §E and §L are cases where the classic output changes rendered whitespace
   or exceeds the width limit and the spike does not. They are proposed as
   fixes, and listed here because they change existing fixture expectations.
