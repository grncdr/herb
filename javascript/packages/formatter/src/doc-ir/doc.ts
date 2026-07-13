/**
 * Doc-IR: a layout intermediate representation for the Herb formatter.
 *
 * A `Doc` describes *possible* layouts — where breaks may occur, what
 * indentation applies when they do, which parts must stay atomic. The layout
 * function in `layout.ts` chooses the concrete layout by measuring against
 * `maxLineLength`.
 *
 * Semantics follow Wadler's "A prettier printer" algebra as extended by
 * Prettier's `document` package (independently implemented, no dependency).
 *
 * See DOC-IR-DESIGN.md at the repository root.
 */

export interface GroupDoc {
  type: "group"
  contents: Doc
  /** When true the group always breaks (set by propagateBreaks or lowering). */
  breakParent?: boolean
  id?: symbol
}

export interface IndentDoc {
  type: "indent"
  contents: Doc
}

export interface LineDoc {
  /** Space when flat, newline when broken. */
  type: "line"
}

export interface SoftlineDoc {
  /** Nothing when flat, newline when broken. */
  type: "softline"
}

export interface HardlineDoc {
  /** Always a newline; forces enclosing groups to break. */
  type: "hardline"
}

export interface LiteralLineDoc {
  /** Newline without re-indentation (pre/script content). */
  type: "literalline"
}

export interface FillDoc {
  /**
   * Paragraph filling: parts alternate content and separator
   * ([content, sep, content, sep, content, …]); only the separators that
   * need to break do.
   */
  type: "fill"
  parts: Doc[]
}

export interface IfBreakDoc {
  type: "ifBreak"
  breakContents: Doc
  flatContents: Doc
  groupId?: symbol
}

export interface LineSuffixDoc {
  /** Defer contents to the end of the current output line (trailing comments). */
  type: "lineSuffix"
  contents: Doc
}

export interface BreakParentDoc {
  /** Force the enclosing group to break. */
  type: "breakParent"
}

export type Doc =
  | string
  | Doc[]
  | GroupDoc
  | IndentDoc
  | LineDoc
  | SoftlineDoc
  | HardlineDoc
  | LiteralLineDoc
  | FillDoc
  | IfBreakDoc
  | LineSuffixDoc
  | BreakParentDoc

// --- Builders ---

export function group(contents: Doc, opts: { breakParent?: boolean, id?: symbol } = {}): GroupDoc {
  return { type: "group", contents, ...opts }
}

export function indent(contents: Doc): IndentDoc {
  return { type: "indent", contents }
}

export const line: LineDoc = { type: "line" }
export const softline: SoftlineDoc = { type: "softline" }
export const hardline: HardlineDoc = { type: "hardline" }
export const literalline: LiteralLineDoc = { type: "literalline" }
export const breakParent: BreakParentDoc = { type: "breakParent" }

export function fill(parts: Doc[]): FillDoc {
  return { type: "fill", parts }
}

export function ifBreak(breakContents: Doc, flatContents: Doc, groupId?: symbol): IfBreakDoc {
  return { type: "ifBreak", breakContents, flatContents, groupId }
}

export function lineSuffix(contents: Doc): LineSuffixDoc {
  return { type: "lineSuffix", contents }
}

/** Interleave `separator` between `docs`. */
export function join(separator: Doc, docs: Doc[]): Doc[] {
  const result: Doc[] = []

  docs.forEach((doc, index) => {
    if (index > 0) result.push(separator)
    result.push(doc)
  })

  return result
}

// --- Type guards ---

export function isDocCommand(doc: Doc): doc is Exclude<Doc, string | Doc[]> {
  return typeof doc === "object" && doc !== null && !Array.isArray(doc)
}

/** Split a string containing newlines into literal-line separated parts. */
export function literalText(text: string): Doc {
  if (!text.includes("\n")) return text

  return join(literalline, text.split("\n"))
}
