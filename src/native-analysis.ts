import {
  asNativeRecord,
  latin1SourceText,
  nativeAstStatements,
  nativeBoolean,
  nativeBoundsFrom,
  nativeFNV1a,
  nativeNumber,
  nativeString,
  stableNativeSerialize,
  walkNativeScene,
  type NativeBounds,
  type NativeFidelity,
} from './native-foundation.js'

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`

function decodePostScriptString(value: string): string {
  return value.replace(
    /\\(\r\n|\r|\n|[0-7]{1,3}|.)/gsu,
    (_match, escape: string) => {
      if (/^[0-7]+$/u.test(escape)) {
        return String.fromCharCode(Number.parseInt(escape, 8))
      }
      if (escape === 'n') return '\n'
      if (escape === 'r') return '\r'
      if (escape === 't') return '\t'
      if (escape === 'b') return '\b'
      if (escape === 'f') return '\f'
      if (
        escape === '\n'
        || escape === '\r'
        || escape === '\r\n'
      ) return ''
      return escape
    },
  )
}

export interface NativeArtboard extends NativeBounds {
  id: string
  name: string
  uuid?: string
  selected?: boolean
  locked?: boolean
  pixelAspectRatio?: number
  rulerOrigin?: Readonly<{ x: number; y: number }>
  bleed?: Readonly<{
    top: number
    right: number
    bottom: number
    left: number
  }>
  rawProperties: Readonly<Record<string, string | number | boolean>>
  source: 'scene' | 'private-source' | 'bounding-box'
}

function pointProperty(
  block: string,
  name: string,
): Readonly<{ x: number; y: number }> | undefined {
  const patterns = [
    new RegExp(
      `(${NUMBER})\\s+(${NUMBER})\\s+/RealPointRelToROrigin(?:\\s+%_?)?\\s*\\(${name}\\)`,
      'u',
    ),
    new RegExp(
      `(${NUMBER})\\s+(${NUMBER})\\s+/RealPoint(?:\\s+%_?)?\\s*\\(${name}\\)`,
      'u',
    ),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(block)
    if (match !== null) {
      return {
        x: Number(match[1]),
        y: Number(match[2]),
      }
    }
  }
  return undefined
}

function artboardRawProperties(
  block: string,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  const numeric = new RegExp(
    `%_?\\s*(${NUMBER})\\s+/(Real|Int|Bool)\\s+\\(([^)]*)\\)`,
    'gu',
  )
  for (const match of block.matchAll(numeric)) {
    const key = match[3]
    if (key === undefined) continue
    const value = Number(match[1])
    result[key] = match[2] === 'Bool' ? value !== 0 : value
  }
  for (const match of block.matchAll(
    /%_?\s*\(((?:\\.|[^\\)])*)\)\s+\/(?:UnicodeString|String)\s+\(([^)]*)\)/gu,
  )) {
    const key = match[2]
    if (key !== undefined) {
      result[key] = decodePostScriptString(match[1] ?? '')
    }
  }
  return result
}

function sourceBleed(
  source: string,
): NativeArtboard['bleed'] | undefined {
  const side = (name: string): number | undefined => {
    const match = new RegExp(
      `(${NUMBER})\\s+/Real\\s+\\(Bleed${name}Value\\)`,
      'u',
    ).exec(source)
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
  const top = side('Top')
  const right = side('Right')
  const bottom = side('Bottom')
  const left = side('Left')
  if (
    top === undefined
    || right === undefined
    || bottom === undefined
    || left === undefined
  ) return undefined
  return { top, right, bottom, left }
}

function artboardsFromSource(source: string): NativeArtboard[] {
  const result: NativeArtboard[] = []
  const bleed = sourceBleed(source)
  for (const match of source.matchAll(
    /^%AIArtboard:\s*([^|\r\n]+)\|\s*([+-]?[0-9.eE]+)\s+([+-]?[0-9.eE]+)\s+([+-]?[0-9.eE]+)\s+([+-]?[0-9.eE]+)/gmu,
  )) {
    const index = result.length
    result.push({
      id: `source-artboard-${index}`,
      name: match[1]?.trim() || `Artboard ${index + 1}`,
      left: Number(match[2]),
      top: Number(match[3]),
      right: Number(match[4]),
      bottom: Number(match[5]),
      ...(bleed === undefined ? {} : { bleed }),
      rawProperties: {},
      source: 'private-source',
    })
  }

  const starts: number[] = []
  for (const match of source.matchAll(/%_?\/Dictionary\s*:/gu)) {
    if (typeof match.index === 'number') starts.push(match.index)
  }
  starts.push(source.length)
  for (let blockIndex = 0; blockIndex + 1 < starts.length; blockIndex++) {
    const start = starts[blockIndex]
    const end = starts[blockIndex + 1]
    if (start === undefined || end === undefined) continue
    const block = source.slice(start, end)
    const first = pointProperty(block, 'PositionPoint1')
    const second = pointProperty(block, 'PositionPoint2')
    if (first === undefined || second === undefined) continue
    const properties = artboardRawProperties(block)
    const encodedName = /%_?\s*\(((?:\\.|[^\\)])*)\)\s+\/UnicodeString\s+\(Name\)/u.exec(block)?.[1]
    const name = encodedName === undefined
      ? typeof properties.Name === 'string'
        ? properties.Name
        : `Artboard ${result.length + 1}`
      : decodePostScriptString(encodedName)
    const uuid = typeof properties.ArtboardUUID === 'string'
      ? properties.ArtboardUUID
      : undefined
    const rulerOrigin = pointProperty(block, 'RulerOrigin')
    const selected = typeof properties.IsArtboardSelected === 'boolean'
      ? properties.IsArtboardSelected
      : undefined
    const locked = typeof properties.IsArtboardLocked === 'boolean'
      ? properties.IsArtboardLocked
      : undefined
    const pixelAspectRatio = typeof properties.PAR === 'number'
      ? properties.PAR
      : undefined
    const duplicate = result.some((entry) =>
      (uuid !== undefined && entry.uuid === uuid)
      || (
        entry.name === name
        && entry.left === first.x
        && entry.top === first.y
        && entry.right === second.x
        && entry.bottom === second.y
      ),
    )
    if (duplicate) continue
    result.push({
      id: uuid ?? `source-artboard-${result.length}`,
      name,
      ...(uuid === undefined ? {} : { uuid }),
      left: first.x,
      top: first.y,
      right: second.x,
      bottom: second.y,
      ...(selected === undefined ? {} : { selected }),
      ...(locked === undefined ? {} : { locked }),
      ...(pixelAspectRatio === undefined ? {} : { pixelAspectRatio }),
      ...(rulerOrigin === undefined ? {} : { rulerOrigin }),
      ...(bleed === undefined ? {} : { bleed }),
      rawProperties: properties,
      source: 'private-source',
    })
  }
  return result
}

function artboardsFromScene(scene: unknown): NativeArtboard[] {
  const record = asNativeRecord(scene)
  const values = Array.isArray(record?.artboards) ? record.artboards : []
  const result: NativeArtboard[] = []
  for (const raw of values) {
    const artboard = asNativeRecord(raw)
    const bounds = nativeBoundsFrom(artboard)
      ?? nativeBoundsFrom(artboard?.bounds)
    if (bounds === undefined) continue
    const index = result.length
    const name = nativeString(artboard?.name) ?? `Artboard ${index + 1}`
    const uuid = nativeString(artboard?.uuid)
    const id = nativeString(artboard?.id) ?? uuid ?? `scene-artboard-${index}`
    const selected = nativeBoolean(artboard?.selected)
    const locked = nativeBoolean(artboard?.locked)
    const pixelAspectRatio = nativeNumber(artboard?.pixelAspectRatio)
    const rawBleed = asNativeRecord(artboard?.bleed)
    const bleedTop = nativeNumber(rawBleed?.top)
    const bleedRight = nativeNumber(rawBleed?.right)
    const bleedBottom = nativeNumber(rawBleed?.bottom)
    const bleedLeft = nativeNumber(rawBleed?.left)
    const bleed = (
      bleedTop === undefined
      || bleedRight === undefined
      || bleedBottom === undefined
      || bleedLeft === undefined
    )
      ? undefined
      : {
          top: bleedTop,
          right: bleedRight,
          bottom: bleedBottom,
          left: bleedLeft,
        }
    const ruler = asNativeRecord(artboard?.rulerOrigin)
    const rulerX = nativeNumber(ruler?.x)
    const rulerY = nativeNumber(ruler?.y)
    const rulerOrigin = rulerX === undefined || rulerY === undefined
      ? undefined
      : { x: rulerX, y: rulerY }
    result.push({
      id,
      name,
      ...(uuid === undefined ? {} : { uuid }),
      ...bounds,
      ...(selected === undefined ? {} : { selected }),
      ...(locked === undefined ? {} : { locked }),
      ...(pixelAspectRatio === undefined ? {} : { pixelAspectRatio }),
      ...(rulerOrigin === undefined ? {} : { rulerOrigin }),
      ...(bleed === undefined ? {} : { bleed }),
      rawProperties: {},
      source: 'scene',
    })
  }
  return result
}

function boundingBoxArtboard(source: string): NativeArtboard | undefined {
  const match = new RegExp(
    `^%%(?:HiRes)?BoundingBox:\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})`,
    'imu',
  ).exec(source)
  if (match === null) return undefined
  return {
    id: 'bounding-box-artboard',
    name: 'Artboard 1',
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
    rawProperties: {},
    source: 'bounding-box',
  }
}

export function extractNativeArtboards(
  source: string | Uint8Array,
  scene?: unknown,
  maximumSourceBytes = 64 * 1024 * 1024,
): readonly NativeArtboard[] {
  const text = latin1SourceText(source, maximumSourceBytes)
  const merged = artboardsFromScene(scene)
  for (const candidate of artboardsFromSource(text)) {
    const match = merged.find((existing) =>
      (candidate.uuid !== undefined && existing.uuid === candidate.uuid)
      || (
        existing.name === candidate.name
        && existing.left === candidate.left
        && existing.top === candidate.top
        && existing.right === candidate.right
        && existing.bottom === candidate.bottom
      ),
    )
    if (match === undefined) {
      merged.push(candidate)
      continue
    }
    if (candidate.uuid !== undefined) match.uuid = candidate.uuid
    if (candidate.selected !== undefined) match.selected = candidate.selected
    if (candidate.locked !== undefined) match.locked = candidate.locked
    if (candidate.pixelAspectRatio !== undefined) {
      match.pixelAspectRatio = candidate.pixelAspectRatio
    }
    if (candidate.rulerOrigin !== undefined) {
      match.rulerOrigin = candidate.rulerOrigin
    }
    if (candidate.bleed !== undefined) match.bleed = candidate.bleed
    match.rawProperties = {
      ...match.rawProperties,
      ...candidate.rawProperties,
    }
  }
  if (merged.length > 0) return merged
  const fallback = boundingBoxArtboard(text)
  return fallback === undefined ? [] : [fallback]
}

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

function sourceStatementRaw(statement: Record<string, unknown>): string {
  return typeof statement.raw === 'string' ? statement.raw : ''
}

function sourceStatementOffset(
  statement: Record<string, unknown>,
  side: 'start' | 'end',
): number | undefined {
  const span = asNativeRecord(statement.span)
  const value = span?.[side]
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function sourceMarkerKind(
  raw: string,
): NativeSourceSectionKind | undefined {
  if (/%%BeginProlog\b/iu.test(raw)) return 'prolog'
  if (/%%BeginSetup\b/iu.test(raw)) return 'setup'
  if (
    /%%BeginResource\b|%AI\d*_Begin(?:Gradient|Pattern|Symbol|Brush|Data)/iu.test(raw)
  ) return 'resource'
  if (/%%Trailer\b/iu.test(raw)) return 'trailer'
  if (
    /%AI\d*_Begin(?:Fallback|PluginObject|ExpandedAppearance)/iu.test(raw)
  ) return 'fallback'
  return undefined
}

function sourceEndMarker(
  raw: string,
  kind: NativeSourceSectionKind,
): boolean {
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
    const raw = record === undefined ? '' : sourceStatementRaw(record)
    const begin = sourceMarkerKind(raw)
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
    if (sourceEndMarker(raw, current)) {
      current = stack.pop() ?? (drawingStarted ? 'drawing' : 'header')
    }
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
    const raw = records.map(sourceStatementRaw).join('')
    const markers: string[] = []
    for (const record of records) {
      const marker = /(?:%%|%AI\d*_)[A-Za-z0-9_:-]+/u.exec(
        sourceStatementRaw(record),
      )?.[0]
      if (marker !== undefined && !markers.includes(marker)) markers.push(marker)
    }
    const first = records[0]
    const last = records[records.length - 1]
    const startOffset = first === undefined
      ? undefined
      : sourceStatementOffset(first, 'start')
    const endOffset = last === undefined
      ? undefined
      : sourceStatementOffset(last, 'end')
    sections.push({
      id: `${kind}:${start}:${nativeFNV1a(raw)}`,
      kind,
      startStatement: start,
      endStatement: end,
      ...(startOffset === undefined ? {} : { startOffset }),
      ...(endOffset === undefined ? {} : { endOffset }),
      rawHash: nativeFNV1a(raw),
      markers,
    })
    start = end
  }
  return { sections, statementKinds, diagnostics }
}

export type NativeResourceKind =
  | 'gradient'
  | 'pattern'
  | 'embedded-raster'
  | 'placed-art'
  | 'font'
  | 'icc-profile'
  | 'symbol'
  | 'brush'
  | 'effect'
  | 'opacity-mask'
  | 'unknown'

export interface NativeResourceRecord {
  id: string
  kind: NativeResourceKind
  name?: string
  sourceOperator?: string
  statementIndex?: number
  raw?: string
  dependencies: readonly string[]
  metadata: Readonly<Record<string, string | number | boolean>>
  fidelity: NativeFidelity
}

export class NativeResourceGraph {
  readonly #resources = new Map<string, NativeResourceRecord>()

  add(resource: NativeResourceRecord): void {
    const previous = this.#resources.get(resource.id)
    if (
      previous !== undefined
      && stableNativeSerialize(previous) !== stableNativeSerialize(resource)
    ) {
      throw new Error(`Resource ${resource.id} has conflicting definitions.`)
    }
    this.#resources.set(resource.id, resource)
  }

  get(id: string): NativeResourceRecord | undefined {
    return this.#resources.get(id)
  }

  has(id: string): boolean { return this.#resources.has(id) }

  values(): readonly NativeResourceRecord[] {
    return [...this.#resources.values()]
  }

  validate(): readonly string[] {
    const diagnostics: string[] = []
    for (const resource of this.#resources.values()) {
      for (const dependency of resource.dependencies) {
        if (!this.#resources.has(dependency)) {
          diagnostics.push(
            `Resource ${resource.id} references missing dependency ${dependency}.`,
          )
        }
      }
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string, path: readonly string[]): void => {
      if (visited.has(id)) return
      if (visiting.has(id)) {
        diagnostics.push(
          `Resource cycle detected: ${[...path, id].join(' -> ')}.`,
        )
        return
      }
      visiting.add(id)
      const resource = this.#resources.get(id)
      for (const dependency of resource?.dependencies ?? []) {
        visit(dependency, [...path, id])
      }
      visiting.delete(id)
      visited.add(id)
    }
    for (const id of this.#resources.keys()) visit(id, [])
    return diagnostics
  }
}

const RESOURCE_OPERATORS: Readonly<Record<string, NativeResourceKind>> = {
  Bd: 'gradient',
  BD: 'gradient',
  Bg: 'gradient',
  BB: 'gradient',
  PB: 'pattern',
  PE: 'pattern',
  AI9_BeginPattern: 'pattern',
  AI9_EndPattern: 'pattern',
  XI: 'embedded-raster',
  BI: 'embedded-raster',
  ID: 'embedded-raster',
  XG: 'placed-art',
  Xh: 'placed-art',
  AI9_BeginSymbol: 'symbol',
  AI9_EndSymbol: 'symbol',
  AI9_BeginBrush: 'brush',
  AI9_EndBrush: 'brush',
  Ap: 'brush',
  Ar: 'brush',
  LiveEffect: 'effect',
  AI9_BeginLiveEffect: 'effect',
  AI9_EndLiveEffect: 'effect',
  AI9_BeginOpacityMask: 'opacity-mask',
  AI9_EndOpacityMask: 'opacity-mask',
}

const BEGIN_RESOURCE_OPERATORS = new Set([
  'Bd',
  'PB',
  'AI9_BeginPattern',
  'AI9_BeginSymbol',
  'AI9_BeginBrush',
  'AI9_BeginLiveEffect',
  'AI9_BeginOpacityMask',
])

const END_RESOURCE_OPERATORS = new Set([
  'BD',
  'PE',
  'AI9_EndPattern',
  'AI9_EndSymbol',
  'AI9_EndBrush',
  'AI9_EndLiveEffect',
  'AI9_EndOpacityMask',
])

function sceneResourceEntries(scene: unknown): readonly [string, unknown][] {
  const record = asNativeRecord(scene)
  const resources = asNativeRecord(record?.resources)
  return resources === undefined ? [] : Object.entries(resources)
}

function normalizeResourceKind(value: unknown): NativeResourceKind {
  const known: readonly NativeResourceKind[] = [
    'gradient',
    'pattern',
    'embedded-raster',
    'placed-art',
    'font',
    'icc-profile',
    'symbol',
    'brush',
    'effect',
    'opacity-mask',
    'unknown',
  ]
  return typeof value === 'string'
    && known.includes(value as NativeResourceKind)
    ? value as NativeResourceKind
    : 'unknown'
}

function resourceFidelity(kind: NativeResourceKind): NativeFidelity {
  if (
    kind === 'gradient'
    || kind === 'pattern'
    || kind === 'font'
    || kind === 'icc-profile'
  ) return 'partial'
  return 'structure-only'
}

export function buildNativeResourceGraph(
  ast: unknown,
  scene?: unknown,
): NativeResourceGraph {
  const graph = new NativeResourceGraph()
  const active = new Map<NativeResourceKind, string[]>()
  nativeAstStatements(ast).forEach((statement, statementIndex) => {
    const record = asNativeRecord(statement)
    if (record?.kind !== 'operator' || typeof record.operator !== 'string') return
    const kind = RESOURCE_OPERATORS[record.operator]
    if (kind === undefined) return
    const operands = Array.isArray(record.operands) ? record.operands : []
    const name = operands
      .map(nativeString)
      .find((value) => value !== undefined)
    const raw = typeof record.raw === 'string'
      ? record.raw
      : stableNativeSerialize(statement)
    const id = `${kind}:${nativeFNV1a(`${statementIndex}:${raw}`)}`
    const dependencies = [...active.values()]
      .flatMap((ids) => ids.slice(-1))
      .filter((dependency) => dependency !== id)
    const numbers = operands
      .map(nativeNumber)
      .filter((value): value is number => value !== undefined)
    graph.add({
      id,
      kind,
      ...(name === undefined ? {} : { name }),
      sourceOperator: record.operator,
      statementIndex,
      raw,
      dependencies,
      metadata: {
        operator: record.operator,
        operandCount: operands.length,
        numericOperands: numbers.length,
      },
      fidelity: resourceFidelity(kind),
    })
    if (BEGIN_RESOURCE_OPERATORS.has(record.operator)) {
      const stack = active.get(kind)
      if (stack === undefined) active.set(kind, [id])
      else stack.push(id)
    }
    if (END_RESOURCE_OPERATORS.has(record.operator)) {
      active.get(kind)?.pop()
    }
  })
  for (const [key, value] of sceneResourceEntries(scene)) {
    const record = asNativeRecord(value)
    const kind = normalizeResourceKind(record?.kind)
    const id = `scene:${key}`
    graph.add({
      id,
      kind,
      name: key,
      dependencies: [],
      metadata: { source: 'scene-ir' },
      fidelity: resourceFidelity(kind),
      raw: stableNativeSerialize(value),
    })
  }
  return graph
}

export type ExternalResourcePolicy =
  | 'deny'
  | 'resolver-only'
  | 'same-origin'
  | 'allow-list'

export interface NativeResourceRequest {
  id: string
  url?: string
  expectedBytes?: number
  mime?: string
}

export interface NativeResolvedResource {
  id: string
  bytes: Uint8Array
  mime?: string
  source: 'embedded' | 'resolver'
}

export interface NativeResourceResolverOptions {
  policy?: ExternalResourcePolicy
  baseUrl?: string
  allowedOrigins?: readonly string[]
  maximumBytes?: number
  resolve?: (
    request: NativeResourceRequest,
    signal?: AbortSignal,
  ) => Promise<Uint8Array | undefined>
}

export function nativeResourceUrlPermitted(
  url: string,
  options: NativeResourceResolverOptions,
): boolean {
  const policy = options.policy ?? 'deny'
  if (policy === 'deny' || policy === 'resolver-only') return false
  let parsed: URL
  try {
    parsed = new URL(url, options.baseUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (policy === 'same-origin') {
    if (options.baseUrl === undefined) return false
    return parsed.origin === new URL(options.baseUrl).origin
  }
  return options.allowedOrigins?.includes(parsed.origin) === true
}

export async function resolveNativeResource(
  request: NativeResourceRequest,
  options: NativeResourceResolverOptions = {},
  signal?: AbortSignal,
): Promise<NativeResolvedResource> {
  if (signal?.aborted === true) {
    throw new DOMException('Resource resolution aborted.', 'AbortError')
  }
  if (
    request.url !== undefined
    && !nativeResourceUrlPermitted(request.url, options)
    && options.resolve === undefined
  ) {
    throw new Error(
      `External resource ${request.id} is denied by the ${options.policy ?? 'deny'} policy.`,
    )
  }
  if (options.resolve === undefined) {
    throw new Error(
      `No explicit resolver is configured for resource ${request.id}.`,
    )
  }
  const bytes = await options.resolve(request, signal)
  if (bytes === undefined) {
    throw new Error(`Resource resolver did not provide ${request.id}.`)
  }
  const maximumBytes = options.maximumBytes ?? 64 * 1024 * 1024
  if (bytes.byteLength > maximumBytes) {
    throw new RangeError(
      `Resource ${request.id} exceeds the ${maximumBytes}-byte limit.`,
    )
  }
  if (signal?.aborted === true) {
    throw new DOMException('Resource resolution aborted.', 'AbortError')
  }
  return {
    id: request.id,
    bytes,
    ...(request.mime === undefined ? {} : { mime: request.mime }),
    source: 'resolver',
  }
}

export interface NativeGradientStop {
  offset: number
  midpoint?: number
  color: Readonly<{
    space: 'gray' | 'rgb' | 'cmyk' | 'spot' | 'unknown'
    components: readonly number[]
    name?: string
    tint?: number
  }>
}

export interface NativeGradientDefinition {
  id: string
  name: string
  gradientType: 'linear' | 'radial' | 'freeform' | 'unknown'
  matrix?: readonly number[]
  stops: readonly NativeGradientStop[]
  raw: string
  fidelity: NativeFidelity
}

export interface NativePatternDefinition {
  id: string
  name: string
  paintType?: number
  tilingType?: number
  bounds?: readonly number[]
  matrix?: readonly number[]
  raw: string
  fidelity: NativeFidelity
}

export interface NativeRasterDefinition {
  id: string
  width?: number
  height?: number
  bitsPerComponent?: number
  colorSpace?: string
  format: 'png' | 'jpeg' | 'tiff' | 'gif' | 'raw' | 'unknown'
  embeddedBytes?: Uint8Array
  externalReference?: string
  raw: string
  fidelity: NativeFidelity
}

export interface NativeColorResource {
  id: string
  kind: 'process' | 'spot' | 'icc-profile'
  name: string
  components?: readonly number[]
  profileName?: string
  fidelity: NativeFidelity
}

export interface NativeDecodedResources {
  gradients: readonly NativeGradientDefinition[]
  patterns: readonly NativePatternDefinition[]
  rasters: readonly NativeRasterDefinition[]
  colors: readonly NativeColorResource[]
  diagnostics: readonly string[]
}

function statementOperator(statement: unknown): string | undefined {
  const record = asNativeRecord(statement)
  return typeof record?.operator === 'string' ? record.operator : undefined
}

function statementOperands(statement: unknown): readonly unknown[] {
  const record = asNativeRecord(statement)
  return Array.isArray(record?.operands) ? record.operands : []
}

function statementRaw(statement: unknown): string {
  const record = asNativeRecord(statement)
  return typeof record?.raw === 'string' ? record.raw : ''
}

function numericOperands(statement: unknown): number[] {
  return statementOperands(statement)
    .map(nativeNumber)
    .filter((value): value is number => value !== undefined)
}

function firstStringOperand(statement: unknown): string | undefined {
  return statementOperands(statement)
    .map(nativeString)
    .find((value) => value !== undefined)
}

function bytesFromValue(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  const record = asNativeRecord(value)
  if (record === undefined) return undefined
  if (record.value instanceof Uint8Array) return record.value
  if (record.bytes instanceof Uint8Array) return record.bytes
  if (Array.isArray(record.values)) {
    const chunks = record.values
      .map(bytesFromValue)
      .filter((entry): entry is Uint8Array => entry !== undefined)
    if (chunks.length === 0) return undefined
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
  return undefined
}

function statementBytes(statement: unknown): Uint8Array | undefined {
  const chunks = statementOperands(statement)
    .map(bytesFromValue)
    .filter((value): value is Uint8Array => value !== undefined)
  if (chunks.length === 0) return undefined
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function rasterFormat(
  bytes: Uint8Array | undefined,
): NativeRasterDefinition['format'] {
  if (bytes === undefined || bytes.byteLength === 0) return 'unknown'
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
  ) return 'png'
  if (
    bytes.byteLength >= 2
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
  ) return 'jpeg'
  if (
    bytes.byteLength >= 4
    && (
      (
        bytes[0] === 0x49
        && bytes[1] === 0x49
        && bytes[2] === 0x2a
        && bytes[3] === 0x00
      )
      || (
        bytes[0] === 0x4d
        && bytes[1] === 0x4d
        && bytes[2] === 0x00
        && bytes[3] === 0x2a
      )
    )
  ) return 'tiff'
  if (
    bytes.byteLength >= 6
    && latin1SourceText(bytes.subarray(0, 6)) === 'GIF89a'
  ) return 'gif'
  return 'raw'
}

function gradientStops(raw: string): NativeGradientStop[] {
  const result: NativeGradientStop[] = []
  for (const match of raw.matchAll(
    /([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+%_?BS\b/gu,
  )) {
    result.push({
      offset: Math.max(0, Math.min(1, Number(match[1]))),
      midpoint: Math.max(0, Math.min(1, Number(match[2]))),
      color: { space: 'unknown', components: [] },
    })
  }
  return result.sort((left, right) => left.offset - right.offset)
}

function decodeGradients(
  statements: readonly unknown[],
): NativeGradientDefinition[] {
  const result: NativeGradientDefinition[] = []
  let start = -1
  let name = ''
  let beginNumbers: number[] = []
  for (let index = 0; index < statements.length; index++) {
    const operator = statementOperator(statements[index])
    if (operator === 'Bd' || operator === 'Bg') {
      start = index
      name = firstStringOperand(statements[index])
        ?? `Gradient ${result.length + 1}`
      beginNumbers = numericOperands(statements[index])
      continue
    }
    if ((operator === 'BD' || operator === 'BB') && start >= 0) {
      const raw = statements
        .slice(start, index + 1)
        .map(statementRaw)
        .join('')
      const typeCode = beginNumbers[beginNumbers.length - 1]
      const gradientType = typeCode === 1
        ? 'radial'
        : typeCode === 0
          ? 'linear'
          : 'unknown'
      const matrix = beginNumbers.length >= 6
        ? beginNumbers.slice(0, 6)
        : undefined
      const stops = gradientStops(raw)
      result.push({
        id: `gradient:${nativeFNV1a(`${start}:${raw}`)}`,
        name,
        gradientType,
        ...(matrix === undefined ? {} : { matrix }),
        stops,
        raw,
        fidelity: stops.length >= 2 ? 'partial' : 'structure-only',
      })
      start = -1
      name = ''
      beginNumbers = []
    }
  }
  return result
}

function decodePatterns(
  statements: readonly unknown[],
): NativePatternDefinition[] {
  const result: NativePatternDefinition[] = []
  let start = -1
  let name = ''
  let numbers: number[] = []
  for (let index = 0; index < statements.length; index++) {
    const operator = statementOperator(statements[index])
    if (operator === 'PB' || operator === 'AI9_BeginPattern') {
      start = index
      name = firstStringOperand(statements[index])
        ?? `Pattern ${result.length + 1}`
      numbers = numericOperands(statements[index])
      continue
    }
    if (
      (operator === 'PE' || operator === 'AI9_EndPattern')
      && start >= 0
    ) {
      const raw = statements
        .slice(start, index + 1)
        .map(statementRaw)
        .join('')
      const paintType = numbers[0]
      const tilingType = numbers[1]
      result.push({
        id: `pattern:${nativeFNV1a(`${start}:${raw}`)}`,
        name,
        ...(paintType === undefined ? {} : { paintType }),
        ...(tilingType === undefined ? {} : { tilingType }),
        ...(numbers.length < 6 ? {} : { bounds: numbers.slice(2, 6) }),
        ...(numbers.length < 12 ? {} : { matrix: numbers.slice(6, 12) }),
        raw,
        fidelity: 'structure-only',
      })
      start = -1
      name = ''
      numbers = []
    }
  }
  return result
}

function decodeRasters(
  statements: readonly unknown[],
): NativeRasterDefinition[] {
  const result: NativeRasterDefinition[] = []
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index]
    const operator = statementOperator(statement)
    if (
      operator !== 'XI'
      && operator !== 'XG'
      && operator !== 'Xh'
      && operator !== 'BI'
    ) continue
    const numbers = numericOperands(statement)
    const strings = statementOperands(statement)
      .map(nativeString)
      .filter((value): value is string => value !== undefined)
    const bytes = statementBytes(statement)
    const raw = statementRaw(statement)
    const externalReference = strings.find((value) =>
      /^(?:https?|file):\/\//iu.test(value)
      || /[\\/]/u.test(value),
    )
    const width = numbers[0]
    const height = numbers[1]
    const bitsPerComponent = numbers[2]
    const colorSpace = strings[0]
    result.push({
      id: `raster:${nativeFNV1a(`${index}:${raw || stableNativeSerialize(statement)}`)}`,
      ...(width === undefined ? {} : { width: Math.max(0, width) }),
      ...(height === undefined ? {} : { height: Math.max(0, height) }),
      ...(bitsPerComponent === undefined ? {} : { bitsPerComponent }),
      ...(colorSpace === undefined ? {} : { colorSpace }),
      format: rasterFormat(bytes),
      ...(bytes === undefined ? {} : { embeddedBytes: bytes }),
      ...(externalReference === undefined ? {} : { externalReference }),
      raw,
      fidelity: bytes === undefined ? 'structure-only' : 'partial',
    })
  }
  return result
}

function decodeColors(
  source: string | Uint8Array,
  statements: readonly unknown[],
): NativeColorResource[] {
  const result: NativeColorResource[] = []
  const text = latin1SourceText(source, 16 * 1024 * 1024)
  for (const match of text.matchAll(
    /^%%DocumentCustomColors:\s*\(([^)]*)\)/gmu,
  )) {
    const name = match[1]?.trim()
    if (name === undefined || name === '') continue
    result.push({
      id: `spot:${nativeFNV1a(name)}`,
      kind: 'spot',
      name,
      fidelity: 'partial',
    })
  }
  for (const match of text.matchAll(
    /^%AI\d*_(?:ProfileName|ICCProfile):\s*(.+)$/gmu,
  )) {
    const profileName = match[1]?.trim()
    if (profileName === undefined || profileName === '') continue
    result.push({
      id: `icc:${nativeFNV1a(profileName)}`,
      kind: 'icc-profile',
      name: profileName,
      profileName,
      fidelity: 'structure-only',
    })
  }
  for (let index = 0; index < statements.length; index++) {
    const operator = statementOperator(statements[index])
    if (
      !['k', 'K', 'rg', 'RG', 'g', 'G', 'x', 'X', 'Xk', 'XK']
        .includes(operator ?? '')
    ) continue
    const components = numericOperands(statements[index])
    const name = firstStringOperand(statements[index])
      ?? operator
      ?? 'process'
    const spot = operator === 'x'
      || operator === 'X'
      || operator === 'Xk'
      || operator === 'XK'
    result.push({
      id: `color:${nativeFNV1a(`${index}:${statementRaw(statements[index])}`)}`,
      kind: spot ? 'spot' : 'process',
      name,
      components,
      fidelity: spot ? 'partial' : 'high',
    })
  }
  return result
}

export function decodeNativeResources(
  source: string | Uint8Array,
  ast: unknown,
  graph?: NativeResourceGraph,
): NativeDecodedResources {
  const statements = nativeAstStatements(ast)
  const gradients = decodeGradients(statements)
  const patterns = decodePatterns(statements)
  const rasters = decodeRasters(statements)
  const colors = decodeColors(source, statements)
  const diagnostics: string[] = []
  for (const gradient of gradients) {
    if (gradient.stops.length < 2) {
      diagnostics.push(
        `Gradient ${gradient.name} was retained but lacks two decoded stops.`,
      )
    }
  }
  for (const pattern of patterns) {
    diagnostics.push(
      `Pattern ${pattern.name} retains its native program; tiling render remains evidence-gated.`,
    )
  }
  for (const raster of rasters) {
    if (
      raster.embeddedBytes === undefined
      && raster.externalReference === undefined
    ) {
      diagnostics.push(
        `Raster ${raster.id} has no decoded embedded payload or explicit external reference.`,
      )
    }
  }
  if (graph !== undefined) diagnostics.push(...graph.validate())
  return { gradients, patterns, rasters, colors, diagnostics }
}

export interface NativeTextRunModel {
  text: string
  fontPostScriptName?: string
  fontSize?: number
  tracking?: number
  horizontalScale?: number
  baselineShift?: number
  fill?: unknown
  stroke?: unknown
  raw: unknown
}

export interface NativeTextFrameModel {
  id: string
  kind: 'point' | 'area' | 'path' | 'unknown'
  storyId: string
  threadPrevious?: string
  threadNext?: string
  matrix?: readonly number[]
  bounds?: NativeBounds
  pathNodeId?: string
  runs: readonly NativeTextRunModel[]
  fidelity: NativeFidelity
}

export interface NativeTextStoryModel {
  id: string
  frameIds: readonly string[]
  text: string
}

export interface NativeTextModel {
  stories: readonly NativeTextStoryModel[]
  frames: readonly NativeTextFrameModel[]
  requiredFonts: readonly string[]
  diagnostics: readonly string[]
}

function textKind(
  node: Record<string, unknown>,
): NativeTextFrameModel['kind'] {
  const raw = typeof node.textKind === 'string'
    ? node.textKind
    : typeof node.kind === 'string'
      ? node.kind
      : 'unknown'
  if (raw === 'point' || raw === 'area' || raw === 'path') return raw
  return 'unknown'
}

function nativeTextRun(
  raw: unknown,
  requiredFonts: Set<string>,
): NativeTextRunModel {
  const record = asNativeRecord(raw)
  const text = typeof record?.text === 'string' ? record.text : ''
  const fontPostScriptName = typeof record?.fontPostScriptName === 'string'
    ? record.fontPostScriptName
    : typeof record?.fontFamily === 'string'
      ? record.fontFamily
      : undefined
  if (fontPostScriptName !== undefined) requiredFonts.add(fontPostScriptName)
  const fontSize = nativeNumber(record?.fontSize)
  const tracking = nativeNumber(record?.tracking)
  const horizontalScale = nativeNumber(record?.horizontalScale)
  const baselineShift = nativeNumber(record?.baselineShift)
  return {
    text,
    ...(fontPostScriptName === undefined ? {} : { fontPostScriptName }),
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(tracking === undefined ? {} : { tracking }),
    ...(horizontalScale === undefined ? {} : { horizontalScale }),
    ...(baselineShift === undefined ? {} : { baselineShift }),
    ...(record?.fill === undefined ? {} : { fill: record.fill }),
    ...(record?.stroke === undefined ? {} : { stroke: record.stroke }),
    raw,
  }
}

export function buildNativeTextModel(scene: unknown): NativeTextModel {
  const frames: NativeTextFrameModel[] = []
  const requiredFonts = new Set<string>()
  const diagnostics: string[] = []
  walkNativeScene(scene, (node) => {
    if (node.type !== 'Text') return
    const id = typeof node.id === 'string'
      ? node.id
      : `text:${frames.length}`
    const storyId = typeof node.storyId === 'string'
      ? node.storyId
      : `story:${id}`
    const kind = textKind(node)
    const rawRuns = Array.isArray(node.runs) ? node.runs : []
    const runs = rawRuns.map((raw) => nativeTextRun(raw, requiredFonts))
    const matrix = Array.isArray(node.matrix)
      ? node.matrix.filter((entry): entry is number =>
          typeof entry === 'number' && Number.isFinite(entry),
        )
      : undefined
    const bounds = nativeBoundsFrom(node.bounds)
    const threadPrevious = typeof node.threadPrevious === 'string'
      ? node.threadPrevious
      : undefined
    const threadNext = typeof node.threadNext === 'string'
      ? node.threadNext
      : undefined
    const pathNodeId = typeof node.pathNodeId === 'string'
      ? node.pathNodeId
      : undefined
    if (kind !== 'point') {
      diagnostics.push(
        `Text frame ${id} preserves ${kind} text structure but needs layout Oracle evidence.`,
      )
    }
    frames.push({
      id,
      kind,
      storyId,
      ...(threadPrevious === undefined ? {} : { threadPrevious }),
      ...(threadNext === undefined ? {} : { threadNext }),
      ...(matrix === undefined ? {} : { matrix }),
      ...(bounds === undefined ? {} : { bounds }),
      ...(pathNodeId === undefined ? {} : { pathNodeId }),
      runs,
      fidelity: kind === 'point' ? 'partial' : 'structure-only',
    })
  })
  const storyFrames = new Map<string, NativeTextFrameModel[]>()
  for (const frame of frames) {
    const existing = storyFrames.get(frame.storyId)
    if (existing === undefined) storyFrames.set(frame.storyId, [frame])
    else existing.push(frame)
  }
  const stories = [...storyFrames.entries()].map(([id, values]) => ({
    id,
    frameIds: values.map((frame) => frame.id),
    text: values
      .flatMap((frame) => frame.runs)
      .map((run) => run.text)
      .join(''),
  }))
  return {
    stories,
    frames,
    requiredFonts: [...requiredFonts].sort(),
    diagnostics,
  }
}

export function estimateNativeTextBounds(
  run: NativeTextRunModel,
  origin: Readonly<{ x: number; y: number }>,
): NativeBounds {
  const size = Math.max(0, run.fontSize ?? 12)
  const scale = Math.max(0, run.horizontalScale ?? 100) / 100
  const tracking = run.tracking ?? 0
  const glyphAdvance = size * 0.6 * scale
  const width = Math.max(
    0,
    run.text.length * glyphAdvance
      + Math.max(0, run.text.length - 1) * tracking / 1000 * size,
  )
  const ascent = size * 0.8
  const descent = size * 0.2
  const shift = run.baselineShift ?? 0
  return {
    left: origin.x,
    top: origin.y - ascent - shift,
    right: origin.x + width,
    bottom: origin.y + descent - shift,
  }
}

export interface NativeTransparencyRecord {
  id: string
  nodeId?: string
  opacity: number
  fillOpacity: number
  strokeOpacity: number
  blendMode: string
  isolated: boolean
  knockout: boolean
  maskResourceId?: string
  maskMode?: 'alpha' | 'luminosity' | 'unknown'
  fidelity: NativeFidelity
}

export interface NativeTransparencyModel {
  records: readonly NativeTransparencyRecord[]
  diagnostics: readonly string[]
}

export function buildNativeTransparencyModel(
  scene: unknown,
): NativeTransparencyModel {
  const records: NativeTransparencyRecord[] = []
  const diagnostics: string[] = []
  walkNativeScene(scene, (node) => {
    const appearance = asNativeRecord(node.appearance)
    const opacity = nativeNumber(appearance?.opacity)
      ?? nativeNumber(node.opacity)
      ?? 1
    const fillOpacity = nativeNumber(appearance?.fillOpacity) ?? opacity
    const strokeOpacity = nativeNumber(appearance?.strokeOpacity) ?? opacity
    const blendMode = nativeString(appearance?.blendMode)
      ?? nativeString(node.blendMode)
      ?? 'normal'
    const isolated = nativeBoolean(appearance?.isolated)
      ?? nativeBoolean(node.isolated)
      ?? false
    const knockout = nativeBoolean(appearance?.knockout)
      ?? nativeBoolean(node.knockout)
      ?? false
    const maskResourceId = typeof appearance?.maskResourceId === 'string'
      ? appearance.maskResourceId
      : typeof node.maskResourceId === 'string'
        ? node.maskResourceId
        : undefined
    const rawMaskMode = nativeString(appearance?.maskMode)
      ?? nativeString(node.maskMode)
    const maskMode: NativeTransparencyRecord['maskMode'] = (
      rawMaskMode === 'alpha'
      || rawMaskMode === 'luminosity'
    )
      ? rawMaskMode
      : rawMaskMode === undefined
        ? undefined
        : 'unknown'
    if (
      opacity === 1
      && fillOpacity === 1
      && strokeOpacity === 1
      && blendMode === 'normal'
      && !isolated
      && !knockout
      && maskResourceId === undefined
    ) return
    const nodeId = typeof node.id === 'string' ? node.id : undefined
    records.push({
      id: `transparency:${nodeId ?? records.length}`,
      ...(nodeId === undefined ? {} : { nodeId }),
      opacity,
      fillOpacity,
      strokeOpacity,
      blendMode,
      isolated,
      knockout,
      ...(maskResourceId === undefined ? {} : { maskResourceId }),
      ...(maskMode === undefined ? {} : { maskMode }),
      fidelity: maskResourceId === undefined && !knockout && !isolated
        ? 'partial'
        : 'structure-only',
    })
    if (maskResourceId !== undefined) {
      diagnostics.push(
        `Opacity mask ${maskResourceId} is preserved structurally and requires compositing Oracle evidence.`,
      )
    }
    if (knockout) {
      diagnostics.push(
        `Knockout group ${nodeId ?? records.length - 1} remains structure-only.`,
      )
    }
  })
  return { records, diagnostics }
}

export function canvasCompositeOperationForBlendMode(
  blendMode: string,
): GlobalCompositeOperation | undefined {
  const normalized = blendMode
    .trim()
    .toLowerCase()
    .replace(/[ _]/gu, '-')
  const supported: Readonly<Record<string, GlobalCompositeOperation>> = {
    normal: 'source-over',
    multiply: 'multiply',
    screen: 'screen',
    overlay: 'overlay',
    darken: 'darken',
    lighten: 'lighten',
    'color-dodge': 'color-dodge',
    'color-burn': 'color-burn',
    'hard-light': 'hard-light',
    'soft-light': 'soft-light',
    difference: 'difference',
    exclusion: 'exclusion',
    hue: 'hue',
    saturation: 'saturation',
    color: 'color',
    luminosity: 'luminosity',
  }
  return supported[normalized]
}

export type NativeAdvancedObjectKind =
  | 'symbol-definition'
  | 'symbol-instance'
  | 'brush-definition'
  | 'brush-stroke'
  | 'live-effect'
  | 'plugin-object'
  | 'expanded-fallback'

export interface NativeAdvancedObjectRecord {
  id: string
  kind: NativeAdvancedObjectKind
  nodeId?: string
  resourceId?: string
  operator?: string
  parameters: unknown
  hasExpandedFallback: boolean
  fallbackNodeIds: readonly string[]
  visibleImpact: boolean
  fidelity: NativeFidelity
}

export interface NativeAdvancedObjectModel {
  objects: readonly NativeAdvancedObjectRecord[]
  diagnostics: readonly string[]
}

function advancedKindForResource(
  kind: NativeResourceKind,
): NativeAdvancedObjectKind | undefined {
  if (kind === 'symbol') return 'symbol-definition'
  if (kind === 'brush') return 'brush-definition'
  if (kind === 'effect') return 'live-effect'
  return undefined
}

function fallbackIds(node: Record<string, unknown>): string[] {
  const candidates = [
    node.expandedAppearance,
    node.fallbackAppearance,
    node.fallback,
    node.appearanceFallback,
  ]
  const result: string[] = []
  for (const candidate of candidates) {
    const record = asNativeRecord(candidate)
    if (typeof record?.id === 'string') result.push(record.id)
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const itemRecord = asNativeRecord(item)
        if (typeof itemRecord?.id === 'string') result.push(itemRecord.id)
      }
    }
  }
  return [...new Set(result)]
}

function sceneAdvancedKind(
  node: Record<string, unknown>,
): NativeAdvancedObjectKind | undefined {
  if (node.type === 'SymbolInstance') return 'symbol-instance'
  if (node.type === 'BrushStroke') return 'brush-stroke'
  if (node.type === 'LiveEffect' || node.type === 'Effect') {
    return 'live-effect'
  }
  if (node.type === 'PluginObject') return 'plugin-object'
  return undefined
}

export function buildNativeAdvancedObjectModel(
  ast: unknown,
  scene: unknown,
  resources: NativeResourceGraph,
): NativeAdvancedObjectModel {
  const objects: NativeAdvancedObjectRecord[] = []
  const diagnostics: string[] = []
  for (const resource of resources.values()) {
    const kind = advancedKindForResource(resource.kind)
    if (kind === undefined) continue
    objects.push({
      id: `advanced:${resource.id}`,
      kind,
      resourceId: resource.id,
      parameters: resource.metadata,
      hasExpandedFallback: false,
      fallbackNodeIds: [],
      visibleImpact: false,
      fidelity: resource.fidelity,
    })
  }
  walkNativeScene(scene, (node) => {
    const kind = sceneAdvancedKind(node)
    if (kind === undefined) return
    const id = typeof node.id === 'string'
      ? node.id
      : nativeFNV1a(stableNativeSerialize(node))
    const fallbacks = fallbackIds(node)
    const resourceId = typeof node.resourceId === 'string'
      ? node.resourceId
      : typeof node.symbolId === 'string'
        ? node.symbolId
        : typeof node.brushId === 'string'
          ? node.brushId
          : undefined
    const hasExpandedFallback = fallbacks.length > 0
      || (Array.isArray(node.children) && node.children.length > 0)
    objects.push({
      id: `advanced-node:${id}`,
      kind,
      nodeId: id,
      ...(resourceId === undefined ? {} : { resourceId }),
      parameters: node.parameters ?? node.effectParameters ?? node,
      hasExpandedFallback,
      fallbackNodeIds: fallbacks,
      visibleImpact: node.visible !== false,
      fidelity: hasExpandedFallback ? 'partial' : 'structure-only',
    })
    if (!hasExpandedFallback && node.visible !== false) {
      diagnostics.push(
        `${kind} ${id} has no expanded appearance and remains structure-only.`,
      )
    }
  })
  nativeAstStatements(ast).forEach((statement, statementIndex) => {
    const record = asNativeRecord(statement)
    if (record?.kind !== 'operator' || typeof record.operator !== 'string') return
    if (!/(?:plugin|liveeffect|effect|symbol|brush)/iu.test(record.operator)) {
      return
    }
    const raw = typeof record.raw === 'string'
      ? record.raw
      : stableNativeSerialize(statement)
    const exists = objects.some((entry) =>
      entry.operator === record.operator
      && entry.id.endsWith(nativeFNV1a(`${statementIndex}:${raw}`)),
    )
    if (exists) return
    const plugin = /plugin/iu.test(record.operator)
    objects.push({
      id: `advanced-operator:${nativeFNV1a(`${statementIndex}:${raw}`)}`,
      kind: plugin ? 'plugin-object' : 'live-effect',
      operator: record.operator,
      parameters: Array.isArray(record.operands) ? record.operands : [],
      hasExpandedFallback: false,
      fallbackNodeIds: [],
      visibleImpact: true,
      fidelity: 'structure-only',
    })
    diagnostics.push(
      `${record.operator} is preserved losslessly; executable plugin or effect code is never run.`,
    )
  })
  return { objects, diagnostics }
}
