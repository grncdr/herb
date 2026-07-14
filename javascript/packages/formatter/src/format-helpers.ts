import { isNode, getTagName, getStaticAttributeValue, getTokenList } from "@herb-tools/core"
import { Node, HTMLTextNode, HTMLElementNode, HTMLOpenTagNode, HTMLCloseTagNode, ERBContentNode } from "@herb-tools/core"

// --- Constants ---

// TODO: we can probably expand this list with more tags/attributes
export const FORMATTABLE_ATTRIBUTES: Record<string, string[]> = {
  '*': ['class'],
  'img': ['srcset', 'sizes']
}

export const INLINE_ELEMENTS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdo', 'big', 'br', 'cite', 'code',
  'dfn', 'em', 'hr', 'i', 'img', 'kbd', 'label', 'map', 'object', 'q',
  'samp', 'small', 'span', 'strong', 'sub', 'sup',
  'tt', 'var', 'del', 'ins', 'mark', 's', 'u', 'time', 'wbr'
])

export const CONTENT_PRESERVING_ELEMENTS = new Set([
  'script', 'style', 'pre', 'textarea'
])

// https://tailwindcss.com/docs/white-space
export const WHITESPACE_PRESERVING_CLASSES = [
  'whitespace-pre-line',
  'whitespace-pre-wrap',
  'whitespace-pre',
  'whitespace-break-spaces',
]

// https://developer.mozilla.org/en-US/docs/Web/CSS/white-space
export const WHITESPACE_PRESERVING_STYLE_VALUES = new Set([
  'pre',
  'pre-line',
  'pre-wrap',
  'break-spaces',
])

// --- Element predicates ---

/**
 * Check if an element should be treated as inline based on its tag name
 */
export function isInlineElement(tagName: string): boolean {
  return INLINE_ELEMENTS.has(tagName.toLowerCase())
}

/**
 * Check if an element is a line-breaking element (br or hr)
 */
export function isLineBreakingElement(node: Node): boolean {
  if (!isNode(node, HTMLElementNode)) {
    return false
  }

  const tagName = getTagName(node)

  return tagName === 'br' || tagName === 'hr'
}

export function hasWhitespacePreservingStyle(element: HTMLElementNode): boolean {
  if (getTokenList(element, "class").some(klass => WHITESPACE_PRESERVING_CLASSES.some(whitespace => klass.includes(whitespace)))) return true

  const styleValue = getStaticAttributeValue(element, "style")
  if (styleValue) {
    const match = styleValue.match(/white-space\s*:\s*([^;!]+)/)

    if (match) {
      const value = match[1].trim().toLowerCase()
      if (WHITESPACE_PRESERVING_STYLE_VALUES.has(value)) return true
    }
  }

  return false
}

export function isContentPreserving(element: HTMLElementNode | HTMLOpenTagNode | HTMLCloseTagNode): boolean {
  const tagName = getTagName(element)
  if (CONTENT_PRESERVING_ELEMENTS.has(tagName)) return true

  if (isNode(element, HTMLElementNode)) {
    return hasWhitespacePreservingStyle(element)
  }

  return false
}

// --- Comment / document predicates ---

/**
 * Check if an ERB content node is a herb:disable comment
 */
export function isHerbDisableComment(node: Node): node is ERBContentNode & { tag_opening: { value: "<%#" } } {
  if (!isNode(node, ERBContentNode)) return false
  if (node.tag_opening?.value !== "<%#") return false

  const content = node?.content?.value || ""
  const trimmed = content.trim()

  return trimmed.startsWith("herb:disable")
}

/**
 * Check if a text node is YAML frontmatter (starts and ends with ---)
 */
export function isFrontmatter(node: Node): node is HTMLTextNode {
  if (!isNode(node, HTMLTextNode)) return false

  const content = node.content.trim()

  return content.startsWith("---") && /---\s*$/.test(content)
}
