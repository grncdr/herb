import { describe, test, expect, beforeAll } from "vitest"
import { Herb } from "@herb-tools/node-wasm"
import dedent from "dedent"

import { printWithDocIR } from "../../src/doc-ir/lower.js"

const options = { indentWidth: 2, maxLineLength: 80 }

function format(source: string, opts = options): string {
  const result = Herb.parse(source)

  if (result.failed) throw new Error("parse failed")

  return printWithDocIR(result.value, opts)
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
