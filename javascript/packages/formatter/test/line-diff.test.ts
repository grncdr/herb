import { describe, test, expect } from "vitest"
import dedent from "dedent"

import { unifiedDiff } from "../src/line-diff"

describe("unifiedDiff", () => {
  test("identical inputs produce an empty diff", () => {
    expect(unifiedDiff("a\nb", "a\nb", "x", "y")).toEqual("")
  })

  test("single changed line with context", () => {
    const a = "one\ntwo\nthree\nfour\nfive"
    const b = "one\ntwo\nTHREE\nfour\nfive"

    expect(unifiedDiff(a, b, "a", "b")).toEqual(dedent`
      --- a
      +++ b
      @@ -1,5 +1,5 @@
       one
       two
      -three
      +THREE
       four
       five
    `)
  })

  test("addition at the end", () => {
    expect(unifiedDiff("a\nb", "a\nb\nc", "x", "y")).toEqual(dedent`
      --- x
      +++ y
      @@ -1,2 +1,3 @@
       a
       b
      +c
    `)
  })

  test("distant changes produce separate hunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
    const changed = [...lines]

    changed[0] = "CHANGED1"
    changed[19] = "CHANGED20"

    const diff = unifiedDiff(lines.join("\n"), changed.join("\n"), "a", "b")

    expect(diff).toContain("@@ -1,4 +1,4 @@")
    expect(diff).toContain("@@ -17,4 +17,4 @@")
    expect(diff).toContain("-line1")
    expect(diff).toContain("+CHANGED1")
    expect(diff).toContain("-line20")
    expect(diff).toContain("+CHANGED20")
  })

  test("context is limited to three lines around changes", () => {
    const lines = Array.from({ length: 11 }, (_, i) => `l${i + 1}`)
    const changed = [...lines]

    changed[5] = "MID"

    const diff = unifiedDiff(lines.join("\n"), changed.join("\n"), "a", "b")

    expect(diff).not.toContain(" l1\n")
    expect(diff).toContain(" l3")
    expect(diff).toContain("-l6")
    expect(diff).toContain("+MID")
    expect(diff).toContain(" l9")
    expect(diff).not.toContain(" l10")
  })
})
