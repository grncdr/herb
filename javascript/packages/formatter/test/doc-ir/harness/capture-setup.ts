/**
 * Vitest setup file that records every source string flowing through
 * `Formatter.format` during a test run into a JSONL corpus file.
 *
 * Used via vitest.corpus.config.ts:
 *   CORPUS_FILE=/path/corpus.jsonl yarn vitest run --config vitest.corpus.config.ts
 */

import { appendFileSync } from "node:fs"
import { Formatter } from "../../../src/formatter.js"

const corpusFile = process.env.CORPUS_FILE

if (corpusFile) {
  const original = Formatter.prototype.format

  Formatter.prototype.format = function (source: string, options = {}, filePath?: string): string {
    const instanceOptions = (this as unknown as { options: Record<string, unknown> }).options ?? {}
    const resolved = { ...instanceOptions, ...options } as { indentWidth?: number, maxLineLength?: number }

    const entry = {
      source,
      indentWidth: resolved.indentWidth ?? 2,
      maxLineLength: resolved.maxLineLength ?? 80,
    }

    appendFileSync(corpusFile, JSON.stringify(entry) + "\n")

    return original.call(this, source, options, filePath)
  }
}
