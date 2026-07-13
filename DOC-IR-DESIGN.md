# Doc-IR: A layout intermediate representation for the Herb formatter

Design document for rewriting `@herb-tools/formatter`'s printing core around a
document intermediate representation (Doc-IR), replacing direct string emission.

Status: **spike / draft** — not yet proposed upstream.

## 1. Problem

The current `FormatPrinter` is a visitor that writes strings directly into a
`lines: string[]` buffer while deciding layout on the fly. Because there is no
representation between "AST" and "final text", every layout question is
answered by one of:

- **Speculative rendering** — render a subtree to a string, measure it, throw
  it away (`capture()`, `tryRenderInlineFull()`), including monkey-patching
  `this.push`/`this.visit` to no-ops (`captureNodes()`). Subtrees are
  re-analyzed once per ancestor: superlinear.
- **Mutable side-channels** — `nodeIsMultiline` is populated *during* rendering
  and consumed by `SpacingAnalyzer`, making spacing decisions depend on render
  order. Speculative passes write to the same maps as the real pass.
- **Post-hoc output mutation** — blank lines are `splice()`d into the line
  buffer after the fact; `herb:disable` comments are re-attached by
  substring-searching the rendered output for `<tagname` (first match wins).
- **String sniffing** — regexes over already-rendered text
  (`endsWithERBTag(currentLine)`, punctuation heuristics) recover information
  the AST had and the printer discarded.

"Is this node glued to its neighbor?" — the question underlying the
significant-whitespace bug family (#1729, #469, #855, #931, #609, …) — is
re-derived independently at four sites with four different answers
(`shouldAppendToLastLine`, `isSourceAdjacentToPrevious`,
`tryMergeAtomicAfterText`, `tryRenderChildrenInline`).

The bug tracker (26 open formatter issues) is dominated by consequences of
this design, and fixes are whack-a-mole: each one adds another local heuristic.

## 2. The Doc-IR in one paragraph

Formatting becomes a two-phase pipeline:

```
Herb AST  ──lower──▶  Doc  ──layout──▶  string
```

The **Doc** is a small algebraic data type describing *possible* layouts —
where breaks may occur, what indentation applies when they do, which parts
must stay atomic. A single generic **layout function** then chooses the
concrete layout by measuring against `maxLineLength`. All formatting *policy*
lives in the lowering; all *measurement and line-breaking mechanics* live in
the layout function. Neither knows about the other's internals.

This is the architecture of Prettier's printer (Wadler's "A prettier printer"
algebra, extended), also used by Biome, dprint, and rustfmt-adjacent tools.
It is the known solution for this class of formatter.

## 3. The IR

```ts
type Doc =
  | string                                    // literal text, no newlines
  | Doc[]                                     // concatenation
  | { type: "group", contents: Doc,           // try flat; if it doesn't fit, break
      breakParent?: boolean, id?: symbol }
  | { type: "indent", contents: Doc }         // +1 indent level for line breaks inside
  | { type: "line" }                          // space when flat, newline when broken
  | { type: "softline" }                      // nothing when flat, newline when broken
  | { type: "hardline" }                      // always a newline; forces enclosing groups to break
  | { type: "literalline" }                   // newline without re-indentation (pre/script content)
  | { type: "fill", parts: Doc[] }            // paragraph filling: break between parts only as needed
  | { type: "ifBreak", breakContents: Doc,    // conditional on enclosing group's fate
      flatContents: Doc, groupId?: symbol }
  | { type: "lineSuffix", contents: Doc }     // defer to end of current line (trailing comments)
  | { type: "breakParent" }                   // force enclosing group to break
```

Semantics worth calling out:

- **`group`** is the unit of layout choice. The layout function asks one
  question, in one place: *does the flat rendering of this group fit on the
  remaining line width?* If yes, `line` → `" "`, `softline` → `""`. If no, the
  group breaks and its `line`/`softline` become newlines at the current indent.
  This single mechanism replaces `shouldRenderOpenTagInline`,
  `shouldRenderElementContentInline`, `shouldRenderCloseTagInline`,
  `attributeRenderer.shouldRenderInline`, and every `capture()`-and-measure
  site in the current code.
- **`fill`** is paragraph layout: given alternating content/separator parts,
  it breaks *only* the separators that need to break, keeping as many parts
  per line as fit. This is precisely the text-flow problem
  (`TextFlowEngine`/`TextFlowAnalyzer`/`text-flow-helpers`, ~840 lines) as a
  primitive.
- **`hardline` propagates**: a hard break inside a group forces the group to
  break (`propagateBreaks` pass). This replaces the `nodeIsMultiline`
  side-channel — "will this child render multiline?" stops being a question
  anyone needs to ask, because the parent group's fate follows mechanically
  from its contents.
- **`lineSuffix`** solves `herb:disable` exactly: lower the comment as a
  line-suffix attached at its anchor's position in the Doc, and it lands at
  the end of whatever output line the anchor ends up on — no searching
  rendered output, no ambiguity with repeated tags.

The layout function (`printDocToString`) is ~150–250 lines, is entirely
generic (knows nothing about HTML or ERB), and runs in linear time over the
Doc with a bounded-lookahead `fits()` check.

## 4. Lowering: Herb AST → Doc

One module per node family. Sketches:

### Elements

```ts
// <div class="a">content</div>
group([
  group(["<div", indent([line, ...attrDocs]), softline, ">"]),  // attr wrapping
  indent([softline, ...childDocs]),
  softline,
  "</div>",
])
```

Fits on one line → renders inline. Doesn't fit → attributes and/or children
break, each governed by its own group.

**Decided attribute policy (2026-07-13):**

- Wrapping is purely width-driven (Prettier semantics); no attribute-count
  rules. When the open tag breaks, attributes go one per line, `>` on its own
  line at tag indent.
- An attribute value containing a newline in the source forces the
  attribute-per-line form: lowered as a `breakParent` in the open-tag group.
- Long `class` values keep being token-wrapped. The value lowers to its own
  nested group — quotes act like brackets:

  ```ts
  group(['class="', indent([softline, fill(join(line, tokens))]), softline, '"'])
  ```

  Flat: `class="a b c"`. Broken, the target shape is:

  ```html
  <div
    class="
      class1 class2 ...
      class20 class21
    "
  >
  ```

  The wrap width for value tokens is whatever remains at the value's indent
  level — the current code's `−6` constant is this value-indentation cost
  made explicit by structure instead of arithmetic. The 80/60 minimum-length
  constants disappear; fitting decides.
- Values containing ERB are never token-wrapped (unchanged).

### Text flow

```ts
// "Hello <em>world</em>, welcome"
fill(["Hello", line, ["<em>", "world", "</em>", ","], line, "welcome"])
```

Words and atomic inline runs become fill parts; whitespace significance
determines whether the separator is `line` (breakable space) or `""`
(glued — e.g. `<%= name %>'s`). The four adjacency predicates collapse into
one decision made once, during lowering.

### ERB control flow

```ts
// <% if admin? %> ... <% end %>
group([
  "<% if admin? %>",
  indent([hardline, ...bodyDocs]),
  hardline,
  "<% end %>",
])
```

Control flow that must stay multiline uses `hardline` (and thereby forces
ancestors to break — the current `hasComplexERBControlFlow` heuristic becomes
structural). Control flow allowed to inline in attribute position uses `line`
within a group instead.

### Content-preserving elements (`pre`, `script`, `style`, `textarea`)

Lower the raw source slice with `literalline` separators. No special
"content-preserving context" flag threaded through the printer.

### Blank-line policy

**Decided (2026-07-13, spike owner):** the formatter never inserts blank
lines. It preserves authored blank lines, capped at one. This retires the
current `SpacingAnalyzer` insertion heuristics wholesale — the multiline-
sibling rule, the same-tag "tag group" boundary rule, the spaceable-container
distinction, and the blank lines forced around multiline ERB control-flow
blocks. (Verified against the current formatter: all four behaviors reproduce
on `main`; each was reviewed as a concrete before/after case.)

Lowering emits `hardline` between siblings, or `[hardline, hardline]` where
the source gap contains a blank line: a pure function `(sourceGap) →
separator`, invoked once per gap. The only insertion exception worth keeping
is a blank line after doctype/XML declarations.

## 5. Whitespace significance as a first-class pass

Before lowering, a normalization pass classifies every inter-node gap:

```ts
type Gap =
  | { kind: "glued" }          // no whitespace in source; whitespace would change rendering
  | { kind: "space" }          // breakable: whitespace exists and collapses to one space
  | { kind: "line" }           // insignificant for rendering; layout may choose
  | { kind: "blank" }          // user blank line to preserve (subject to policy)
  | { kind: "preserve" }       // inside pre/textarea etc.: copy verbatim
```

The classifier is the *only* code that reads source whitespace. Lowering maps
`Gap` → Doc separator mechanically (`glued` → `""`, `space` → `line` inside
`fill`, …). The significant-whitespace regression corpus
(`test/html/whitespace-preservation.test.ts`) becomes the classifier's direct
spec.

## 6. Benefits

**Correctness.**
- Whitespace significance decided once, by one classifier, with a dedicated
  test suite — versus four divergent ad-hoc predicates.
- `herb:disable` placement is structural (`lineSuffix`), eliminating the
  output-grepping class of bugs.
- No render-order-dependent state; layout is a pure function of the Doc.
- Idempotency becomes provable in practice: same AST → same Doc → same output.

**Performance.**
- Lowering is one pass over the AST; layout is linear with bounded lookahead.
  Replaces per-ancestor subtree re-rendering (superlinear today).

**Simplicity.**
- The five interlocking decision modules (`FormatPrinter` layout logic,
  `TextFlowEngine`, `TextFlowAnalyzer`, `SpacingAnalyzer`, half of
  `format-helpers`) collapse into: classifier + lowering + generic layout.
  Expected net deletion of code, with the remaining code stratified into
  pure, independently testable functions.
- `capture`, `captureNodes`, `trackBoundary`, `pushToLastLine`,
  `nodeIsMultiline`, line `splice()` — all cease to exist.

**Testability & debuggability.**
- The Doc is inspectable: a failing case can be debugged by printing the IR
  and seeing *which group* broke and why, instead of stepping through
  emission order.
- Policy changes (e.g. the requested "don't force blank lines" option) become
  parameters of lowering, testable without the layout engine.

**Portability.**
- The layout engine is ~200 lines of language-agnostic algorithm; lowering is
  a mapping per node type. If a native (Ruby/Rust/C) formatter is ever
  needed, this design is what makes a port mechanical. The current design is
  unportable in practice.

## 7. Spike plan

Goal: prove the pipeline end-to-end against the existing fixture corpus
without touching the current formatter.

1. **`doc.ts`** — IR types + builder helpers (`group`, `indent`, `line`, …).
2. **`layout.ts`** — `propagateBreaks` + `fits` + `printDocToString`.
   Port semantics from Prettier's `document` package (MIT); no dependency.
3. **`gaps.ts`** — whitespace-significance classifier over Herb AST siblings.
4. **`lower.ts`** — AST → Doc for a vertical slice: elements, attributes,
   text flow, ERB content tags, `if/else/end`.
5. **Validation harness** — run the existing dedent fixtures through the
   spike; report exact-match rate vs. current formatter output, and diff
   categories (intentional divergence vs. regression). Auto-check
   idempotency and reparse-equality for every fixture.

Exit criteria for the spike: ≥ 90% exact-match on the `html/` and `erb/`
fixture suites, all `test.fails` whitespace-preservation cases passing, zero
reparse mismatches, and a written list of intentional output divergences for
maintainer review.

## 8. Non-goals (this spike)

- Embedded Ruby (Prism-based) formatting of ERB content — separate decision.
- Rewriters, CLI, LSP integration — unchanged; the rewrite is behind the
  existing `Formatter.format()` seam.
- Config surface changes (new options) — noted where the design makes them
  cheap, but not added.

## 9. Open questions (need maintainer/human input)

1. Which current fixture expectations are spec vs. accident — arbitration
   needed where the spike diverges.
2. ~~Blank-line policy~~ — **resolved**: preserve-only, cap 1 (see §4).
   Existing fixtures that expect inserted blank lines will diverge by design;
   this is the largest intentional-divergence category for maintainer review,
   since it changes current default output for most templates.
3. ~~Attribute-count rules~~ — **resolved**: dropped. Attribute wrapping is
   purely width-driven (Prettier semantics): the open-tag group breaks iff it
   exceeds `maxLineLength`, regardless of attribute count. The `>3 attributes
   → always break` rule and its speculative counting inside ERB conditionals
   go away. Class-value token wrapping is kept; multiline attribute values
   force the attribute-per-line form; the 80/60/−6 constants are replaced by
   group fitting (full spec and target output shape in §4).
   Attribute *ordering* is intentionally untouched by the printer: sorting
   (like the existing Tailwind class sorter) belongs in pre-format AST
   rewriters, where an attribute-order rewriter could be added later without
   printer changes — noting that ERB control flow interleaved with attributes
   constrains safe reordering.
4. ~~Rollout~~ — **resolved**: replace the printer outright under the
   existing "Experimental Preview" label; no compatibility flag, no dual
   implementation. The old printer's behavior survives only as fixtures.
