/**
 * Doc-IR corpus quality gate (DOC-IR-DESIGN.md §7.5).
 *
 * Replays a captured corpus (see capture-setup.ts) through the Doc-IR
 * printer and reports idempotency and reparse-equality for every input.
 *
 * The original version of this file also diffed the Doc-IR output against
 * the previous string-emission FormatPrinter; that comparison produced
 * DOC-IR-DIVERGENCES.md and was removed together with the old printer
 * (see git history for the comparison harness).
 *
 * Run:
 *   CORPUS_FILE=... yarn vitest run --config vitest.corpus.config.ts   # capture
 *   RUN_DOC_IR_HARNESS=1 CORPUS_FILE=... REPORT_FILE=... yarn vitest run test/doc-ir/harness/replay-harness.test.ts
 */

import { describe, test, expect, beforeAll } from "vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { Herb } from "@herb-tools/node-wasm"

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
  output?: string
  second?: string
  error?: string
}

const HARNESS_ENABLED = !!process.env.RUN_DOC_IR_HARNESS

/** Structural signature: whitespace-insensitive between nodes, quote- and
 *  ERB-spacing-normalized, so it survives legitimate formatting. */
function signature(node: unknown): unknown {
  if (node === null || node === undefined) return null

  const maybeToken = node as { type?: unknown, value?: unknown }

  if (isToken(node as never) || (typeof maybeToken.type === "string" && maybeToken.type.startsWith("TOKEN_") && typeof maybeToken.value === "string")) {
    return String((node as { value: string }).value).replace(/[ \t\n\r]+/g, " ").trim()
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
    if (key === "location" || key === "errors" || key === "prism_node" || key === "element_source" || key === "range" || key === "source") continue

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

describe.skipIf(!HARNESS_ENABLED)("doc-ir corpus quality gate", () => {
  beforeAll(async () => {
    await Herb.load()
  })

  test("idempotency and reparse-equality over the corpus", { timeout: 600_000 }, () => {
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

    let skipped = 0
    let errors = 0
    let idempotent = 0
    let notIdempotent = 0
    let reparseEqual = 0
    let reparseDiff = 0

    const errorSamples: Sample[] = []
    const idempotencySamples: Sample[] = []
    const reparseSamples: Sample[] = []

    const SAMPLE_CAP = 60

    for (const entry of entries) {
      const options = {
        indentWidth: entry.indentWidth,
        maxLineLength: entry.maxLineLength,
      }

      const probe = Herb.parse(entry.source)

      if (probe.failed || isScaffoldTemplate(probe) || hasFormatterIgnoreDirective(probe.value)) {
        skipped++
        continue
      }

      let output: string

      try {
        output = printWithDocIR(Herb.parse(entry.source).value, { ...options, source: entry.source })
      } catch (error) {
        errors++

        if (errorSamples.length < SAMPLE_CAP) {
          errorSamples.push({ source: entry.source, error: String(error) })
        }

        continue
      }

      try {
        const second = printWithDocIR(Herb.parse(output).value, { ...options, source: output })

        if (second === output) {
          idempotent++
        } else {
          notIdempotent++

          if (idempotencySamples.length < SAMPLE_CAP) {
            idempotencySamples.push({ source: entry.source, output, second })
          }
        }
      } catch (error) {
        notIdempotent++

        if (idempotencySamples.length < SAMPLE_CAP) {
          idempotencySamples.push({ source: entry.source, output, error: String(error) })
        }
      }

      const sourceSig = signatureString(entry.source)
      const outputSig = signatureString(output)

      if (sourceSig !== null && sourceSig === outputSig) {
        reparseEqual++
      } else {
        reparseDiff++

        if (reparseSamples.length < SAMPLE_CAP) {
          reparseSamples.push({ source: entry.source, output })
        }
      }
    }

    const report = {
      corpus: entries.length,
      skipped,
      errors,
      idempotent,
      notIdempotent,
      reparseEqual,
      reparseDiff,
      errorSamples,
      idempotencySamples,
      reparseSamples,
    }

    writeFileSync(reportFile, JSON.stringify(report, null, 2))

    console.log(`corpus=${entries.length} skipped=${skipped} errors=${errors}`)
    console.log(`idempotent=${idempotent}/${idempotent + notIdempotent} reparse-equal=${reparseEqual}/${reparseEqual + reparseDiff}`)
    console.log(`report: ${reportFile}`)

    expect(errors).toBe(0)
    expect(notIdempotent).toBe(0)
  })
})
