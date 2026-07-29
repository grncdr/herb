import type { ASTRewriter, StringRewriter } from "@herb-tools/rewriter"

/**
 * The printing engine used to render the formatted output.
 *
 * - `"classic"`: the current string-emission printer (default).
 * - `"doc-ir"`: the experimental Doc-IR pipeline (see DOC-IR-DESIGN.md).
 */
export type PrinterChoice = "classic" | "doc-ir"

/**
 * Formatting options for the Herb formatter.
 *
 * indentWidth: number of spaces per indentation level.
 * maxLineLength: maximum line length before wrapping text or attributes.
 * printer: printing engine ("classic" or "doc-ir").
 * preRewriters: AST rewriters to run before formatting.
 * postRewriters: String rewriters to run after formatting.
 */
export interface FormatOptions {
  /** number of spaces per indentation level; defaults to 2 */
  indentWidth?: number
  /** maximum line length before wrapping; defaults to 80 */
  maxLineLength?: number
  /** printing engine; defaults to "classic" */
  printer?: PrinterChoice
  /** Pre-format rewriters (transform AST before formatting); defaults to [] */
  preRewriters?: ASTRewriter[]
  /** Post-format rewriters (transform string after formatting); defaults to [] */
  postRewriters?: StringRewriter[]
}

/**
 * Default values for formatting options.
 */
export const defaultFormatOptions: Required<FormatOptions> = {
  indentWidth: 2,
  maxLineLength: 80,
  printer: "classic",
  preRewriters: [],
  postRewriters: [],
}

/**
 * Merge provided options with defaults for any missing values.
 * @param options partial formatting options
 * @returns a complete set of formatting options
 */
export function resolveFormatOptions(
  options: FormatOptions = {},
): Required<FormatOptions> {
  return {
    indentWidth: options.indentWidth ?? defaultFormatOptions.indentWidth,
    maxLineLength: options.maxLineLength ?? defaultFormatOptions.maxLineLength,
    printer: options.printer ?? defaultFormatOptions.printer,
    preRewriters: options.preRewriters ?? defaultFormatOptions.preRewriters,
    postRewriters: options.postRewriters ?? defaultFormatOptions.postRewriters,
  }
}
