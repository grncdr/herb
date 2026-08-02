import { describe, test, expect, beforeAll } from "vitest"
import { Herb } from "@herb-tools/node-wasm"
import dedent from "dedent"

import { Formatter } from "../src"

import type { Config } from "@herb-tools/config"

// These tests need one input the two printers demonstrably disagree on, to
// prove the selection actually took effect. The blank-line policy is the
// right choice: the classic printer inserts a blank line between siblings
// when one of them is multiline, the Doc-IR printer only preserves authored
// blank lines (DOC-IR-DIVERGENCES.md §A). That is a decided policy
// difference awaiting arbitration, so it will not drift out from under this
// test until the default flips.
//
// The previous discriminator here — four attributes on a line that fits,
// which the classic printer used to break one-per-line — stopped working
// when upstream #1834 adopted width-only attribute wrapping and the two
// printers converged.
const source = dedent`
  <div>
    <p>a
    multi</p>
    <p>b</p>
  </div>
`

const classicOutput = dedent`
  <div>
    <p>
      a multi
    </p>

    <p>b</p>
  </div>
`

const docIROutput = dedent`
  <div>
    <p>
      a multi
    </p>
    <p>b</p>
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

    expect(formatter.format(source)).toEqual(docIROutput)
  })

  test("per-call option overrides the constructor option", () => {
    const formatter = new Formatter(Herb, { printer: "doc-ir" })

    expect(formatter.format(source, { printer: "classic" })).toEqual(classicOutput)
    expect(formatter.format(source, { printer: "doc-ir" })).toEqual(docIROutput)
  })

  test("formatter.printer from config flows through Formatter.from", () => {
    const config = { formatter: { printer: "doc-ir" } } as unknown as Config
    const formatter = Formatter.from(Herb, config)

    expect(formatter.format(source)).toEqual(docIROutput)
  })

  test("explicit option wins over config", () => {
    const config = { formatter: { printer: "doc-ir" } } as unknown as Config
    const formatter = Formatter.from(Herb, config, { printer: "classic" })

    expect(formatter.format(source)).toEqual(classicOutput)
  })
})
