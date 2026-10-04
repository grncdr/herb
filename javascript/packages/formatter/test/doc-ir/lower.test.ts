import { describe, test, expect, beforeAll } from "vitest"
import { Herb } from "@herb-tools/node-wasm"
import dedent from "dedent"

import { printWithDocIR } from "../../src/doc-ir/lower.js"

const options = { indentWidth: 2, maxLineLength: 80 }

function format(source: string, opts = options): string {
  const result = Herb.parse(source)

  if (result.failed) throw new Error("parse failed")

  return printWithDocIR(result.value, { ...opts, source })
}

describe("doc-ir lowering", () => {
  beforeAll(async () => {
    await Herb.load()
  })

  test("simple element stays inline when authored inline", () => {
    expect(format(`<div>hello</div>`)).toEqual(`<div>hello</div>`)
  })

  test("authored-multiline block element stays multiline", () => {
    const source = dedent`
      <div>
        hello
      </div>
    `

    expect(format(source)).toEqual(source)
  })

  test("attributes wrap when over the line length", () => {
    const source = `<div class="alpha" id="beta" data-controller="gamma" data-action="delta" data-target="epsilon">x</div>`

    expect(format(source)).toEqual(dedent`
      <div
        class="alpha"
        id="beta"
        data-controller="gamma"
        data-action="delta"
        data-target="epsilon"
      >
        x
      </div>
    `)
  })

  test("quote normalization: single to double quotes", () => {
    expect(format(`<div id='a'>x</div>`)).toEqual(`<div id="a">x</div>`)
  })

  test("ERB tag content is normalized to single spaces", () => {
    expect(format(`<%=user.name%>`)).toEqual(`<%= user.name %>`)
  })

  test("text flow glues source-adjacent content (issue #855)", () => {
    expect(format(`<p>Lorem <%= name %>'s ipsum.</p>`)).toEqual(`<p>Lorem <%= name %>'s ipsum.</p>`)
  })

  // Case A (#1729)
  test("keeps text glued to an output tag inside an if block", () => {
    const source = dedent`
      <p>
        Hello
        <% if user %>
          <%= user.name %>'s dog
        <% end %>
      </p>
    `

    expect(format(source)).toEqual(source)
  })

  // Case B (#1729) — inline if participates in text flow
  test("keeps inline if content on one visual line", () => {
    const source = dedent`
      <p>
        Hello<% if owner %> <%= owner.name %>'s dog<% end %>!
        It's time for your walk.
      </p>
    `

    const result = format(source)

    // The falsy branch must not gain rendered whitespace: "Hello" stays glued
    // to the if opening and "!" to the end tag.
    expect(result).toContain(`Hello<% if owner %> <%= owner.name %>'s dog<% end %>!`)
  })

  // Case C (#1729 / @grncdr)
  test("keeps a comma attached to the ERB tag inside a block", () => {
    const source = dedent`
      <% if something? %>
        <%= @user.preferred_greeting %>,<br>
        <br>
        <p>blah blah</p>
      <% end %>
    `

    expect(format(source)).toEqual(source)
  })

  // Case D (#609)
  test("does not expand an inline tag.span block", () => {
    const source = `<%= tag.span do %>This should stay on one line<% end %>`

    expect(format(source)).toEqual(source)
  })

  test("multiline if/else keeps its structure", () => {
    const source = dedent`
      <% if admin? %>
        <p>Admin</p>
      <% else %>
        <p>User</p>
      <% end %>
    `

    expect(format(source)).toEqual(source)
  })

  test("blank lines between siblings are preserved, capped at one", () => {
    const source = "<p>a</p>\n\n\n<p>b</p>"

    expect(format(source)).toEqual("<p>a</p>\n\n<p>b</p>")
  })

  test("blank lines are not inserted where none existed", () => {
    const source = dedent`
      <div>
        <p>a</p>
        <p>b</p>
      </div>
    `

    expect(format(source)).toEqual(source)
  })

  test("pre content is preserved verbatim", () => {
    const source = dedent`
      <pre>
        keep   this
          exact
      </pre>
    `

    expect(format(source)).toEqual(source)
  })

  test("long text wraps at the maximum line length", () => {
    const source = `<p>${"word ".repeat(30).trim()}</p>`
    const result = format(source)

    for (const line of result.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80)
    }

    expect(result.startsWith("<p>")).toBe(true)
  })

  test("erb block with multiline body expands", () => {
    const source = dedent`
      <%= form_with(model: post) do |form| %>
        <div>
          <%= form.label :title %>
        </div>
      <% end %>
    `

    expect(format(source)).toEqual(source)
  })

  test("herb:disable comment lands at the end of its anchor line", () => {
    const source = `<div style="color: red"> <%# herb:disable format %> </div>`
    const result = format(source)

    expect(result).toContain(`herb:disable`)
    expect(result.split("\n")[0]).toContain(`<%# herb:disable format %>`)
  })

  test("html comment formatting", () => {
    expect(format(`<!--comment-->`)).toEqual(`<!-- comment -->`)
  })

  describe("multi-line HTML comments", () => {
    test("body indentation follows the comment's own depth", () => {
      const source = dedent`
        <div>
          <!--
            <ul>
              <li>one</li>
            </ul>
          -->
        </div>
      `

      expect(format(source)).toEqual(source)
    })

    test("body indentation follows a deeply nested comment", () => {
      const source = dedent`
        <div>
          <div>
            <div>
              <!--
                <p>deep</p>
              -->
            </div>
          </div>
        </div>
      `

      expect(format(source)).toEqual(source)
    })

    test("a top-level comment body sits at one indent level", () => {
      const source = dedent`
        <!--
          <p>a</p>
        -->
      `

      expect(format(source)).toEqual(source)
    })

    test("relative indentation inside the body is preserved, base is not", () => {
      const source = `<div>\n  <!--\nComment\n    on\nmultiple\nlines\n  -->\n</div>`

      expect(format(source)).toEqual(dedent`
        <div>
          <!--
            Comment
                on
            multiple
            lines
          -->
        </div>
      `)
    })

    test("a body outdented past its comment is pulled to the body indent", () => {
      const source = `<div>\n  <!--\n<p>outdented</p>\n  -->\n</div>`

      expect(format(source)).toEqual(dedent`
        <div>
          <!--
            <p>outdented</p>
          -->
        </div>
      `)
    })

    test("blank lines inside the body carry no indentation", () => {
      const source = `<div>\n  <!--\n    a\n\n    b\n  -->\n</div>`

      expect(format(source)).toEqual(`<div>\n  <!--\n    a\n\n    b\n  -->\n</div>`)
    })

    test("content on the opening line flattens the body", () => {
      const source = `<div>\n  <!-- Comment\n    more -->\n</div>`

      expect(format(source)).toEqual(dedent`
        <div>
          <!--
            Comment
            more
          -->
        </div>
      `)
    })

    test("a closing marker glued to the last body line stays glued", () => {
      const source = `<div>\n  <!--\n    a\n    b -->\n</div>`

      expect(format(source)).toEqual(`<div>\n  <!--\n    a\n    b-->\n</div>`)
    })

    test("a single glued body line does not accumulate indentation", () => {
      // The classic printer measures the body's left edge while excluding the
      // last line, so this shape gains one indent level per pass (4 → 8 → 12).
      // Deliberate divergence: the body's own indent is the measurement.
      const source = `<div>\n  <!--\n    a -->\n</div>`
      const once = format(source)

      expect(once).toEqual(`<div>\n  <!--\n    a-->\n</div>`)
      expect(format(once)).toEqual(once)
    })

    test("IE conditional comments are copied verbatim", () => {
      const source = `<!--[if IE]><p>ie</p><![endif]-->`

      expect(format(source)).toEqual(source)
    })

    test("nested comments are idempotent", () => {
      const source = dedent`
        <div>
          <div>
            <!--
              <ul>
                <li>one</li>
              </ul>
            -->
          </div>
        </div>
      `
      const once = format(source)

      expect(format(once)).toEqual(once)
    })
  })

  // Inputs from upstream #2407 (test/erb/comment.test.ts), plus glued
  // neighbours in control flow and inline elements.
  describe("own-line ERB tags (=begin/=end, heredocs)", () => {
    const expectFixedPoint = (source: string) => {
      const once = format(source)

      expect(format(once)).toEqual(once)
      expect(Herb.parse(once).value.recursiveErrors()).toEqual([])

      return once
    }

    test("keeps `=begin`/`=end` delimiters anchored to column 0", () => {
      const source = dedent`
        <%
        =begin %>
        commented out
        <%
        =end %>
        <div>Content</div>
      `

      expect(expectFixedPoint(source)).toEqual(source)
    })

    test("leaves a delimiter in column 0 when the tag itself is indented", () => {
      const source = dedent`
        <div>
          <%
        =begin %>
          x
          <%
        =end %>
        </div>
      `

      expect(expectFixedPoint(source)).toEqual(source)
    })

    // The classic printer also inserts blank lines around the <span>; the
    // spike only preserves authored ones (DOC-IR-DIVERGENCES.md §A).
    test("does not collapse a block comment onto a single line", () => {
      const source = dedent`
        <%
        =begin %>
        <span class="x">x</span>
        <%
        =end %>
      `

      expect(expectFixedPoint(source)).toEqual(source)
    })

    test("keeps a heredoc carrying the delimiter text on its own lines inside a text flow", () => {
      const source = dedent`
        <p>before <%= <<HEREDOC
        =begin literal
        HEREDOC
        %> after</p>
      `

      expect(expectFixedPoint(source)).toEqual(dedent`
        <p>
          before
          <%= <<HEREDOC
        =begin literal
        HEREDOC
        %>
          after
        </p>
      `)
    })

    test("does not treat heredoc body text as a block-comment delimiter", () => {
      const source = dedent`
        <%= <<HEREDOC
        =begin literal
        HEREDOC
        %>
      `

      expect(expectFixedPoint(source)).toEqual(source)
    })

    test("an already-expanded block comment is a fixed point", () => {
      const source = dedent`
        <%
        =begin
        %>
        commented out
        <%
        =end
        %>
      `

      expect(expectFixedPoint(source)).toEqual(source)
    })

    // Text glued *after* `=end %>` cannot be tested: the comment line would
    // swallow it (Erubi emits `=end ; _buf << ...`), and here also the `if`'s
    // `end`, so Herb rejects the source.
    test("glued neighbours inside control flow move to their own lines", () => {
      const source = "<% if x %>a<%\n=begin %>b<%\n=end %>\n<% end %>"

      // `a` stays glued to `<% if x %>`: that boundary has no own-line tag.
      expect(expectFixedPoint(source)).toEqual(dedent`
        <% if x %>a
          <%
        =begin %>
          b
          <%
        =end %>
        <% end %>
      `)
    })

    test("glued boundaries of an inline element break around an own-line tag", () => {
      const source = "<span><%\n=begin %>x<%\n=end %></span>"

      expect(expectFixedPoint(source)).toEqual(dedent`
        <span>
          <%
        =begin %>
          x
          <%
        =end %>
        </span>
      `)
    })
  })

  test("case/when structure", () => {
    const source = dedent`
      <% case status %>
      <% when :active %>
        Active
      <% when :archived %>
        Archived
      <% end %>
    `

    expect(format(source)).toEqual(source)
  })
})
