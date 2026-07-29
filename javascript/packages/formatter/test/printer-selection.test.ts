import { describe, test, expect, beforeAll } from "vitest"
import { Herb } from "@herb-tools/node-wasm"
import dedent from "dedent"

import { Formatter } from "../src"

import type { Config } from "@herb-tools/config"

// Four attributes on a line that fits in 80 columns: the classic printer
// breaks them (attribute-count rule), the Doc-IR printer keeps everything
// inline (width-driven wrapping) — a deterministic way to tell them apart.
const source = `<div id="a" class="b" data-x="c" data-y="d">Content</div>`

const classicOutput = dedent`
  <div
    id="a"
    class="b"
    data-x="c"
    data-y="d"
  >
    Content
  </div>
`

describe("printer selection", () => {
  beforeAll(async () => {
    await Herb.load()
  })

  test("defaults to the classic printer", () => {
    const formatter = new Formatter(Herb)

    expect(formatter.format(source)).toEqual(classicOutput)
  })

  test("printer: 'doc-ir' constructor option selects the Doc-IR printer", () => {
    const formatter = new Formatter(Herb, { printer: "doc-ir" })

    expect(formatter.format(source)).toEqual(source)
  })

  test("per-call option overrides the constructor option", () => {
    const formatter = new Formatter(Herb, { printer: "doc-ir" })

    expect(formatter.format(source, { printer: "classic" })).toEqual(classicOutput)
    expect(formatter.format(source, { printer: "doc-ir" })).toEqual(source)
  })

  test("formatter.printer from config flows through Formatter.from", () => {
    const config = { formatter: { printer: "doc-ir" } } as unknown as Config
    const formatter = Formatter.from(Herb, config)

    expect(formatter.format(source)).toEqual(source)
  })

  test("explicit option wins over config", () => {
    const config = { formatter: { printer: "doc-ir" } } as unknown as Config
    const formatter = Formatter.from(Herb, config, { printer: "classic" })

    expect(formatter.format(source)).toEqual(classicOutput)
  })
})
