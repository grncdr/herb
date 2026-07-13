import { defineConfig } from "vitest/config"

/**
 * Corpus-capture run for the Doc-IR spike (see DOC-IR-DESIGN.md §7):
 * runs the full formatter suite with Formatter.format instrumented to
 * record every input into $CORPUS_FILE as JSONL.
 *
 *   CORPUS_FILE=... yarn vitest run --config vitest.corpus.config.ts
 */
export default defineConfig({
  test: {
    setupFiles: ["./test/doc-ir/harness/capture-setup.ts"],
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "test/doc-ir/**", "test/cli/**", "test/cli.test.ts"],
  },
})
