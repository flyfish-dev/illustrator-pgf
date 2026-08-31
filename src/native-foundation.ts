export type NativeFidelity =
  | 'exact'
  | 'high'
  | 'partial'
  | 'structure-only'
  | 'unsupported'

export type NativeEvidenceKind =
  | 'synthetic-fixture'
  | 'real-illustrator-fixture'
  | 'structure-oracle'
  | 'visual-oracle'
  | 'performance-budget'
  | 'security-budget'
  | 'cross-browser'

export interface NativeFidelityEvidence {
  id: string
  kind: NativeEvidenceKind
  status: 'passed' | 'failed' | 'missing'
  versions?: readonly string[]
  source?: string
  notes?: string
}

export interface NativeFidelityDecision {
  requested: NativeFidelity
  effective: NativeFidelity
  promotable: boolean
  requiredEvidence: readonly NativeEvidenceKind[]
  missingEvidence: readonly NativeEvidenceKind[]
  failedEvidence: readonly NativeEvidenceKind[]
  evidence: readonly NativeFidelityEvidence[]
}

const FIDELITY_ORDER: readonly NativeFidelity[] = [
  'unsupported',
  'structure-only',
  'partial',
  'high',
  'exact',
]

export const NATIVE_FIDELITY_EVIDENCE_REQUIREMENTS: Readonly<
  Record<NativeFidelity, readonly NativeEvidenceKind[]>
> = {
  unsupported: [],
  'structure-only': [],
  partial: ['synthetic-fixture', 'security-budget'],
  high: [
    'synthetic-fixture',
    'real-illustrator-fixture',
    'structure-oracle',
    'visual-oracle',
    'performance-budget',
    'security-budget',
  ],
  exact: [
    'synthetic-fixture',
    'real-illustrator-fixture',
    'structure-oracle',
    'visual-oracle',
    'performance-budget',
    'security-budget',
    'cross-browser',
  ],
}

export function nativeFidelityRank(value: NativeFidelity): number {
  return FIDELITY_ORDER.indexOf(value)
}

export function isNativeFidelity(value: unknown): value is NativeFidelity {
  return typeof value === 'string'
    && FIDELITY_ORDER.includes(value as NativeFidelity)
}

export function nativeFidelityAtMost(
  value: NativeFidelity,
  maximum: NativeFidelity,
): NativeFidelity {
  return nativeFidelityRank(value) <= nativeFidelityRank(maximum)
    ? value
    : maximum
}

export function mergeNativeFidelity(
  values: readonly NativeFidelity[],
): NativeFidelity {
  let result: NativeFidelity = 'exact'
  for (const value of values) {
    if (nativeFidelityRank(value) < nativeFidelityRank(result)) result = value
  }
  return result
}

export function resolveNativeFidelity(
  requested: NativeFidelity,
  evidence: readonly NativeFidelityEvidence[],
  requirements: Readonly<
    Partial<Record<NativeFidelity, readonly NativeEvidenceKind[]>>
  > = {},
): NativeFidelityDecision {
  const requiredEvidence = requirements[requested]
    ?? NATIVE_FIDELITY_EVIDENCE_REQUIREMENTS[requested]
  const byKind = new Map<NativeEvidenceKind, NativeFidelityEvidence[]>()
  for (const entry of evidence) {
    const existing = byKind.get(entry.kind)
    if (existing === undefined) byKind.set(entry.kind, [entry])
    else existing.push(entry)
  }
  const missingEvidence = requiredEvidence.filter((kind) => {
    const entries = byKind.get(kind)
    return entries === undefined
      || entries.every((entry) => entry.status === 'missing')
  })
  const failedEvidence = requiredEvidence.filter((kind) =>
    byKind.get(kind)?.some((entry) => entry.status === 'failed') === true,
  )
  let effective = requested
  if (failedEvidence.length > 0) {
    effective = nativeFidelityAtMost(effective, 'structure-only')
  } else if (
    missingEvidence.length > 0
    && nativeFidelityRank(effective) >= nativeFidelityRank('high')
  ) {
    effective = 'partial'
  } else if (missingEvidence.length > 0 && effective === 'partial') {
    effective = 'structure-only'
  }
  return {
    requested,
    effective,
    promotable: missingEvidence.length === 0 && failedEvidence.length === 0,
    requiredEvidence,
    missingEvidence,
    failedEvidence,
    evidence: [...evidence],
  }
}

export function asNativeRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

export function nativeString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const record = asNativeRecord(value)
  return typeof record?.value === 'string' ? record.value : undefined
}

export function nativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const record = asNativeRecord(value)
  return typeof record?.value === 'number' && Number.isFinite(record.value)
    ? record.value
    : undefined
}

export function nativeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  const record = asNativeRecord(value)
  return typeof record?.value === 'boolean' ? record.value : undefined
}

export function latin1SourceText(
  input: string | Uint8Array,
  maximumBytes = Number.POSITIVE_INFINITY,
): string {
  if (typeof input === 'string') return input.slice(0, maximumBytes)
  const length = Math.min(input.byteLength, maximumBytes)
  const chunkSize = 32 * 1024
  const chunks: string[] = []
  for (let offset = 0; offset < length; offset += chunkSize) {
    const end = Math.min(length, offset + chunkSize)
    let chunk = ''
    for (let index = offset; index < end; index++) {
      chunk += String.fromCharCode(input[index] ?? 0)
    }
    chunks.push(chunk)
  }
  return chunks.join('')
}

export function nativeFNV1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function stableNativeSerialize(
  value: unknown,
  seen = new Set<unknown>(),
): string {
  if (value === undefined) return '"[Undefined]"'
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`)
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return JSON.stringify(String(value))
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (seen.has(value)) return '"[Circular]"'
  seen.add(value)
  if (value instanceof Uint8Array) {
    const serialized = `{"$bytes":"${Array.from(
      value,
      (entry) => entry.toString(16).padStart(2, '0'),
    ).join('')}"}`
    seen.delete(value)
    return serialized
  }
  if (Array.isArray(value)) {
    const serialized = `[${value
      .map((entry) => stableNativeSerialize(entry, seen))
      .join(',')}]`
    seen.delete(value)
    return serialized
  }
  const record = value as Record<string, unknown>
  const serialized = `{${Object.keys(record)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${stableNativeSerialize(record[key], seen)}`,
    )
    .join(',')}}`
  seen.delete(value)
  return serialized
}

export function nativeAstStatements(ast: unknown): readonly unknown[] {
  const record = asNativeRecord(ast)
  return Array.isArray(record?.statements) ? record.statements : []
}

export function nativeBoundsFrom(
  value: unknown,
): NativeBounds | undefined {
  const record = asNativeRecord(value)
  const left = nativeNumber(record?.left)
  const top = nativeNumber(record?.top)
  const right = nativeNumber(record?.right)
  const bottom = nativeNumber(record?.bottom)
  if (
    left === undefined
    || top === undefined
    || right === undefined
    || bottom === undefined
  ) return undefined
  return { left, top, right, bottom }
}

export function walkNativeScene(
  scene: unknown,
  visit: (
    node: Record<string, unknown>,
    parent?: Record<string, unknown>,
  ) => void,
): void {
  const root = asNativeRecord(scene)
  const roots = Array.isArray(root?.children)
    ? root.children
    : Array.isArray(root?.nodes)
      ? root.nodes
      : Array.isArray(root?.layers)
        ? root.layers
        : []
  const seen = new Set<unknown>()
  const walk = (
    value: unknown,
    parent?: Record<string, unknown>,
  ): void => {
    if (seen.has(value)) return
    const record = asNativeRecord(value)
    if (record === undefined) return
    seen.add(value)
    visit(record, parent)
    if (Array.isArray(record.children)) {
      for (const child of record.children) walk(child, record)
    }
  }
  for (const value of roots) walk(value)
}

export type IllustratorVersionFamily =
  | 'ai3'
  | 'ai5'
  | 'ai8'
  | 'ai9'
  | 'ai12'
  | 'ai24'
  | 'future'
  | 'unknown'

export interface IllustratorVersionProfile {
  family: IllustratorVersionFamily
  major?: number
  creator?: string
  fileFormat?: string
  privateCompression: 'none' | 'deflate' | 'zstd' | 'unknown'
  capabilities: Readonly<{
    layers: boolean
    liveText: boolean
    transparency: boolean
    multipleArtboards: boolean
    zstdPrivateSource: boolean
  }>
  diagnostics: readonly string[]
}

export interface IllustratorOperatorVersionRule {
  operator: string
  minimumMajor?: number
  maximumMajor?: number
  aliases?: readonly string[]
  feature: string
}

function firstNativeMatch(
  source: string,
  expressions: readonly RegExp[],
): string | undefined {
  for (const expression of expressions) {
    const match = expression.exec(source)
    if (match?.[1] !== undefined) return match[1].trim()
  }
  return undefined
}

function illustratorFamily(
  major: number | undefined,
): IllustratorVersionFamily {
  if (major === undefined || !Number.isFinite(major)) return 'unknown'
  if (major >= 25) return 'future'
  if (major >= 24) return 'ai24'
  if (major >= 12) return 'ai12'
  if (major >= 9) return 'ai9'
  if (major >= 8) return 'ai8'
  if (major >= 5) return 'ai5'
  return 'ai3'
}

export function detectIllustratorVersionProfile(
  source: string | Uint8Array,
): IllustratorVersionProfile {
  const text = latin1SourceText(source, 1024 * 1024)
  const creator = firstNativeMatch(text, [
    /^%%Creator:\s*(.+)$/imu,
    /^%AI\d*_CreatorVersion:\s*(.+)$/imu,
  ])
  const fileFormat = firstNativeMatch(text, [
    /^%AI\d*_FileFormat\s*:?[\s]*(.+)$/imu,
    /^%%LanguageLevel:\s*(.+)$/imu,
  ])
  const versionText = firstNativeMatch(text, [
    /^%AI\d*_CreatorVersion:\s*([0-9]+(?:\.[0-9]+)?)/imu,
    /Adobe Illustrator(?:\(R\))?\s*(?:CS\d*|CC)?\s*([0-9]+(?:\.[0-9]+)?)/iu,
    /Illustrator[^0-9\r\n]*([0-9]+(?:\.[0-9]+)?)/iu,
  ])
  const parsed = versionText === undefined
    ? undefined
    : Number.parseInt(versionText, 10)
  const major = parsed !== undefined && Number.isFinite(parsed)
    ? parsed
    : undefined
  const family = illustratorFamily(major)
  const privateCompression = /%AI24_ZStandard_Data/u.test(text)
    ? 'zstd'
    : /%AI(?:1[2-9]|2[0-3])_CompressedData/u.test(text)
      ? 'deflate'
      : /^%!PS-Adobe/mu.test(text)
        ? 'none'
        : 'unknown'
  const diagnostics: string[] = []
  if (major === undefined) {
    diagnostics.push(
      'Illustrator creator version could not be established from native headers.',
    )
  }
  if (family === 'future') {
    diagnostics.push(
      'The source belongs to a newer Illustrator family; unknown operators remain evidence-gated.',
    )
  }
  return {
    family,
    ...(major === undefined ? {} : { major }),
    ...(creator === undefined ? {} : { creator }),
    ...(fileFormat === undefined ? {} : { fileFormat }),
    privateCompression,
    capabilities: {
      layers: major === undefined || major >= 5,
      liveText: major === undefined || major >= 8,
      transparency: major === undefined || major >= 9,
      multipleArtboards: major === undefined || major >= 14,
      zstdPrivateSource: major !== undefined && major >= 24,
    },
    diagnostics,
  }
}

export function operatorRuleApplies(
  profile: IllustratorVersionProfile,
  rule: IllustratorOperatorVersionRule,
): boolean {
  if (profile.major === undefined) return true
  if (
    rule.minimumMajor !== undefined
    && profile.major < rule.minimumMajor
  ) return false
  if (
    rule.maximumMajor !== undefined
    && profile.major > rule.maximumMajor
  ) return false
  return true
}

export function resolveVersionedOperatorName(
  profile: IllustratorVersionProfile,
  operator: string,
  rules: readonly IllustratorOperatorVersionRule[],
): IllustratorOperatorVersionRule | undefined {
  return rules.find((rule) =>
    operatorRuleApplies(profile, rule)
    && (
      rule.operator === operator
      || rule.aliases?.includes(operator) === true
    ),
  )
}

export interface NativePoint {
  x: number
  y: number
}

export interface NativeBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface NativeMatrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY_NATIVE_MATRIX: NativeMatrix = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
}

export function transformNativePoint(
  point: NativePoint,
  matrix: NativeMatrix,
): NativePoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }
}

export function multiplyNativeMatrices(
  left: NativeMatrix,
  right: NativeMatrix,
): NativeMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  }
}

function cubicCoordinate(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const inverse = 1 - t
  return inverse * inverse * inverse * p0
    + 3 * inverse * inverse * t * p1
    + 3 * inverse * t * t * p2
    + t * t * t * p3
}

function quadraticRoots(a: number, b: number, c: number): number[] {
  const epsilon = 1e-12
  if (Math.abs(a) < epsilon) {
    if (Math.abs(b) < epsilon) return []
    return [-c / b]
  }
  const discriminant = b * b - 4 * a * c
  if (discriminant < -epsilon) return []
  if (Math.abs(discriminant) <= epsilon) return [-b / (2 * a)]
  const root = Math.sqrt(discriminant)
  const sign = b < 0 ? -1 : 1
  const q = -0.5 * (b + sign * root)
  if (Math.abs(q) < epsilon) {
    return [
      (-b + root) / (2 * a),
      (-b - root) / (2 * a),
    ]
  }
  return [q / a, c / q]
}

function cubicExtrema(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  return quadraticRoots(3 * a, 3 * b, 3 * c)
    .filter((value) => value > 0 && value < 1 && Number.isFinite(value))
}

export function exactCubicBezierBounds(
  start: NativePoint,
  control1: NativePoint,
  control2: NativePoint,
  end: NativePoint,
  matrix: NativeMatrix = IDENTITY_NATIVE_MATRIX,
): NativeBounds {
  const p0 = transformNativePoint(start, matrix)
  const p1 = transformNativePoint(control1, matrix)
  const p2 = transformNativePoint(control2, matrix)
  const p3 = transformNativePoint(end, matrix)
  const xValues = [p0.x, p3.x]
  const yValues = [p0.y, p3.y]
  for (const t of cubicExtrema(p0.x, p1.x, p2.x, p3.x)) {
    xValues.push(cubicCoordinate(p0.x, p1.x, p2.x, p3.x, t))
  }
  for (const t of cubicExtrema(p0.y, p1.y, p2.y, p3.y)) {
    yValues.push(cubicCoordinate(p0.y, p1.y, p2.y, p3.y, t))
  }
  return {
    left: Math.min(...xValues),
    top: Math.min(...yValues),
    right: Math.max(...xValues),
    bottom: Math.max(...yValues),
  }
}

export function unionNativeBounds(
  left: NativeBounds | undefined,
  right: NativeBounds | undefined,
): NativeBounds | undefined {
  if (left === undefined) return right === undefined ? undefined : { ...right }
  if (right === undefined) return { ...left }
  return {
    left: Math.min(left.left, right.left),
    top: Math.min(left.top, right.top),
    right: Math.max(left.right, right.right),
    bottom: Math.max(left.bottom, right.bottom),
  }
}

export function inflateNativeStrokeBounds(
  bounds: NativeBounds,
  width: number,
  options: Readonly<{
    miterLimit?: number
    cap?: 'butt' | 'round' | 'square'
  }> = {},
): NativeBounds {
  const half = Math.max(0, width) / 2
  const miter = Math.max(1, options.miterLimit ?? 1)
  const capScale = options.cap === 'square' ? Math.SQRT2 : 1
  const inflation = half * Math.max(miter, capScale)
  return {
    left: bounds.left - inflation,
    top: bounds.top - inflation,
    right: bounds.right + inflation,
    bottom: bounds.bottom + inflation,
  }
}

export interface ByteLruEntry<V> {
  key: string
  value: V
  bytes: number
}

export class ByteLruCache<V> {
  readonly #entries = new Map<string, ByteLruEntry<V>>()
  #bytes = 0
  #maximumBytes: number

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError(
        'maximumBytes must be a non-negative safe integer.',
      )
    }
    this.#maximumBytes = maximumBytes
  }

  get maximumBytes(): number { return this.#maximumBytes }
  get byteLength(): number { return this.#bytes }
  get size(): number { return this.#entries.size }
  has(key: string): boolean { return this.#entries.has(key) }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: V, bytes: number): readonly ByteLruEntry<V>[] {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError('bytes must be a non-negative safe integer.')
    }
    const previous = this.#entries.get(key)
    if (previous !== undefined) {
      this.#entries.delete(key)
      this.#bytes -= previous.bytes
    }
    const entry = { key, value, bytes }
    this.#entries.set(key, entry)
    this.#bytes += bytes
    return this.evict()
  }

  delete(key: string): boolean {
    const entry = this.#entries.get(key)
    if (entry === undefined) return false
    this.#entries.delete(key)
    this.#bytes -= entry.bytes
    return true
  }

  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }

  resize(maximumBytes: number): readonly ByteLruEntry<V>[] {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError(
        'maximumBytes must be a non-negative safe integer.',
      )
    }
    this.#maximumBytes = maximumBytes
    return this.evict()
  }

  entries(): readonly ByteLruEntry<V>[] {
    return [...this.#entries.values()]
  }

  private evict(): readonly ByteLruEntry<V>[] {
    const evicted: ByteLruEntry<V>[] = []
    while (this.#bytes > this.#maximumBytes && this.#entries.size > 0) {
      const first = this.#entries.entries().next().value as
        | [string, ByteLruEntry<V>]
        | undefined
      if (first === undefined) break
      this.#entries.delete(first[0])
      this.#bytes -= first[1].bytes
      evicted.push(first[1])
    }
    return evicted
  }
}

export interface CooperativeBudgetOptions {
  signal?: AbortSignal
  deadline?: number
  maximumOperations?: number
  now?: () => number
}

export class CooperativeBudget {
  readonly #signal: AbortSignal | undefined
  readonly #deadline: number | undefined
  readonly #maximumOperations: number
  readonly #now: () => number
  #operations = 0

  constructor(options: CooperativeBudgetOptions = {}) {
    this.#signal = options.signal
    this.#deadline = options.deadline
    this.#maximumOperations = options.maximumOperations ?? 1_000_000
    this.#now = options.now ?? (() => Date.now())
    if (
      !Number.isSafeInteger(this.#maximumOperations)
      || this.#maximumOperations < 1
    ) {
      throw new RangeError(
        'maximumOperations must be a positive safe integer.',
      )
    }
  }

  get operations(): number { return this.#operations }

  checkpoint(amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new RangeError(
        'Checkpoint amount must be a non-negative safe integer.',
      )
    }
    this.#operations += amount
    if (this.#signal?.aborted === true) {
      throw new DOMException('Operation aborted.', 'AbortError')
    }
    if (this.#deadline !== undefined && this.#now() > this.#deadline) {
      throw new DOMException('Operation timed out.', 'TimeoutError')
    }
    if (this.#operations > this.#maximumOperations) {
      throw new RangeError(
        `Operation budget exceeded ${this.#maximumOperations} checkpoints.`,
      )
    }
  }
}

export interface NativeRevisionGate {
  current(): number
  next(): number
  isCurrent(revision: number): boolean
}

export function createNativeRevisionGate(
  initialRevision = 0,
): NativeRevisionGate {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
    throw new RangeError(
      'initialRevision must be a non-negative safe integer.',
    )
  }
  let revision = initialRevision
  return {
    current: () => revision,
    next: () => ++revision,
    isCurrent: (candidate) => candidate === revision,
  }
}

export interface BrowserZstdDecoder {
  decode(
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Uint8Array | Promise<Uint8Array>
}

export interface BrowserZstdCodecProvider {
  zstdDecompress(
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
  decompressZstd(
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
  zstd(
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
}

function assertZstdFrame(input: Uint8Array): void {
  if (
    input.byteLength < 4
    || input[0] !== 0x28
    || input[1] !== 0xb5
    || input[2] !== 0x2f
    || input[3] !== 0xfd
  ) {
    throw new Error(
      'Input does not begin with the standard zstd frame magic.',
    )
  }
}

export function createBrowserZstdCodecProvider(
  decoder: BrowserZstdDecoder,
  options: Readonly<{
    requireFrameMagic?: boolean
    maximumInputBytes?: number
  }> = {},
): BrowserZstdCodecProvider {
  const decode = async (
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    if (!(input instanceof Uint8Array)) {
      throw new TypeError('zstd input must be a Uint8Array.')
    }
    if (
      !Number.isSafeInteger(maximumOutputBytes)
      || maximumOutputBytes < 0
    ) {
      throw new RangeError(
        'maximumOutputBytes must be a non-negative safe integer.',
      )
    }
    const maximumInputBytes = options.maximumInputBytes
      ?? 256 * 1024 * 1024
    if (input.byteLength > maximumInputBytes) {
      throw new RangeError(
        `zstd input exceeds the ${maximumInputBytes}-byte limit.`,
      )
    }
    if (options.requireFrameMagic !== false) assertZstdFrame(input)
    if (signal?.aborted === true) {
      throw new DOMException('zstd decode aborted.', 'AbortError')
    }
    const output = await decoder.decode(
      input,
      maximumOutputBytes,
      signal,
    )
    if (!(output instanceof Uint8Array)) {
      throw new TypeError(
        'Browser zstd decoder must return Uint8Array.',
      )
    }
    if (output.byteLength > maximumOutputBytes) {
      throw new RangeError(
        `zstd output exceeds the ${maximumOutputBytes}-byte limit.`,
      )
    }
    if (signal?.aborted === true) {
      throw new DOMException('zstd decode aborted.', 'AbortError')
    }
    return output
  }
  return {
    zstdDecompress: decode,
    decompressZstd: decode,
    zstd: decode,
  }
}
