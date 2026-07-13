/**
 * Doc-IR validation harness (DOC-IR-DESIGN.md §7.5).
 *
 * Replays the captured corpus (see capture-setup.ts) through both the
 * current FormatPrinter and the Doc-IR spike, and reports:
 *   - exact-match rate and divergence categories
 *   - idempotency of the spike output
 *   - reparse-equality (structural) of spike output vs source
 *
 * Run:
 *   CORPUS_FILE=... yarn vitest run --config vitest.corpus.config.ts   # capture
 *   RUN_DOC_IR_HARNESS=1 CORPUS_FILE=... REPORT_FILE=... yarn vitest run test/doc-ir/harness/replay-harness.test.ts
 */

import { describe, test, beforeAll } from "vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { Herb } from "@herb-tools/node-wasm"

import { FormatPrinter } from "../../../src/format-printer.js"
import { isScaffoldTemplate } from "../../../src/scaffold-template-detector.js"
import { hasFormatterIgnoreDirective } from "../../../src/format-ignore.js"
import { printWithDocIR } from "../../../src/doc-ir/lower.js"

import { isNode, isToken } from "@herb-tools/core"
import { Node, HTMLTextNode, WhitespaceNode, HTMLCommentNode, HTMLAttributeValueNode } from "@herb-tools/core"

interface CorpusEntry {
  source: string
  indentWidth: number
  maxLineLength: number
}

interface Sample {
  source: string
  current?: string
  spike?: string
  error?: string
}

type Category = "exact" | "blank-only" | "layout-only" | "content-diff" | "spike-error"

const HARNESS_ENABLED = !!process.env.RUN_DOC_IR_HARNESS

/** Structural signature: whitespace-insensitive between nodes, quote- and
 *  ERB-spacing-normalized, so it survives legitimate formatting. */
function signature(node: unknown): unknown {
  if (node === null || node === undefined) return null

  if (isToken(node as never)) {
    return (node as { value: string }).value.trim()
  }

  if (Array.isArray(node)) {
    return node.map(signature).filter(part => part !== undefined)
  }

  if (typeof node !== "object") return node

  const anyNode = node as Node & Record<string, unknown>

  if (isNode(anyNode, WhitespaceNode)) return undefined

  if (isNode(anyNode, HTMLTextNode)) {
    const collapsed = anyNode.content.replace(/[ \t\n\r]+/g, " ")

    if (collapsed.trim() === "") return undefined

    return { type: "text", content: collapsed }
  }

  if (isNode(anyNode, HTMLCommentNode)) {
    const inner = (anyNode.children as Node[]).map(child => signature(child))

    return { type: "comment", inner: JSON.stringify(inner).replace(/[ \t\n\r]+/g, " ") }
  }

  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(anyNode)) {
    if (key === "location" || key === "errors" || key === "prism_node" || key === "element_source" || key === "range") continue

    if (isNode(anyNode, HTMLAttributeValueNode) && (key === "open_quote" || key === "close_quote")) {
      result[key] = value ? '"' : null
      continue
    }

    result[key] = signature(value)
  }

  return result
}

function signatureString(source: string): string | null {
  const parsed = Herb.parse(source)

  if (parsed.failed) return null

  return JSON.stringify(signature(parsed.value))
}

function stripBlankLines(text: string): string {
  return text.split("\n").filter(line => line.trim() !== "").join("\n")
}

function collapseAllWhitespace(text: string): string {
  return text.replace(/[ \t\n\r]+/g, " ").trim()
}

describe.skipIf(!HARNESS_ENABLED)("doc-ir replay harness", () => {
  beforeAll(async () => {
    await Herb.load()
  })

  test("replay corpus and write divergence report", { timeout: 600_000 }, () => {
    const corpusFile = process.env.CORPUS_FILE
    const reportFile = process.env.REPORT_FILE ?? "/tmp/doc-ir-report.json"

    if (!corpusFile) throw new Error("CORPUS_FILE not set")

    const lines = readFileSync(corpusFile, "utf8").split("\n").filter(Boolean)
    const seen = new Set<string>()
    const entries: CorpusEntry[] = []

    for (const line of lines) {
      if (seen.has(line)) continue

      seen.add(line)
      entries.push(JSON.parse(line))
    }

    const counts: Record<Category, number> = {
      "exact": 0, "blank-only": 0, "layout-only": 0, "content-diff": 0, "spike-error": 0,
    }
    const samples: Record<Category, Sample[]> = {
      "exact": [], "blank-only": [], "layout-only": [], "content-diff": [], "spike-error": [],
    }

    let skipped = 0
    let idempotent = 0
    let notIdempotent = 0
    const idempotencySamples: Sample[] = []

    let reparseEqual = 0
    let reparseDiff = 0
    const reparseSamples: Sample[] = []

    let currentReparseDiff = 0

    let currentTotalMs = 0
    let spikeTotalMs = 0

    const SAMPLE_CAP = 60

    for (const entry of entries) {
      const options = {
        indentWidth: entry.indentWidth,
        maxLineLength: entry.maxLineLength,
        preRewriters: [],
        postRewriters: [],
      }

      const probe = Herb.parse(entry.source)

      if (probe.failed || isScaffoldTemplate(probe) || hasFormatterIgnoreDirective(probe.value)) {
        skipped++
        continue
      }

      // Fresh parse per printer: FormatPrinter's herb:disable collector
      // mutates the AST it prints.
      let current: string
      let start = performance.now()

      try {
        current = new FormatPrinter(entry.source, options).print(Herb.parse(entry.source).value)
      } catch (error) {
        skipped++
        continue
      }

      currentTotalMs += performance.now() - start

      let spike: string

      start = performance.now()

      try {
        spike = printWithDocIR(Herb.parse(entry.source).value, { ...options, source: entry.source })
      } catch (error) {
        counts["spike-error"]++

        if (samples["spike-error"].length < SAMPLE_CAP) {
          samples["spike-error"].push({ source: entry.source, error: String(error) })
        }

        continue
      }

      spikeTotalMs += performance.now() - start

      let category: Category

      if (spike === current) {
        category = "exact"
      } else if (stripBlankLines(spike) === stripBlankLines(current)) {
        category = "blank-only"
      } else if (collapseAllWhitespace(spike) === collapseAllWhitespace(current)) {
        category = "layout-only"
      } else {
        category = "content-diff"
      }

      counts[category]++

      if (category !== "exact" && samples[category].length < SAMPLE_CAP) {
        samples[category].push({ source: entry.source, current, spike })
      }

      // Idempotency: formatting the spike output again must be a fixpoint.
      try {
        const second = printWithDocIR(Herb.parse(spike).value, { ...options, source: spike })

        if (second === spike) {
          idempotent++
        } else {
          notIdempotent++

          if (idempotencySamples.length < SAMPLE_CAP) {
            idempotencySamples.push({ source: entry.source, current: spike, spike: second })
          }
        }
      } catch {
        notIdempotent++
      }

      // Reparse equality: spike output parses to the same structure as source.
      const sourceSig = signatureString(entry.source)
      const spikeSig = signatureString(spike)

      if (sourceSig !== null && sourceSig === spikeSig) {
        reparseEqual++
      } else {
        reparseDiff++

        if (reparseSamples.length < SAMPLE_CAP) {
          reparseSamples.push({ source: entry.source, spike })
        }
      }

      // Baseline: does the current formatter's output reparse-equal the source?
      const currentSig = signatureString(current)

      if (sourceSig === null || sourceSig !== currentSig) currentReparseDiff++
    }

    const compared = counts["exact"] + counts["blank-only"] + counts["layout-only"] + counts["content-diff"]

    const report = {
      corpus: entries.length,
      skipped,
      compared,
      counts,
      exactRate: compared > 0 ? counts["exact"] / compared : 0,
      exactOrBlankRate: compared > 0 ? (counts["exact"] + counts["blank-only"]) / compared : 0,
      idempotent,
      notIdempotent,
      reparseEqual,
      reparseDiff,
      currentReparseDiff,
      currentTotalMs: Math.round(currentTotalMs),
      spikeTotalMs: Math.round(spikeTotalMs),
      samples,
      idempotencySamples,
      reparseSamples,
    }

    writeFileSync(reportFile, JSON.stringify(report, null, 2))

    console.log(`corpus=${entries.length} skipped=${skipped} compared=${compared}`)
    console.log(`exact=${counts["exact"]} (${(report.exactRate * 100).toFixed(1)}%)  +blank-only=${counts["blank-only"]} (${(report.exactOrBlankRate * 100).toFixed(1)}%)`)
    console.log(`layout-only=${counts["layout-only"]} content-diff=${counts["content-diff"]} spike-error=${counts["spike-error"]}`)
    console.log(`idempotent=${idempotent}/${idempotent + notIdempotent} reparse-equal=${reparseEqual}/${reparseEqual + reparseDiff} (current formatter reparse-diff baseline: ${currentReparseDiff})`)
    console.log(`time: current=${report.currentTotalMs}ms spike=${report.spikeTotalMs}ms`)
    console.log(`report: ${reportFile}`)
  })
})
