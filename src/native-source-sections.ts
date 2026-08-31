import {
  asNativeRecord,
  nativeAstStatements,
  nativeFNV1a,
} from './native-common.js'

export type NativeSourceSectionKind =
  | 'header'
  | 'prolog'
  | 'setup'
  | 'resource'
  | 'drawing'
  | 'fallback'
  | 'trailer'
  | 'unknown'

export interface NativeSourceSection {
  id: string
  kind: NativeSourceSectionKind
  startStatement: number
  endStatement: number
  startOffset?: number
  endOffset?: number
  rawHash: string
  markers: readonly string[]
}

export interface NativeSourceSectionMap {
  sections: readonly NativeSourceSection[]
  statementKinds: readonly NativeSourceSectionKind[]
  diagnostics: readonly string[]
}

const VISIBLE_OPERATORS = new Set([
  'm', 'moveto',
  'l', 'L', 'lineto',
  'c', 'C', 'curveto',
  'v', 'y',
  'S', 's', 'stroke',
  'f', 'F', 'fill', 'f*', 'eofill',
  'B', 'B*', 'b', 'b*',
  'BT', 'Tj', 'TJ', 'Tx', 'To',
  'XI', 'XG', 'Xh',
])

function statementRaw(statement: Record<string, unknown>): string {
  return typeof statement.raw === 'string' ? statement.raw : ''
}

function statementOffset(
  statement: Record<string, unknown>,
  side: 'start' | 'end',
): number | undefined {
  const span = asNativeRecord(statement.span)
  const value = span?.[side]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function markerKind(raw: string): NativeSourceSectionKind | undefined {
  if (/%%BeginProlog\b/iu.test(raw)) return 'prolog'
  if (/%%BeginSetup\b/iu.test(raw)) return 'setup'
  if (/%%BeginResource\b|%AI\d*_Begin(?:Gradient|Pattern|Symbol|Brush|Data)/iu.test(raw)) {
    return 'resource'
  }
  if (/%%Trailer\b/iu.test(raw)) return 'trailer'
  if (/%AI\d*_Begin(?:Fallback|PluginObject|ExpandedAppearance)/iu.test(raw)) {
    return 'fallback'
  }
  return undefined
}

function isEndMarker(raw: string, kind: NativeSourceSectionKind): boolean {
  if (kind === 'prolog') return /%%EndProlog\b/iu.test(raw)
  if (kind === 'setup') return /%%EndSetup\b/iu.test(raw)
  if (kind === 'resource') {
    return /%%EndResource\b|%AI\d*_End(?:Gradient|Pattern|Symbol|Brush|Data)/iu.test(raw)
  }
  if (kind === 'fallback') {
    return /%AI\d*_End(?:Fallback|PluginObject|ExpandedAppearance)/iu.test(raw)
  }
  return false
}

function explicitMarker(raw: string): string | undefined {
  return /(?:%%|%AI\d*_)[A-Za-z0-9_:-]+/u.exec(raw)?.[0]
}

export function classifyNativeSourceSections(
  ast: unknown,
): NativeSourceSectionMap {
  const statements = nativeAstStatements(ast)
  const statementKinds: NativeSourceSectionKind[] = []
  const diagnostics: string[] = []
  let current: NativeSourceSectionKind = 'header'
  const stack: NativeSourceSectionKind[] = []
  let drawingStarted = false

  for (const statement of statements) {
    const record = asNativeRecord(statement)
    const raw = record === undefined ? '' : statementRaw(record)
    const begin = markerKind(raw)
    if (begin !== undefined) {
      stack.push(current)
      current = begin
    }
    const operator = typeof record?.operator === 'string'
      ? record.operator
      : undefined
    if (
      !drawingStarted
      && operator !== undefined
      && VISIBLE_OPERATORS.has(operator)
      && current !== 'resource'
      && current !== 'prolog'
      && current !== 'setup'
      && current !== 'fallback'
    ) {
      drawingStarted = true
      current = 'drawing'
    }
    if (/%%Trailer\b|%%EOF\b/iu.test(raw)) current = 'trailer'
    statementKinds.push(current)
    if (isEndMarker(raw, current)) current = stack.pop() ?? (drawingStarted ? 'drawing' : 'header')
  }

  if (stack.length > 0) {
    diagnostics.push(
      `Source section stack ended with ${stack.length} unterminated marker(s).`,
    )
  }

  const sections: NativeSourceSection[] = []
  let start = 0
  while (start < statements.length) {
    const kind = statementKinds[start] ?? 'unknown'
    let end = start + 1
    while (end < statements.length && statementKinds[end] === kind) end++
    const records = statements
      .slice(start, end)
      .map(asNativeRecord)
      .filter((value): value is Record<string, unknown> => value !== undefined)
    const raw = records.map(statementRaw).join('')
    const markers = records
      .map((record) => explicitMarker(statementRaw(record)))
      .filter((value): value is string => value !== undefined)
    const startOffset = records[0] === undefined
      ? undefined
      : statementOffset(records[0], 'start')
    const last = records.at(-1)
    const endOffset = last === undefined
      ? undefined
      : statementOffset(last, 'end')
    sections.push({
      id: `${kind}:${start}:${nativeFNV1a(raw)}`,
      kind,
      startStatement: start,
      endStatement: end,
      ...(startOffset === undefined ? {} : { startOffset }),
      ...(endOffset === undefined ? {} : { endOffset }),
      rawHash: nativeFNV1a(raw),
      markers: [...new Set(markers)],
    })
    start = end
  }

  return { sections, statementKinds, diagnostics }
}
