import {
  asNativeRecord,
  nativeAstStatements,
  nativeFNV1a,
  nativeNumber,
  nativeString,
  stableNativeSerialize,
} from './native-common.js'
import type { NativeFidelity } from './native-fidelity.js'

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
  return typeof value === 'string' && known.includes(value as NativeResourceKind)
    ? value as NativeResourceKind
    : 'unknown'
}

function resourceFidelity(kind: NativeResourceKind): NativeFidelity {
  if (kind === 'font' || kind === 'icc-profile') return 'partial'
  if (kind === 'gradient' || kind === 'pattern') return 'partial'
  if (kind === 'unknown') return 'structure-only'
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
    const metadata: Record<string, string | number | boolean> = {
      operator: record.operator,
      operandCount: operands.length,
      numericOperands: numbers.length,
    }
    graph.add({
      id,
      kind,
      ...(name === undefined ? {} : { name }),
      sourceOperator: record.operator,
      statementIndex,
      raw,
      dependencies,
      metadata,
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
    if (graph.has(id)) continue
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
    throw new Error(`No explicit resolver is configured for resource ${request.id}.`)
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
