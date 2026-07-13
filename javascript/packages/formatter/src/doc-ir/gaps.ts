/**
 * Whitespace-significance classifier (DOC-IR-DESIGN.md §5).
 *
 * Classifies every inter-node gap in a children list. This is the only code
 * in the Doc-IR pipeline that reads source whitespace; lowering maps gap
 * kinds to Doc separators mechanically and never inspects whitespace itself.
 *
 * Gaps are read from the source text between node locations when a
 * SourceIndex is provided (necessary inside open tags, where the parser
 * drops whitespace nodes entirely), with the whitespace-node/text-edge
 * walk as fallback.
 *
 * Content-preserving contexts (pre/script/style/textarea) never reach the
 * classifier — lowering copies their raw source verbatim.
 */

import { isNode, isPureWhitespaceNode } from "@herb-tools/core"
import { Node, HTMLTextNode, WhitespaceNode } from "@herb-tools/core"

export type GapKind =
  /** No whitespace in source; rendering whitespace here would change output. */
  | "glued"
  /** Whitespace without a newline: collapses to one breakable space. */
  | "space"
  /** Whitespace with a newline: insignificant for rendering; layout may choose. */
  | "line"
  /** Whitespace with a blank line: preserved (capped at one) by policy. */
  | "blank"

export interface SourcePosition {
  /** 1-based */
  line: number
  /** 0-based */
  column: number
}

/** Resolves parser positions (line/column) to offsets into the source. */
export class SourceIndex {
  private lineStarts: number[]

  constructor(private source: string) {
    this.lineStarts = [0]

    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") this.lineStarts.push(i + 1)
    }
  }

  offsetOf(position: SourcePosition): number | null {
    const lineStart = this.lineStarts[position.line - 1]

    if (lineStart === undefined) return null

    return lineStart + position.column
  }

  /** The source text between two positions, or null when it cannot be
   *  resolved or contains non-whitespace (defensive fallback trigger). */
  whitespaceBetween(from: SourcePosition, to: SourcePosition): string | null {
    const start = this.offsetOf(from)
    const end = this.offsetOf(to)

    if (start === null || end === null || start > end) return null

    const text = this.source.slice(start, end)

    if (/[^ \t\n\r]/.test(text)) return null

    return text
  }
}

export interface GapContext {
  index?: SourceIndex
  /** Position right after the parent's opening construct (e.g. after `<%`
   *  tag close or after `<div`): enables classifying the leading gap. */
  openEnd?: SourcePosition
  /** Position of the parent's closing construct: enables the trailing gap. */
  closeStart?: SourcePosition
}

export interface ClassifiedChildren {
  /** Significant children (whitespace-only nodes removed). */
  items: Node[]
  /** gaps[i] is the gap between items[i - 1] and items[i]; gaps[0] is the gap
   *  between the parent's opening boundary and items[0]. */
  gaps: GapKind[]
  /** Gap between the last item and the parent's closing boundary. */
  trailing: GapKind
}

const BLANK_LINE = /\n[ \t\r]*\n/

export function classifyWhitespace(whitespace: string): GapKind {
  if (whitespace === "") return "glued"
  if (BLANK_LINE.test(whitespace)) return "blank"
  if (whitespace.includes("\n")) return "line"

  return "space"
}

function isWhitespaceOnly(node: Node): boolean {
  return isNode(node, WhitespaceNode) || isPureWhitespaceNode(node)
}

function whitespaceOf(node: Node): string {
  if (isNode(node, WhitespaceNode)) return node.value?.value ?? " "
  if (isNode(node, HTMLTextNode)) return node.content

  return ""
}

function leadingWhitespace(node: Node): string {
  if (isNode(node, HTMLTextNode)) return node.content.match(/^[ \t\n\r]+/)?.[0] ?? ""

  return ""
}

function trailingWhitespace(node: Node): string {
  if (isNode(node, HTMLTextNode)) return node.content.match(/[ \t\n\r]+$/)?.[0] ?? ""

  return ""
}

/**
 * Split a children list into significant items and the classified gaps
 * between them (and against the parent's boundaries).
 *
 * A gap accumulates: the source whitespace between the previous item's end
 * and this item's start (or, without a SourceIndex, the whitespace-only
 * siblings), plus the inner text-edge whitespace of text items.
 */
export function classifyChildren(children: Node[], context: GapContext = {}): ClassifiedChildren {
  const items: Node[] = []
  const gaps: GapKind[] = []

  /** Trailing text-edge whitespace inside the previous item's own location. */
  let edge = ""
  /** Whitespace-only siblings since the previous item (fallback path). */
  let accumulated = ""
  let previousEnd: SourcePosition | null = context.openEnd ?? null

  const betweenBySource = (to: SourcePosition | undefined): string | null => {
    if (!context.index || !previousEnd || !to) return null

    return context.index.whitespaceBetween(previousEnd, to)
  }

  for (const child of children) {
    if (isWhitespaceOnly(child)) {
      accumulated += whitespaceOf(child)
      continue
    }

    const slice = betweenBySource(child.location?.start)
    const between = edge + (slice !== null ? slice : accumulated) + leadingWhitespace(child)

    gaps.push(classifyWhitespace(between))
    items.push(child)

    edge = trailingWhitespace(child)
    accumulated = ""
    previousEnd = child.location?.end ?? null
  }

  const slice = betweenBySource(context.closeStart)

  return {
    items,
    gaps,
    trailing: classifyWhitespace(edge + (slice !== null ? slice : accumulated)),
  }
}
