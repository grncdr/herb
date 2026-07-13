import { describe, test, expect, beforeAll } from "vitest"
import { Herb } from "@herb-tools/node-wasm"
import { Formatter } from "../../src"
import { createExpectFormattedToMatch } from "../helpers"

import dedent from "dedent"

// Regression fixtures for the "significant whitespace" family of formatter bugs.
//
// These all share one root cause: the formatter adds or removes whitespace that
// is *significant in the rendered HTML* — by putting ERB tags, punctuation, or
// inline elements on their own lines (which introduces rendered spaces), or by
// collapsing whitespace that was there on purpose.
//
// Cases are grouped by their GitHub issue. Each input/expected pair is
// transcribed (and, where noted, minimized to avoid line-wrap ambiguity) from
// the "Expected" block of the corresponding issue.
//
// Convention (matches the rest of this suite):
//   - `test(...)`        a case that should already pass — a regression guard.
//   - `test.fails(...)`  a case for a still-open bug — documents the *target*
//                        output and keeps CI green until it is fixed. When the
//                        bug is fixed the `.fails` starts failing; drop it then.
//
// NOTE: labels were verified against a local `vitest run`. The two remaining
// `test.fails` cases (the inline-`if`-in-text case of #1729 and the inline
// `tag.span do` block of #609) are deferred behind architectural changes
// documented in DEV-JOURNAL.md at the repo root.

let formatter: Formatter
let expectFormattedToMatch: ReturnType<typeof createExpectFormattedToMatch>

describe("@herb-tools/formatter - whitespace preservation", () => {
  beforeAll(async () => {
    await Herb.load()

    formatter = new Formatter(Herb, {
      indentWidth: 2,
      maxLineLength: 80,
    })

    expectFormattedToMatch = createExpectFormattedToMatch(formatter)
  })

  // https://github.com/marcoroth/herb/issues/1729 (open)
  // Newlines added inside control-flow/blocks push trailing text (`'s dog`, `!`)
  // onto its own line, rendering an extra space.
  describe("issue #1729 - newlines produce undesired whitespace", () => {
    test.fails("keeps text glued to an output tag inside an if block", () => {
      expectFormattedToMatch(dedent`
        <p>
          Hello
          <% if user %>
            <%= user.name %>'s dog
          <% end %>
        </p>
      `)
    })

    // DEFERRED (see DEV-JOURNAL.md): an inline `<% if %>...<% end %>` embedded
    // mid-text still gets pulled onto its own line, which reintroduces a
    // rendered space in the falsy branch (`Hello!` -> `Hello !`). A correct fix
    // needs the text-flow engine to render control-flow nodes as inline atomic
    // units — a larger, separately-scoped change.
    test.fails("keeps inline if content on one visual line", () => {
      expectFormattedToMatch(dedent`
        <p>
          Hello<% if owner %> <%= owner.name %>'s dog<% end %>!
          It's time for your walk.
        </p>
      `)
    })

    // @grncdr: only triggered by blocks / flow control; identical content at the
    // top level formats correctly.
    test.fails("keeps a comma attached to the ERB tag inside a block", () => {
      expectFormattedToMatch(dedent`
        <% if something? %>
          <%= @user.preferred_greeting %>,<br>
          <br>
          <p>blah blah</p>
        <% end %>
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/469 (closed)
  // A comma and a <br> after an output tag were each split onto their own line.
  describe("issue #469 - whitespace around interpolations and elements", () => {
    test("keeps trailing comma and <br> attached to the output tag", () => {
      expectFormattedToMatch(dedent`
        <%= @user.translated_greeting %>,<br>
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/855 (closed)
  // A space was inserted before the `'` that follows an output tag.
  describe("issue #855 - whitespace before apostrophe after ERB", () => {
    test("keeps the possessive 's attached to the output tag", () => {
      expectFormattedToMatch(dedent`
        <p>Lorem <%= name %>'s ipsum.</p>
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/931 (closed)
  // Punctuation between output tags was dropped onto its own line.
  describe("issue #931 - punctuation after ERB", () => {
    test("keeps commas attached to the preceding output tag", () => {
      expectFormattedToMatch(dedent`
        <p>Go to <%= a %>, <%= b %>, or <%= c %>.</p>
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/903 (closed)
  // A newline was inserted before the `.` following an output tag, related to a
  // preceding <br>.
  describe("issue #903 - newline before period after ERB", () => {
    test("keeps a period attached to the output tag after a <br>", () => {
      expectFormattedToMatch(dedent`
        <p>
          <strong>Title</strong><br>
          <%= foo %> text <%= bar %>. More text here.
        </p>
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/904 (closed)
  // Adjacent output tags were split onto separate lines inside a block,
  // rendering "abcdef *" instead of "abcdef*".
  describe("issue #904 - whitespace inside block content", () => {
    test("keeps adjacent output tags glued together inside a block", () => {
      expectFormattedToMatch(dedent`
        <% some_block do %>
          <%= "abcdef" %><%= "*" if required? %>
        <% end %>
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/609 (closed)
  // Whitespace both inserted where there was none and removed where it existed.
  describe("issue #609 - whitespace inserted and removed", () => {
    test("does not insert whitespace after a non-output ERB tag", () => {
      expectFormattedToMatch(dedent`
        <%= link_to "/" do %>
          <% icon("icon") %>can not insert whitespace here
        <% end %>
      `)
    })

    test("does not split text away from an inline element", () => {
      expectFormattedToMatch(dedent`
        <div>inserted-<b>bold text</b>. Next.</div>
      `)
    })

    // DEFERRED (see DEV-JOURNAL.md): the inline `do`/`end` block is expanded
    // onto multiple lines. This is a documented, parser-blocked limitation
    // (`tag.span do` must first be transformed into an HTMLElementNode); see the
    // TODO in test/html/text-content.test.ts which asserts the current
    // multiline output. A formatter-only fix would contradict that spec.
    test.fails("does not expand an inline tag.span block", () => {
      expectFormattedToMatch(dedent`
        <%= tag.span do %>This should stay on one line<% end %>
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/478 (closed)
  // A blank line was inserted between an inline element and the text after it.
  describe("issue #478 - whitespace inserted where there was none", () => {
    test("does not insert whitespace between an inline element and text", () => {
      expectFormattedToMatch(dedent`
        <a href="#">foo</a>: bar
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/727 (closed)
  // Spaces around output tags in text content were removed.
  describe("issue #727 - whitespace removed in text content", () => {
    test("preserves spaces around output tags in text", () => {
      expectFormattedToMatch(dedent`
        Hello, <%= @name %>, it is <%= @time %>.
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/251 (closed)
  // Inline elements were split across lines, adding rendered spaces between
  // syllables. (Also covered in inline-elements.test.ts.)
  describe("issue #251 - inline tags broken by added spacing", () => {
    test("preserves inline elements in text flow", () => {
      expectFormattedToMatch(dedent`
        <p>Em<em>pha</em>sis</p>
      `)
    })
  })

  // https://github.com/marcoroth/herb/issues/588 (closed)
  // Each format pass appended another "Text 1\n<br>" — formatting never
  // stabilized. Assert idempotency rather than an exact output.
  describe("issue #588 - recursive text/<br> duplication", () => {
    test("formatting is idempotent (no recursive duplication)", () => {
      const source = dedent`
        <%= form_with model: @article do |form| %>
          <div>
            <p>
              Text 1
              <br>
              The lantern flickered softly in the wind as the old clock struck midnight across the quiet village, casting long shadows..
            </p>
          </div>
        <% end %>
      `

      const once = formatter.format(source)
      const twice = formatter.format(once)

      expect(twice).toEqual(once)
    })
  })
})
