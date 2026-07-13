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
