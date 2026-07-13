import { describe, test, expect } from "vitest"
import dedent from "dedent"

import { group, indent, line, softline, hardline, literalline, fill, ifBreak, lineSuffix, breakParent, join } from "../../src/doc-ir/doc.js"
import { printDocToString } from "../../src/doc-ir/layout.js"

const options = { indentWidth: 2, maxLineLength: 80 }
const narrow = { indentWidth: 2, maxLineLength: 20 }

function print(doc: Parameters<typeof printDocToString>[0], opts = options) {
  return printDocToString(doc, opts)
}

describe("layout", () => {
  test("plain strings concatenate", () => {
    expect(print(["a", "b", "c"])).toEqual("abc")
  })

  test("group renders flat when it fits", () => {
    const doc = group(["<div", indent([line, 'class="a"']), softline, ">"])

    expect(print(doc)).toEqual('<div class="a">')
  })

  test("group breaks when it does not fit", () => {
    const doc = group(["<div", indent([line, 'class="a"', line, 'id="b"']), softline, ">"])

    expect(print(doc, narrow)).toEqual(dedent`
      <div
        class="a"
        id="b"
      >
    `)
  })

  test("hardline forces enclosing group to break", () => {
    const doc = group(["a", indent([hardline, "b"]), hardline, "c"])

    expect(print(doc)).toEqual("a\n  b\nc")
  })

  test("softline renders as nothing when flat", () => {
    expect(print(group(["a", softline, "b"]))).toEqual("ab")
  })

  test("line renders as space when flat", () => {
    expect(print(group(["a", line, "b"]))).toEqual("a b")
  })

  test("fill keeps as many parts per line as fit", () => {
    const words = ["aaaa", "bbbb", "cccc", "dddd", "eeee"]
    const doc = fill(join(line, words))

    expect(print(doc, narrow)).toEqual("aaaa bbbb cccc dddd\neeee")
  })

  test("fill with glued separators keeps parts together", () => {
    const doc = fill(["aaaa", line, ["bbbb", "'s"], line, "cccc"])

    expect(print(doc, { indentWidth: 2, maxLineLength: 12 })).toEqual("aaaa bbbb's\ncccc")
  })

  test("nested groups break independently", () => {
    const inner = group(["<b>", "hi", "</b>"])
    const doc = group(["<p>", indent([softline, inner]), softline, "</p>"])

    expect(print(doc)).toEqual("<p><b>hi</b></p>")
  })

  test("breakParent forces break without output", () => {
    const doc = group(["a", line, "b", breakParent])

    expect(print(doc)).toEqual("a\nb")
  })

  test("ifBreak picks branch by group fate", () => {
    const flat = group(["x", ifBreak("BROKE", "FLAT")])
    const broken = group(["x", hardline, ifBreak("BROKE", "FLAT")])

    expect(print(flat)).toEqual("xFLAT")
    expect(print(broken)).toEqual("x\nBROKE")
  })

  test("literalline does not re-indent", () => {
    const doc = group(["<pre>", indent([hardline, "a", literalline, "    raw"]), hardline, "</pre>"])

    expect(print(doc)).toEqual("<pre>\n  a\n    raw\n</pre>")
  })

  test("lineSuffix defers to end of line", () => {
    const doc = ["a", lineSuffix(" <%# herb:disable %>"), hardline, "b"]

    expect(print(doc)).toEqual("a <%# herb:disable %>\nb")
  })

  test("lineSuffix at end of document is flushed", () => {
    const doc = ["a", lineSuffix(" trailing")]

    expect(print(doc)).toEqual("a trailing")
  })

  test("trailing whitespace is trimmed on breaks", () => {
    const doc = ["a ", hardline, "b"]

    expect(print(doc)).toEqual("a\nb")
  })

  test("indentation-only lines are trimmed to empty", () => {
    const doc = group(["a", indent([hardline, hardline, "b"])])

    expect(print(doc)).toEqual("a\n\n  b")
  })

  test("long fill inside broken group still fills", () => {
    const words = join(line, ["one", "two", "three", "four", "five", "six"])
    const doc = group(["<p>", indent([hardline, fill(words)]), hardline, "</p>"])

    expect(print(doc, narrow)).toEqual(dedent`
      <p>
        one two three four
        five six
      </p>
    `)
  })
})
