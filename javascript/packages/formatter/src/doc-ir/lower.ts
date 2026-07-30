/**
 * Lowering: Herb AST → Doc (DOC-IR-DESIGN.md §4).
 *
 * All formatting *policy* lives here; all measurement and line-breaking
 * mechanics live in layout.ts. Whitespace significance comes exclusively
 * from the gap classifier (gaps.ts).
 *
 * Decided policies (see design §4 and §9):
 * - Blank lines: never inserted, authored ones preserved capped at one.
 * - Attribute wrapping: purely width-driven; no attribute-count rules.
 * - Control flow / blocks authored on a single source line stay inline when
 *   they fit; authored multiline they stay multiline (their internal gaps
 *   lower to hardlines, which propagate).
 */

import { IdentityPrinter } from "@herb-tools/printer"

import {
  Node,
  DocumentNode,
  LiteralNode,
  HTMLOpenTagNode,
  HTMLConditionalOpenTagNode,
  HTMLCloseTagNode,
  HTMLOmittedCloseTagNode,
  HTMLVirtualCloseTagNode,
  HTMLElementNode,
  HTMLConditionalElementNode,
  HTMLAttributeNode,
  HTMLAttributeValueNode,
  HTMLTextNode,
  HTMLCommentNode,
  HTMLDoctypeNode,
  XMLDeclarationNode,
  CDATANode,
  ERBContentNode,
  ERBOpenTagNode,
  ERBBlockNode,
  ERBEndNode,
  ERBElseNode,
  ERBIfNode,
  ERBUnlessNode,
  ERBWhenNode,
  ERBCaseNode,
  ERBCaseMatchNode,
  ERBWhileNode,
  ERBUntilNode,
  ERBForNode,
  ERBRescueNode,
  ERBEnsureNode,
  ERBBeginNode,
  ERBYieldNode,
  ERBInNode,
  ERBRenderNode,
} from "@herb-tools/core"

import {
  getTagName,
  getCombinedAttributeName,
  isNode,
  isERBCommentNode,
  TOKEN_LIST_ATTRIBUTES,
} from "@herb-tools/core"

import {
  FORMATTABLE_ATTRIBUTES,
  isInlineElement,
  isContentPreserving,
  isFrontmatter,
  isHerbDisableComment,
  isLineBreakingElement,
} from "../format-helpers.js"

import {
  extractHTMLCommentContent,
  formatHTMLCommentInner,
  formatERBCommentLines,
} from "../comment-helpers.js"

import type { Doc } from "./doc.js"
import { group, indent, line, softline, hardline, fill, join, lineSuffix, literalText } from "./doc.js"
import { printDocToString } from "./layout.js"
import { classifyChildren, SourceIndex, GapKind, GapContext, SourcePosition } from "./gaps.js"

export interface LowerOptions {
  indentWidth: number
  maxLineLength: number
  /** Source text; enables exact gap classification where the parser drops
   *  whitespace nodes (open tags, attribute-position control flow). */
  source?: string
}

interface Boundaries {
  openEnd?: SourcePosition
  closeStart?: SourcePosition
}

type ChildMode = "element" | "control-flow" | "attributes"

interface LoweredChildren {
  /** Doc for the children (parts joined with separators); "" when empty. */
  doc: Doc
  /** herb:disable comments that preceded any content — the caller places
   *  these directly after the opening construct so they land on its line. */
  leadingSuffixes: Doc[]
  /** True when there were no significant children. */
  empty: boolean
  /** Gap between the parent's opening boundary and the first item. */
  leadingGap: GapKind
  /** Gap between the last item and the parent's closing boundary. */
  trailingGap: GapKind
  /** True when the children form one single text-flow fill run. */
  singleFillRun: boolean
}

const WORD_SEPARATOR = /[ \t\n\r]+/
const ANY_WHITESPACE = /[ \t\n\r]+/g
const ERB_VALUE = /<%[^%]*%>/

interface LocatedToken {
  value: string
  location?: { start: SourcePosition, end: SourcePosition } | null
}

interface ERBTagLike {
  tag_opening?: LocatedToken | null
  content?: LocatedToken | null
  tag_closing?: LocatedToken | null
}

function tagOpenEnd(node: ERBTagLike | null | undefined): SourcePosition | undefined {
  return node?.tag_closing?.location?.end
}

function tagCloseStart(node: ERBTagLike | null | undefined): SourcePosition | undefined {
  return node?.tag_opening?.location?.start
}

function containsLineSuffix(doc: Doc): boolean {
  if (typeof doc === "string") return false
  if (Array.isArray(doc)) return doc.some(containsLineSuffix)

  switch (doc.type) {
    case "lineSuffix": return true
    case "group":
    case "indent": return containsLineSuffix(doc.contents)
    case "fill": return doc.parts.some(containsLineSuffix)
    case "ifBreak": return containsLineSuffix(doc.breakContents) || containsLineSuffix(doc.flatContents)
    default: return false
  }
}

/**
 * Accumulates alternating fill parts. Content pushed with `glue` joins the
 * previous content part; content pushed with `add` gets a separator.
 */
class FillBuilder {
  private parts: Doc[] = []
  private lastContent: Doc[] | null = null

  get hasContent(): boolean {
    return this.lastContent !== null
  }

  glue(doc: Doc): void {
    if (this.lastContent) {
      this.lastContent.push(doc)
    } else {
      this.lastContent = [doc]
      this.parts.push(this.lastContent)
    }
  }

  add(separator: Doc, doc: Doc): void {
    if (!this.lastContent) {
      this.glue(doc)
      return
    }

    this.lastContent = [doc]
    this.parts.push(separator, this.lastContent)
  }

  toDoc(): Doc {
    if (this.parts.length === 0) return ""
    if (this.parts.length === 1) return this.parts[0]

    return fill(this.parts)
  }
}

export class Lowerer {
  private options: LowerOptions
  private tagNameStack: string[] = []
  private sourceIndex: SourceIndex | undefined

  constructor(options: LowerOptions) {
    this.options = options
    this.sourceIndex = options.source !== undefined ? new SourceIndex(options.source) : undefined
  }

  private gapContext(boundaries: Boundaries = {}): GapContext {
    return { index: this.sourceIndex, ...boundaries }
  }

  private get currentTagName(): string {
    return this.tagNameStack[this.tagNameStack.length - 1] ?? ""
  }

  // --- Entry point ---

  lowerDocument(node: DocumentNode): Doc {
    let children = node.children
    const parts: Doc[] = []
    const first = children[0]

    if (first && isFrontmatter(first)) {
      parts.push(literalText(first.content.trimEnd()))
      children = children.slice(1)

      if (classifyChildren(children, this.gapContext()).items.length > 0) {
        parts.push(hardline, hardline)
      }
    }

    const body = this.lowerChildren(children, "element")

    parts.push(...body.leadingSuffixes, body.doc)

    return parts
  }

  // --- Child sequences ---

  /** ERB tags that render as a single atomic tag (no body of their own). */
  private isERBLeaf(node: Node): boolean {
    if (isNode(node, ERBContentNode)) return !isHerbDisableComment(node)
    if (isNode(node, ERBYieldNode)) return true
    if (isNode(node, ERBRenderNode)) return !node.end_node

    return false
  }

  private isControlFlowItem(node: Node): boolean {
    return isNode(node, ERBIfNode)
      || isNode(node, ERBUnlessNode)
      || isNode(node, ERBBlockNode)
      || isNode(node, ERBCaseNode)
      || isNode(node, ERBCaseMatchNode)
      || isNode(node, ERBWhileNode)
      || isNode(node, ERBUntilNode)
      || isNode(node, ERBForNode)
      || isNode(node, ERBBeginNode)
  }

  private isFlowItem(node: Node): boolean {
    if (this.isERBLeaf(node)) return true
    if (isNode(node, HTMLTextNode)) return true
    if (isNode(node, HTMLElementNode) && isInlineElement(getTagName(node))) return true

    if (this.isSingleSourceLine(node) && this.isControlFlowItem(node)) {
      return true
    }

    return false
  }

  /**
   * Whether `items[index]` takes part in a text-flow run.
   *
   * Beyond `isFlowItem`, control flow that is *glued* to a neighbour always
   * participates, however many lines it spans. Authored line count is not
   * invariant under formatting — a glued one-liner too long to fit breaks
   * internally and comes back multiline on the next pass — so deciding by
   * line count alone puts a newline at a glued boundary on the second pass,
   * which both changes rendering and breaks idempotency. Gluedness is
   * invariant, so it is what the decision hangs on.
   */
  private isFlowItemAt(items: Node[], gaps: GapKind[], trailing: GapKind, index: number): boolean {
    const node = items[index]

    if (this.isFlowItem(node)) return true
    if (!this.isControlFlowItem(node)) return false

    const before = gaps[index]
    const after = index + 1 < gaps.length ? gaps[index + 1] : trailing

    return before === "glued" || after === "glued"
  }

  private isAtomicFlowItemAt(items: Node[], gaps: GapKind[], trailing: GapKind, index: number): boolean {
    return this.isFlowItemAt(items, gaps, trailing, index) && !isNode(items[index], HTMLTextNode)
  }

  private isSingleSourceLine(node: Node): boolean {
    return node.location.start.line === node.location.end.line
  }

  private textWords(node: HTMLTextNode): string[] {
    return node.content.split(WORD_SEPARATOR).filter(word => word !== "")
  }

  /**
   * Lower one item to fill units. Text explodes into words; everything else
   * is a single atomic doc.
   */
  private flowUnits(node: Node): Doc[] {
    if (isNode(node, HTMLTextNode)) return this.textWords(node)

    return [this.lowerNode(node)]
  }

  /**
   * Render a doc flat (no width constraint). Returns null if it still
   * contains newlines (hard breaks) or defers content via lineSuffix —
   * those cannot be baked into an atom.
   */
  private renderFlat(doc: Doc): string | null {
    if (containsLineSuffix(doc)) return null

    const rendered = printDocToString(doc, { indentWidth: this.options.indentWidth, maxLineLength: Number.MAX_SAFE_INTEGER })

    return rendered.includes("\n") ? null : rendered
  }

  /** Add an item's units to the builder; `separator` applies before the first
   *  unit (null = glue). With `atomize`, inline elements render as flat
   *  strings so text-flow atoms never break internally (matching the current
   *  formatter's inline rendering). */
  private addUnitsToBuilder(builder: FillBuilder, node: Node, separator: Doc | null, atomize = false): void {
    let units = this.flowUnits(node)

    if (atomize && isNode(node, HTMLElementNode)) {
      const flat = this.renderFlat(units[0])

      if (flat !== null) units = [flat]
    }

    units.forEach((unit, index) => {
      const sep = index === 0 ? separator : line

      if (sep === null) {
        builder.glue(unit)
      } else {
        builder.add(sep, unit)
      }
    })
  }

  private lowerChildren(children: Node[], mode: ChildMode, boundaries: Boundaries = {}): LoweredChildren {
    const { items, gaps, trailing } = classifyChildren(children, this.gapContext(boundaries))

    const out: Doc[] = []
    const leadingSuffixes: Doc[] = []

    let currentBuilder: FillBuilder | null = null
    let hasParts = false
    let sawNonSuffix = false
    let fillRunCount = 0
    let nonFillParts = 0

    const flushBuilder = () => {
      if (currentBuilder && currentBuilder.hasContent) {
        out.push(currentBuilder.toDoc())
        hasParts = true
      }

      currentBuilder = null
    }

    const startPart = (separator: Doc) => {
      flushBuilder()

      if (hasParts) out.push(separator)

      currentBuilder = new FillBuilder()
    }

    const blockSeparator = (gap: GapKind): Doc => {
      if (mode === "control-flow" || mode === "attributes") {
        switch (gap) {
          // In attribute position, glued source (`id="a"<% if %>`) would
          // render invalid HTML; normalize to a breakable space.
          case "glued": return mode === "attributes" ? line : softline
          case "space": return line
          case "blank": return [hardline, hardline]
          default: return hardline
        }
      }

      // The one insertion exception (design §4): a blank line after a
      // doctype or XML declaration.
      const previousItem = items[index - 1]

      if (previousItem && (isNode(previousItem, HTMLDoctypeNode) || isNode(previousItem, XMLDeclarationNode))) {
        return [hardline, hardline]
      }

      return gap === "blank" ? [hardline, hardline] : hardline
    }

    let index = 0

    while (index < items.length) {
      const item = items[index]
      const gap = gaps[index]

      // herb:disable comments authored on the same line as their anchor
      // become line suffixes there; ones on their own line stay put. A
      // leading comment only has an anchor when the parent has an opening
      // construct (element open tag, control-flow tag) on its line.
      if (isHerbDisableComment(item) && (gap === "glued" || gap === "space") && (sawNonSuffix || boundaries.openEnd)) {
        const suffix = lineSuffix(" " + IdentityPrinter.print(item).trim())

        if (!sawNonSuffix) {
          leadingSuffixes.push(suffix)
        } else if (currentBuilder?.hasContent) {
          currentBuilder.glue(suffix)
        } else {
          out.push(suffix)
        }

        index++
        continue
      }

      sawNonSuffix = true

      // Text-flow runs (element mode): consecutive flow items connected by
      // non-blank gaps, containing both text and something atomic.
      if (mode === "element" && this.isFlowItemAt(items, gaps, trailing, index)) {
        let end = index + 1

        while (end < items.length && this.isFlowItemAt(items, gaps, trailing, end) && gaps[end] !== "blank" && !isHerbDisableComment(items[end])) {
          end++
        }

        const run = items.slice(index, end)
        const hasText = run.some(node => isNode(node, HTMLTextNode) && this.textWords(node).length > 0)
        const hasAtomic = run.some((_, offset) => this.isAtomicFlowItemAt(items, gaps, trailing, index + offset))

        if (run.length >= 2 && hasText && hasAtomic) {
          startPart(blockSeparator(gap))

          let afterFlowBreak = false

          for (let runIndex = index; runIndex < end; runIndex++) {
            const runGap = gaps[runIndex]

            // A non-glued <br>/<hr> also starts fresh: it sits at the start
            // of a line when the flow is broken (glued ones like `,<br>`
            // stay attached — that's #469).
            if (isLineBreakingElement(items[runIndex]) && runIndex > index && !afterFlowBreak && runGap !== "glued") {
              flushBuilder()
              out.push(line)
              currentBuilder = new FillBuilder()
              afterFlowBreak = true
            }

            const separator = runIndex === index || afterFlowBreak || runGap === "glued" ? null : line

            this.addUnitsToBuilder(currentBuilder!, items[runIndex], separator, true)
            afterFlowBreak = false

            // A <br>/<hr> ends the visual line: split the fill here and join
            // with a group-mode separator, so broken paragraphs break after
            // it while inline-fitting ones keep the authored spacing.
            if (isLineBreakingElement(items[runIndex]) && runIndex + 1 < end) {
              flushBuilder()
              out.push(gaps[runIndex + 1] === "glued" ? softline : line)
              currentBuilder = new FillBuilder()
              afterFlowBreak = true
            }
          }

          fillRunCount++
          index = end
          continue
        }
      }

      // Merge rules: same-source-line content that must stay on the previous
      // part's output line.
      const previous = index > 0 ? items[index - 1] : null
      let merge: Doc | null = null

      if (previous && currentBuilder?.hasContent) {
        if (mode === "control-flow" || mode === "attributes") {
          if (gap === "glued" && (isNode(item, HTMLTextNode) || this.isERBLeaf(item) || (isNode(item, HTMLElementNode) && isInlineElement(getTagName(item))))) {
            merge = ""
          }
        } else {
          const previousIsInlineAtom = this.isERBLeaf(previous) || (isNode(previous, HTMLElementNode) && isInlineElement(getTagName(previous)))

          if (this.isERBLeaf(item) && (gap === "glued" || gap === "space")) {
            merge = gap === "space" ? " " : ""
          } else if (gap === "glued" && previousIsInlineAtom && (isNode(item, HTMLTextNode) || (isNode(item, HTMLElementNode) && isInlineElement(getTagName(item))))) {
            merge = ""
          }
        }
      }

      if (merge !== null) {
        if (merge !== "") currentBuilder!.glue(merge)

        this.addUnitsToBuilder(currentBuilder!, item, null, true)
        index++
        continue
      }

      startPart(blockSeparator(gap))
      this.addUnitsToBuilder(currentBuilder!, item, null)
      nonFillParts++
      index++
    }

    flushBuilder()

    return {
      doc: out.length === 1 ? out[0] : out,
      leadingSuffixes,
      empty: !hasParts,
      leadingGap: gaps[0] ?? trailing,
      trailingGap: trailing,
      singleFillRun: fillRunCount === 1 && nonFillParts === 0,
    }
  }

  // --- Node dispatch ---

  lowerNode(node: Node): Doc {
    if (isNode(node, HTMLElementNode)) return this.lowerElement(node)
    if (isNode(node, HTMLTextNode)) return this.lowerText(node)
    if (isNode(node, HTMLOpenTagNode)) return this.lowerOpenTag(node)
    if (isNode(node, HTMLCloseTagNode)) return literalText(IdentityPrinter.print(node))
    if (isNode(node, HTMLOmittedCloseTagNode) || isNode(node, HTMLVirtualCloseTagNode)) return ""
    if (isNode(node, HTMLAttributeNode)) return this.lowerAttribute(node, this.currentTagName)
    if (isNode(node, HTMLCommentNode)) return this.lowerHTMLComment(node)
    if (isNode(node, HTMLDoctypeNode)) return literalText(IdentityPrinter.print(node))
    if (isNode(node, XMLDeclarationNode)) return literalText(IdentityPrinter.print(node))
    if (isNode(node, CDATANode)) return literalText(IdentityPrinter.print(node))
    if (isNode(node, HTMLConditionalElementNode)) return this.lowerConditionalElement(node)
    if (isNode(node, HTMLConditionalOpenTagNode)) return node.conditional ? this.lowerNode(node.conditional) : ""
    if (isNode(node, ERBContentNode)) return isERBCommentNode(node) ? this.lowerERBComment(node) : this.erbTagDoc(node)
    if (isNode(node, ERBOpenTagNode)) return this.erbTagDoc(node)
    if (isNode(node, ERBEndNode)) return this.erbTagDoc(node)
    if (isNode(node, ERBYieldNode)) return this.erbTagDoc(node)
    if (isNode(node, ERBIfNode)) return this.lowerIf(node)
    if (isNode(node, ERBUnlessNode)) return this.lowerUnless(node)
    if (isNode(node, ERBBlockNode)) return this.lowerBlock(node)
    if (isNode(node, ERBRenderNode)) return this.lowerRender(node)
    if (isNode(node, ERBCaseNode) || isNode(node, ERBCaseMatchNode)) return this.lowerCase(node)
    if (isNode(node, ERBWhileNode) || isNode(node, ERBUntilNode) || isNode(node, ERBForNode)) return this.lowerLoop(node)
    if (isNode(node, ERBBeginNode)) return this.lowerBegin(node)
    if (isNode(node, ERBInNode)) return this.lowerClause(node, node.statements)
    if (isNode(node, ERBWhenNode)) return this.lowerClause(node, node.statements)

    return literalText(IdentityPrinter.print(node))
  }

  private lowerText(node: HTMLTextNode): Doc {
    const words = this.textWords(node)

    if (words.length === 0) return ""
    if (words.length === 1) return words[0]

    return fill(join(line, words))
  }

  // --- ERB tags ---

  private erbTagString(node: ERBTagLike, withFormatting = true): string {
    const open = node.tag_opening?.value ?? ""
    const close = node.tag_closing?.value ?? ""
    const content = node.content?.value ?? ""

    if (!withFormatting) return open + content + close

    const trimmed = content.trim()

    // An empty tag keeps one inner space: `<%%>` would parse as the ERB
    // literal-escape `<%%` (and is not a formatting fixpoint).
    if (!trimmed) return open + " " + close

    // See https://github.com/marcoroth/herb/issues/476 — heredocs keep the
    // closing tag on its own line.
    const suffix = trimmed.startsWith("<<") ? "\n" : " "

    return open + ` ${trimmed}${suffix}` + close
  }

  private erbTagDoc(node: ERBTagLike): Doc {
    return literalText(this.erbTagString(node))
  }

  private lowerERBComment(node: ERBContentNode): Doc {
    const content = node?.content?.value || ""

    if (!content.trim()) {
      return (node.tag_opening?.value || "<%#") + " " + (node.tag_closing?.value || "%>")
    }

    const result = formatERBCommentLines(
      node.tag_opening?.value || "<%#",
      content,
      node.tag_closing?.value || "%>",
    )

    if (result.type === "single-line") return result.text

    return [
      result.header,
      indent([hardline, join(hardline, result.contentLines)]),
      hardline,
      result.footer,
    ]
  }

  // --- Control flow ---

  /**
   * Map a boundary gap of an ERB body to a separator.
   *
   * A glued boundary lowers to plain concatenation, never `softline`: the
   * body's content is inline in the surrounding flow, so a newline there
   * would render as whitespace the source did not have (`…overflows<% end
   * %>!` must not become `…overflows\n<% end %>!`). In attribute position a
   * glued boundary instead needs a space, since the alternative is invalid
   * HTML.
   */
  private mapBoundaryGap(gap: GapKind, attributes = false): Doc {
    switch (gap) {
      case "glued": return attributes ? line : ""
      case "space": return line
      default: return hardline
    }
  }

  /**
   * A control-flow segment: opening tag, indented statements, positioned so
   * subsequent clause tags (elsif/else/end) sit at the tag's own level.
   * Attribute-position segments normalize glued boundaries to spaces —
   * glued source would render invalid HTML around the attribute.
   */
  private controlFlowSegment(tag: Doc, statements: Node[], boundaries: Boundaries = {}): { parts: Doc[], trailingSeparator: Doc } {
    const attributes = statements.some(child => isNode(child, HTMLAttributeNode))
    const body = this.lowerChildren(statements, attributes ? "attributes" : "control-flow", boundaries)

    if (body.empty) {
      return { parts: [tag, ...body.leadingSuffixes], trailingSeparator: this.mapBoundaryGap(body.trailingGap, attributes) }
    }

    return {
      parts: [tag, ...body.leadingSuffixes, indent([this.mapBoundaryGap(body.leadingGap, attributes), body.doc])],
      trailingSeparator: this.mapBoundaryGap(body.trailingGap, attributes),
    }
  }

  private lowerIf(node: ERBIfNode): Doc {
    const parts: Doc[] = []

    let current: ERBIfNode | ERBElseNode | null = node

    while (current) {
      const next: ERBIfNode | ERBElseNode | null = isNode(current, ERBIfNode) ? current.subsequent : null
      const segment = this.controlFlowSegment(this.erbTagDoc(current), current.statements, {
        openEnd: tagOpenEnd(current),
        closeStart: tagCloseStart(next ?? node.end_node),
      })

      parts.push(...segment.parts, segment.trailingSeparator)

      current = next
    }

    if (node.end_node) parts.push(this.erbTagDoc(node.end_node))

    return group(parts)
  }

  private lowerUnless(node: ERBUnlessNode): Doc {
    const parts: Doc[] = []
    const segment = this.controlFlowSegment(this.erbTagDoc(node), node.statements, {
      openEnd: tagOpenEnd(node),
      closeStart: tagCloseStart(node.else_clause ?? node.end_node),
    })

    parts.push(...segment.parts, segment.trailingSeparator)

    if (node.else_clause) {
      const elseSegment = this.controlFlowSegment(this.erbTagDoc(node.else_clause), node.else_clause.statements, {
        openEnd: tagOpenEnd(node.else_clause),
        closeStart: tagCloseStart(node.end_node),
      })

      parts.push(...elseSegment.parts, elseSegment.trailingSeparator)
    }

    if (node.end_node) parts.push(this.erbTagDoc(node.end_node))

    return group(parts)
  }

  private lowerBlock(node: ERBBlockNode | ERBRenderNode): Doc {
    const parts: Doc[] = []
    const body = this.lowerChildren(node.body, "element", {
      openEnd: tagOpenEnd(node),
      closeStart: tagCloseStart(node.rescue_clause ?? node.else_clause ?? node.ensure_clause ?? node.end_node),
    })

    parts.push(this.erbTagDoc(node), ...body.leadingSuffixes)

    if (!body.empty) {
      parts.push(indent([this.mapBoundaryGap(body.leadingGap), body.doc]))
    }

    parts.push(this.mapBoundaryGap(body.trailingGap))

    const clauses = [node.rescue_clause, node.else_clause, node.ensure_clause].filter(Boolean) as (ERBRescueNode | ERBElseNode | ERBEnsureNode)[]

    clauses.forEach((clause, index) => {
      const nextTag = (clauses[index + 1] ?? node.end_node) as ERBTagLike | null
      const chain = this.lowerClauseChain(clause, nextTag)

      parts.push(chain.parts, chain.trailingSeparator)
    })

    if (node.end_node) parts.push(this.erbTagDoc(node.end_node))

    return group(parts)
  }

  private lowerRender(node: ERBRenderNode): Doc {
    if (!node.end_node) return this.erbTagDoc(node)

    return this.lowerBlock(node)
  }

  /** rescue chains: each clause tag at parent level with indented statements. */
  /**
   * Lower a rescue/else/ensure chain. `nextTag` is whatever follows the chain
   * (the next clause or `<% end %>`), so the separator before it comes from
   * the source gap rather than being forced to a newline.
   */
  private lowerClauseChain(clause: ERBRescueNode | ERBElseNode | ERBEnsureNode, nextTag: ERBTagLike | null): { parts: Doc[], trailingSeparator: Doc } {
    const parts: Doc[] = []

    let current: Node | null = clause
    let trailingSeparator: Doc = hardline

    while (current) {
      const statements: Node[] = (current as ERBRescueNode).statements ?? []
      const next: Node | null = isNode(current, ERBRescueNode) ? current.subsequent : null
      const segment = this.controlFlowSegment(this.erbTagDoc(current as unknown as ERBTagLike), statements, {
        openEnd: tagOpenEnd(current as unknown as ERBTagLike),
        closeStart: tagCloseStart((next as unknown as ERBTagLike) ?? nextTag),
      })

      parts.push(...segment.parts)
      trailingSeparator = segment.trailingSeparator

      if (next) parts.push(segment.trailingSeparator)

      current = next
    }

    return { parts, trailingSeparator }
  }

  private lowerClause(node: ERBWhenNode | ERBInNode, statements: Node[]): Doc {
    const segment = this.controlFlowSegment(this.erbTagDoc(node), statements, { openEnd: tagOpenEnd(node) })

    return segment.parts
  }

  private lowerCase(node: ERBCaseNode | ERBCaseMatchNode): Doc {
    const parts: Doc[] = [this.erbTagDoc(node)]

    const clauses: { tag: ERBTagLike, statements: Node[] }[] = []

    for (const condition of node.conditions) {
      const clause = condition as unknown as { statements?: Node[] } & ERBTagLike

      clauses.push({ tag: clause, statements: clause.statements ?? [] })
    }

    if (node.else_clause) {
      clauses.push({ tag: node.else_clause, statements: node.else_clause.statements })
    }

    const firstBoundary = (clauses[0]?.tag ?? node.end_node) as ERBTagLike | null
    const lead = this.lowerChildren(node.children, "control-flow", {
      openEnd: tagOpenEnd(node),
      closeStart: tagCloseStart(firstBoundary),
    })

    if (!lead.empty) {
      parts.push(...lead.leadingSuffixes, indent([this.mapBoundaryGap(lead.leadingGap), lead.doc]))
    }

    parts.push(this.mapBoundaryGap(lead.trailingGap))

    clauses.forEach((clause, index) => {
      const next = (clauses[index + 1]?.tag ?? node.end_node) as ERBTagLike | null
      const segment = this.controlFlowSegment(this.erbTagDoc(clause.tag), clause.statements, {
        openEnd: tagOpenEnd(clause.tag),
        closeStart: tagCloseStart(next),
      })

      parts.push(...segment.parts, segment.trailingSeparator)
    })

    if (node.end_node) parts.push(this.erbTagDoc(node.end_node))

    return group(parts)
  }

  private lowerLoop(node: ERBWhileNode | ERBUntilNode | ERBForNode): Doc {
    const parts: Doc[] = []
    const segment = this.controlFlowSegment(this.erbTagDoc(node), node.statements, {
      openEnd: tagOpenEnd(node),
      closeStart: tagCloseStart(node.end_node),
    })

    parts.push(...segment.parts, segment.trailingSeparator)

    if (node.end_node) parts.push(this.erbTagDoc(node.end_node))

    return group(parts)
  }

  private lowerBegin(node: ERBBeginNode): Doc {
    const parts: Doc[] = []
    const segment = this.controlFlowSegment(this.erbTagDoc(node), node.statements, {
      openEnd: tagOpenEnd(node),
      closeStart: tagCloseStart(node.rescue_clause ?? node.else_clause ?? node.ensure_clause ?? node.end_node),
    })

    parts.push(...segment.parts, segment.trailingSeparator)

    const clauses = [node.rescue_clause, node.else_clause, node.ensure_clause].filter(Boolean) as (ERBRescueNode | ERBElseNode | ERBEnsureNode)[]

    clauses.forEach((clause, index) => {
      const nextTag = (clauses[index + 1] ?? node.end_node) as ERBTagLike | null
      const chain = this.lowerClauseChain(clause, nextTag)

      parts.push(chain.parts, chain.trailingSeparator)
    })

    if (node.end_node) parts.push(this.erbTagDoc(node.end_node))

    return group(parts)
  }

  // --- Elements ---

  private lowerElement(node: HTMLElementNode): Doc {
    const tagName = getTagName(node)

    this.tagNameStack.push(tagName)

    try {
      const openDoc = node.open_tag ? this.lowerNode(node.open_tag) : ""
      const closeDoc = node.close_tag ? this.lowerNode(node.close_tag) : ""

      if (node.is_void && !node.close_tag) return openDoc

      if (isContentPreserving(node)) {
        // Keep the open tag flat when it fits on its own (breaking next to
        // preserved content is fragile); a genuinely over-long tag still
        // wraps, like the current formatter's script/style tags.
        const flatOpen = this.renderFlat(openDoc)
        const open = flatOpen !== null && flatOpen.length <= this.options.maxLineLength ? flatOpen : openDoc

        return [open, this.lowerPreservedBody(node.body), closeDoc]
      }

      const body = this.lowerChildren(node.body, "element", {
        openEnd: node.open_tag?.location?.end,
        closeStart: node.close_tag?.location?.start,
      })

      if (body.empty) {
        return [openDoc, ...body.leadingSuffixes, closeDoc]
      }

      const inline = isInlineElement(tagName)

      const boundary = (gap: GapKind): Doc => {
        if (!inline) return softline

        // Whitespace-sensitive: a glued boundary of an inline element must
        // never break — a newline there would add rendered whitespace. An
        // over-long line is the lesser evil (same trade-off as the current
        // formatter's inline rendering).
        return gap === "glued" ? "" : line
      }

      const authoredMultiline = node.open_tag && node.close_tag
        ? node.open_tag.location.end.line !== node.close_tag.location.start.line
        : !this.isSingleSourceLine(node)

      // Block-level child elements always put the parent body on its own
      // lines (matching the current formatter's element layout).
      const hasBlockChild = classifyChildren(node.body, this.gapContext()).items
        .some(child => isNode(child, HTMLElementNode) && !isInlineElement(getTagName(child)))

      const collapseEligible = body.singleFillRun && (body.leadingGap === "glued" || body.leadingGap === "space")
      const forceBreak = (!inline && authoredMultiline && !collapseEligible) || hasBlockChild

      return group([
        openDoc,
        ...body.leadingSuffixes,
        indent([boundary(body.leadingGap), body.doc]),
        boundary(body.trailingGap),
        closeDoc,
      ], { breakParent: forceBreak })
    } finally {
      this.tagNameStack.pop()
    }
  }

  private lowerPreservedBody(body: Node[]): Doc {
    const raw = body.map(child => {
      if (isNode(child, HTMLElementNode)) {
        // Match the current formatter: nested elements inside pre/script/…
        // are re-printed (quote normalization etc.), text is verbatim.
        const doc = this.lowerElement(child)

        return printDocToString(doc, { indentWidth: this.options.indentWidth, maxLineLength: Number.MAX_SAFE_INTEGER })
      }

      return IdentityPrinter.print(child)
    }).join("")

    return literalText(raw)
  }

  private lowerConditionalElement(node: HTMLConditionalElementNode): Doc {
    const parts: Doc[] = []

    if (node.open_conditional) parts.push(this.lowerNode(node.open_conditional))

    const body = this.lowerChildren(node.body, "element", {
      openEnd: node.open_tag?.location?.end,
      closeStart: node.close_tag?.location?.start,
    })

    if (!body.empty) {
      parts.push(indent([hardline, hardline, body.doc]), hardline, hardline)
    } else {
      parts.push(hardline)
    }

    if (node.close_conditional) parts.push(this.lowerNode(node.close_conditional))

    return group(parts, { breakParent: true })
  }

  // --- Open tags and attributes ---

  private lowerOpenTag(node: HTMLOpenTagNode): Doc {
    const tagName = getTagName(node)
    const selfClosing = node.tag_closing?.value === "/>"
    const significant = classifyChildren(node.children, this.gapContext()).items

    if (significant.length === 0) {
      return `<${tagName}${selfClosing ? " />" : ">"}`
    }

    const parts: Doc[][] = []
    const leadingSuffixes: Doc[] = []

    for (const child of significant) {
      // herb:disable comments in the open tag stay on the line of what they
      // annotate (the preceding attribute, or the tag itself), so the
      // directive keeps applying to that output line when the tag breaks.
      if (isHerbDisableComment(child)) {
        const suffix = lineSuffix(" " + IdentityPrinter.print(child).trim())

        if (parts.length === 0) {
          leadingSuffixes.push(suffix)
        } else {
          parts[parts.length - 1].push(suffix)
        }

        continue
      }

      if (isNode(child, HTMLAttributeNode)) {
        parts.push([this.lowerAttribute(child, tagName)])
      } else {
        parts.push([this.lowerNode(child)])
      }
    }

    if (parts.length === 0) {
      return [`<${tagName}`, ...leadingSuffixes, selfClosing ? " />" : ">"]
    }

    return group([
      `<${tagName}`,
      ...leadingSuffixes,
      indent([line, join(line, parts)]),
      selfClosing ? [line, "/>"] : [softline, ">"],
    ])
  }

  private lowerAttribute(attr: HTMLAttributeNode, tagName: string): Doc {
    const name = attr.name ? getCombinedAttributeName(attr.name) : ""
    const equals = attr.equals?.value ?? ""

    if (!isNode(attr.value, HTMLAttributeValueNode)) {
      return name + equals
    }

    const valueNode = attr.value
    const isTokenList = TOKEN_LIST_ATTRIBUTES.has(name)

    let openQuote = valueNode.open_quote?.value ?? ""
    let closeQuote = valueNode.close_quote?.value ?? ""
    let htmlText = ""

    const content = valueNode.children.map((child: Node) => {
      if (isNode(child, HTMLTextNode) || isNode(child, LiteralNode)) {
        htmlText += child.content

        return child.content
      }

      if (isNode(child, ERBContentNode)) {
        return this.erbTagString(child)
      }

      const printed = IdentityPrinter.print(child)

      if (isTokenList) {
        return printed.replace(/%>([^<\s])/g, "%> $1").replace(/([^>\s])<%/g, "$1 <%")
      }

      return printed
    }).join("")

    if (openQuote === "" && closeQuote === "") {
      openQuote = '"'
      closeQuote = '"'
    } else if (openQuote === "'" && closeQuote === "'" && !htmlText.includes('"')) {
      openQuote = '"'
      closeQuote = '"'
    }

    const globalFormattable = FORMATTABLE_ATTRIBUTES["*"] ?? []
    const tagFormattable = FORMATTABLE_ATTRIBUTES[tagName.toLowerCase()] ?? []
    const formattable = globalFormattable.includes(name) || tagFormattable.includes(name)

    if (formattable) {
      const normalized = content.replace(ANY_WHITESPACE, " ").trim()

      if (name === "class" && !ERB_VALUE.test(normalized)) {
        // A long class value authored across several lines keeps its
        // authored line structure (matches the current formatter).
        if (/\r?\n/.test(content) && normalized.length > 80) {
          const lines = content.split(/\r?\n/).map(valueLine => valueLine.trim()).filter(Boolean)

          if (lines.length > 1) {
            return [name, equals, group([openQuote, indent([hardline, join(hardline, lines)]), hardline, closeQuote])]
          }
        }

        const tokens = normalized.split(" ").filter(Boolean)

        if (tokens.length > 1) {
          return [name, equals, group([openQuote, indent([softline, fill(join(line, tokens))]), softline, closeQuote])]
        }
      }

      return [name, equals, openQuote, normalized, closeQuote]
    }

    return [name, equals, openQuote, literalText(content), closeQuote]
  }

  // --- Comments ---

  private lowerHTMLComment(node: HTMLCommentNode): Doc {
    const open = node.comment_start?.value ?? ""
    const close = node.comment_end?.value ?? ""
    const rawInner = node.children && node.children.length > 0
      ? extractHTMLCommentContent(node.children)
      : ""
    const inner = rawInner ? formatHTMLCommentInner(rawInner, this.options.indentWidth) : ""

    return literalText(open + inner + close)
  }
}

/**
 * Spike entry point: format a parsed document with the Doc-IR pipeline.
 * Pass the original source in `options.source` for exact gap classification.
 */
export function printWithDocIR(node: DocumentNode, options: LowerOptions): string {
  const lowerer = new Lowerer(options)
  const doc = lowerer.lowerDocument(node)

  return printDocToString(doc, { indentWidth: options.indentWidth, maxLineLength: options.maxLineLength })
}
