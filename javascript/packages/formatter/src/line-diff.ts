/**
 * Minimal unified line diff (LCS-based) for `herb-format --compare`.
 * No external dependency; output follows the familiar `---`/`+++`/`@@` shape.
 */

interface Hunk {
  aStart: number
  aLines: number
  bStart: number
  bLines: number
  lines: string[]
}

/** Longest-common-subsequence table over lines. */
function lcsMatrix(a: string[], b: string[]): Uint32Array {
  const width = b.length + 1
  const matrix = new Uint32Array((a.length + 1) * width)

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      matrix[i * width + j] = a[i] === b[j]
        ? matrix[(i + 1) * width + j + 1] + 1
        : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1])
    }
  }

  return matrix
}

type Edit = [" " | "-" | "+", string]

function editScript(a: string[], b: string[]): Edit[] {
  const width = b.length + 1
  const matrix = lcsMatrix(a, b)
  const edits: Edit[] = []

  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      edits.push([" ", a[i]])
      i++
      j++
    } else if (matrix[(i + 1) * width + j] >= matrix[i * width + j + 1]) {
      edits.push(["-", a[i]])
      i++
    } else {
      edits.push(["+", b[j]])
      j++
    }
  }

  while (i < a.length) edits.push(["-", a[i++]])
  while (j < b.length) edits.push(["+", b[j++]])

  return edits
}

/**
 * Render a unified diff of two texts. Returns "" when they are identical.
 */
export function unifiedDiff(a: string, b: string, aLabel: string, bLabel: string, context = 3): string {
  if (a === b) return ""

  const edits = editScript(a.split("\n"), b.split("\n"))
  const hunks: Hunk[] = []

  let aLine = 1
  let bLine = 1
  let current: Hunk | null = null
  let trailingContext = 0

  const pending: Edit[] = []

  const flushPendingInto = (hunk: Hunk, keep: number) => {
    const kept = pending.slice(pending.length - keep)

    if (hunk.lines.length === 0) {
      hunk.aStart = aLine - kept.length
      hunk.bStart = bLine - kept.length
    }

    for (const [, text] of kept) {
      hunk.lines.push(" " + text)
      hunk.aLines++
      hunk.bLines++
    }

    pending.length = 0
  }

  for (const edit of edits) {
    const [kind, text] = edit

    if (kind === " ") {
      if (current) {
        if (trailingContext < context) {
          current.lines.push(" " + text)
          current.aLines++
          current.bLines++
          trailingContext++
        } else {
          hunks.push(current)
          current = null
          pending.length = 0
          pending.push(edit)
        }
      } else {
        pending.push(edit)
        if (pending.length > context) pending.shift()
      }

      aLine++
      bLine++
      continue
    }

    if (!current) {
      current = { aStart: aLine, aLines: 0, bStart: bLine, bLines: 0, lines: [] }
      flushPendingInto(current, pending.length)
    }

    trailingContext = 0

    if (kind === "-") {
      current.lines.push("-" + text)
      current.aLines++
      aLine++
    } else {
      current.lines.push("+" + text)
      current.bLines++
      bLine++
    }
  }

  if (current) hunks.push(current)

  const parts = [`--- ${aLabel}`, `+++ ${bLabel}`]

  for (const hunk of hunks) {
    parts.push(`@@ -${hunk.aStart},${hunk.aLines} +${hunk.bStart},${hunk.bLines} @@`)
    parts.push(...hunk.lines)
  }

  return parts.join("\n")
}
