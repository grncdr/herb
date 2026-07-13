/**
 * Whitespace-significance classifier (DOC-IR-DESIGN.md §5).
 *
 * Classifies every inter-node gap in a children list. This is the only code
 * in the Doc-IR pipeline that reads source whitespace; lowering maps gap
 * kinds to Doc separators mechanically and never inspects whitespace itself.
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
 * A gap accumulates: the trailing whitespace of the previous text item,
 * any whitespace-only siblings, and the leading whitespace of the next
 * text item.
 */
export function classifyChildren(children: Node[]): ClassifiedChildren {
  const items: Node[] = []
  const gaps: GapKind[] = []

  let pendingWhitespace = ""

  for (const child of children) {
    if (isWhitespaceOnly(child)) {
      pendingWhitespace += whitespaceOf(child)
      continue
    }

    const gapWhitespace = pendingWhitespace + leadingWhitespace(child)

    gaps.push(classifyWhitespace(gapWhitespace))
    items.push(child)

    pendingWhitespace = trailingWhitespace(child)
  }

  return {
    items,
    gaps,
    trailing: classifyWhitespace(pendingWhitespace),
  }
}
