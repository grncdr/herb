/**
 * Generic layout engine for the Doc-IR.
 *
 * `printDocToString` chooses the concrete layout for a `Doc` by measuring
 * flat renderings against the maximum line length (`fits`). It knows nothing
 * about HTML or ERB.
 *
 * Semantics ported from Prettier's `document` package (MIT); independent
 * implementation, no dependency.
 */

import type { Doc, FillDoc, GroupDoc } from "./doc.js"
import { fill } from "./doc.js"

export interface LayoutOptions {
  indentWidth: number
  maxLineLength: number
}

const MODE_BREAK = 0
const MODE_FLAT = 1

type Mode = typeof MODE_BREAK | typeof MODE_FLAT

interface Indent {
  value: string
  length: number
}

type Command = [Indent, Mode, Doc]

function rootIndent(): Indent {
  return { value: "", length: 0 }
}

function makeIndent(indent: Indent, options: LayoutOptions): Indent {
  const value = indent.value + " ".repeat(options.indentWidth)

  return { value, length: value.length }
}

/**
 * Mark every group that (transitively) contains a hardline or breakParent as
 * broken, so `fits` and the main loop never even try to flatten it.
 */
export function propagateBreaks(doc: Doc): void {
  const visited = new Set<Doc>()

  function visit(doc: Doc): boolean {
    if (typeof doc === "string") return false

    if (Array.isArray(doc)) {
      let breaks = false

      for (const part of doc) {
        // Deliberately no short-circuit: every subtree must be visited so
        // nested groups get their breakParent flags set.
        if (visit(part)) breaks = true
      }

      return breaks
    }

    if (visited.has(doc)) {
      return doc.type === "breakParent"
        || doc.type === "hardline"
        || doc.type === "literalline"
        || (doc.type === "group" && doc.breakParent === true)
        || false
    }

    visited.add(doc)

    switch (doc.type) {
      case "breakParent":
      case "hardline":
      case "literalline":
        return true
      case "group": {
        const childBreaks = visit(doc.contents)

        if (childBreaks) doc.breakParent = true

        return doc.breakParent === true
      }
      case "indent":
        return visit(doc.contents)
      case "fill": {
        let breaks = false

        for (const part of doc.parts) {
          if (visit(part)) breaks = true
        }

        return breaks
      }
      case "ifBreak":
        // Both branches must be visited, but ifBreak contents only render in
        // an already-decided group; they never force the parent to break.
        visit(doc.breakContents)
        visit(doc.flatContents)
        return false
      case "lineSuffix":
        visit(doc.contents)
        return false
      case "line":
      case "softline":
        return false
    }
  }

  visit(doc)
}

/**
 * Would `next` (rendered flat) fit in `width` columns, considering what
 * follows it (`restCommands`)? Bounded: stops at the first forced newline.
 */
function fits(next: Command, restCommands: Command[], width: number, groupModeMap: Map<symbol, Mode>, mustBeFlat: boolean): boolean {
  let remainingCommandIndex = restCommands.length
  const commands: Command[] = [next]

  while (width >= 0) {
    if (commands.length === 0) {
      if (remainingCommandIndex === 0) return true

      commands.push(restCommands[--remainingCommandIndex])
      continue
    }

    const [indent, mode, doc] = commands.pop()!

    if (typeof doc === "string") {
      width -= doc.length
      continue
    }

    if (Array.isArray(doc)) {
      for (let i = doc.length - 1; i >= 0; i--) commands.push([indent, mode, doc[i]])
      continue
    }

    switch (doc.type) {
      case "indent":
        commands.push([indent, mode, doc.contents])
        break
      case "group": {
        if (mustBeFlat && doc.breakParent) return false

        const groupMode = doc.breakParent ? MODE_BREAK : mode

        commands.push([indent, groupMode, doc.contents])
        break
      }
      case "fill":
        for (let i = doc.parts.length - 1; i >= 0; i--) commands.push([indent, mode, doc.parts[i]])
        break
      case "ifBreak": {
        const groupMode = doc.groupId ? (groupModeMap.get(doc.groupId) ?? MODE_FLAT) : mode

        commands.push([indent, mode, groupMode === MODE_BREAK ? doc.breakContents : doc.flatContents])
        break
      }
      case "line":
        if (mode === MODE_BREAK) return true

        width -= 1
        break
      case "softline":
        if (mode === MODE_BREAK) return true
        break
      case "hardline":
      case "literalline":
        return true
      case "lineSuffix":
      case "breakParent":
        break
    }
  }

  return false
}

/** Remove trailing spaces/tabs (of the current line) from the output buffer. */
function trimOutput(out: string[]): void {
  while (out.length > 0) {
    const last = out[out.length - 1]
    const match = last.match(/[ \t]+$/)

    if (!match) {
      if (last === "") {
        out.pop()
        continue
      }

      return
    }

    if (match[0].length === last.length) {
      out.pop()
      continue
    }

    out[out.length - 1] = last.slice(0, last.length - match[0].length)
    return
  }
}

/**
 * Render a Doc to its final string.
 */
export function printDocToString(doc: Doc, options: LayoutOptions): string {
  propagateBreaks(doc)

  const width = options.maxLineLength
  const groupModeMap = new Map<symbol, Mode>()
  const out: string[] = []
  const lineSuffixes: Command[] = []
  const commands: Command[] = [[rootIndent(), MODE_BREAK, doc]]

  let pos = 0
  let shouldRemeasure = false

  while (true) {
    if (commands.length === 0) {
      if (lineSuffixes.length === 0) break

      for (let i = lineSuffixes.length - 1; i >= 0; i--) commands.push(lineSuffixes[i])
      lineSuffixes.length = 0
    }

    const [indent, mode, current] = commands.pop()!

    if (typeof current === "string") {
      out.push(current)
      pos += current.length
      continue
    }

    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) commands.push([indent, mode, current[i]])
      continue
    }

    switch (current.type) {
      case "indent":
        commands.push([makeIndent(indent, options), mode, current.contents])
        break

      case "group": {
        let groupMode: Mode

        if (mode === MODE_FLAT && !shouldRemeasure) {
          groupMode = current.breakParent ? MODE_BREAK : MODE_FLAT
        } else {
          shouldRemeasure = false

          if (!current.breakParent && fits([indent, MODE_FLAT, current.contents], commands, width - pos, groupModeMap, false)) {
            groupMode = MODE_FLAT
          } else {
            groupMode = MODE_BREAK
          }
        }

        commands.push([indent, groupMode, current.contents])

        if (current.id) groupModeMap.set(current.id, groupMode)

        break
      }

      case "fill": {
        const remaining = width - pos
        const { parts } = current

        if (parts.length === 0) break

        const [content, whitespace] = parts
        const contentFlatCommand: Command = [indent, MODE_FLAT, content]
        const contentBreakCommand: Command = [indent, MODE_BREAK, content]
        const contentFits = fits(contentFlatCommand, [], remaining, groupModeMap, true)

        if (parts.length === 1) {
          commands.push(contentFits ? contentFlatCommand : contentBreakCommand)
          break
        }

        const whitespaceFlatCommand: Command = [indent, MODE_FLAT, whitespace]
        const whitespaceBreakCommand: Command = [indent, MODE_BREAK, whitespace]

        if (parts.length === 2) {
          if (contentFits) {
            commands.push(whitespaceFlatCommand, contentFlatCommand)
          } else {
            commands.push(whitespaceBreakCommand, contentBreakCommand)
          }
          break
        }

        const remainingParts = parts.slice(2)
        const remainingCommand: Command = [indent, mode, fill(remainingParts)]
        const secondContent = parts[2]
        const firstAndSecondCommand: Command = [indent, MODE_FLAT, [content, whitespace, secondContent]]
        const firstAndSecondFit = fits(firstAndSecondCommand, [], remaining, groupModeMap, true)

        if (firstAndSecondFit) {
          commands.push(remainingCommand, whitespaceFlatCommand, contentFlatCommand)
        } else if (contentFits) {
          commands.push(remainingCommand, whitespaceBreakCommand, contentFlatCommand)
        } else {
          commands.push(remainingCommand, whitespaceBreakCommand, contentBreakCommand)
        }

        break
      }

      case "ifBreak": {
        const groupMode = current.groupId ? (groupModeMap.get(current.groupId) ?? MODE_FLAT) : mode
        const contents = groupMode === MODE_BREAK ? current.breakContents : current.flatContents

        commands.push([indent, mode, contents])
        break
      }

      case "lineSuffix":
        lineSuffixes.push([indent, mode, current.contents])
        break

      case "line":
      case "softline":
      case "hardline":
      case "literalline": {
        if (mode === MODE_FLAT && current.type !== "hardline" && current.type !== "literalline") {
          if (current.type === "line") {
            out.push(" ")
            pos += 1
          }
          break
        }

        // A hardline encountered in flat mode means propagateBreaks was
        // bypassed (e.g. inside ifBreak contents); force re-measurement of
        // the next group.
        if (mode === MODE_FLAT) {
          shouldRemeasure = true
        }

        if (lineSuffixes.length > 0) {
          commands.push([indent, mode, current])

          for (let i = lineSuffixes.length - 1; i >= 0; i--) commands.push(lineSuffixes[i])

          lineSuffixes.length = 0
          break
        }

        if (current.type === "literalline") {
          out.push("\n")
          pos = 0
        } else {
          trimOutput(out)
          out.push("\n" + indent.value)
          pos = indent.length
        }

        break
      }

      case "breakParent":
        break
    }
  }

  trimOutput(out)

  return out.join("")
}
