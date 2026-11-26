import {
  asNativeRecord,
  isNativeFidelity,
  latin1SourceText,
  nativeFNV1a,
  nativeNumber,
  walkNativeScene,
  type NativeFidelity,
  type NativeFidelityEvidence,
} from './native-foundation.js'
import type { NativeResourceGraph } from './native-analysis.js'

export interface NativeSecurityLimits {
  maximumSourceBytes: number
  maximumStatements: number
  maximumNesting: number
  maximumDeclaredBinaryBytes: number
  maximumExternalReferences: number
}

export const DEFAULT_NATIVE_SECURITY_LIMITS: NativeSecurityLimits = {
  maximumSourceBytes: 64 * 1024 * 1024,
  maximumStatements: 250_000,
  maximumNesting: 512,
  maximumDeclaredBinaryBytes: 64 * 1024 * 1024,
  maximumExternalReferences: 1_000,
}

export interface NativeSecurityReport {
  safeToParse: boolean
  sourceBytes: number
  estimatedStatements: number
  maximumObservedNesting: number
  declaredBinaryBytes: number
  activeContentIndicators: readonly string[]
  externalReferences: readonly string[]
  diagnostics: readonly string[]
}

const ACTIVE_POSTSCRIPT_OPERATORS: readonly [string, RegExp][] = [
  [
    'PostScript file operator',
    /(^|[\s{}\[\]()])file(?=$|[\s{}\[\]()])/mu,
  ],
  [
    'PostScript run operator',
    /(^|[\s{}\[\]()])run(?=$|[\s{}\[\]()])/mu,
  ],
  [
    'PostScript deletefile operator',
    /(^|[\s{}\[\]()])deletefile(?=$|[\s{}\[\]()])/mu,
  ],
  [
    'PostScript renamefile operator',
    /(^|[\s{}\[\]()])renamefile(?=$|[\s{}\[\]()])/mu,
  ],
  ['PostScript pipe path', /%pipe%/iu],
]

function estimateNativeStatements(source: string): number {
  let statements = 0
  let hasContent = false
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index)
    if (code === 0x0d) {
      if (source.charCodeAt(index + 1) === 0x0a) index++
      statements++
      hasContent = false
    } else if (code === 0x0a) {
      statements++
      hasContent = false
    } else {
      hasContent = true
    }
  }
  return statements + (hasContent ? 1 : 0)
}

function maximumNativeNesting(source: string): number {
  let current = 0
  let maximum = 0
  let stringDepth = 0
  let escaped = false
  let inComment = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (inComment) {
      if (character === '\r' || character === '\n') inComment = false
      continue
    }
    if (stringDepth > 0) {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') escaped = true
      else if (character === '(') stringDepth++
      else if (character === ')') stringDepth--
      maximum = Math.max(maximum, current + stringDepth)
      continue
    }
    if (character === '%') {
      inComment = true
      continue
    }
    if (character === '(') {
      stringDepth = 1
      maximum = Math.max(maximum, current + stringDepth)
      continue
    }
    if (
      character === '['
      || character === '{'
      || source.startsWith('<<', index)
    ) {
      current++
      maximum = Math.max(maximum, current)
      if (source.startsWith('<<', index)) index++
    } else if (
      character === ']'
      || character === '}'
      || source.startsWith('>>', index)
    ) {
      current = Math.max(0, current - 1)
      if (source.startsWith('>>', index)) index++
    }
  }
  return maximum
}

function declaredNativeBinaryBytes(source: string): number {
  let total = 0
  for (const match of source.matchAll(
    /^%%Begin(?:Binary|Data)\s*:\s*(\d+)/gimu,
  )) {
    const value = Number(match[1])
    if (Number.isSafeInteger(value) && value >= 0) total += value
  }
  return total
}

export function scanNativeSourceSecurity(
  source: string | Uint8Array,
  limits: Readonly<Partial<NativeSecurityLimits>> = {},
): NativeSecurityReport {
  const resolved = { ...DEFAULT_NATIVE_SECURITY_LIMITS, ...limits }
  const sourceBytes = typeof source === 'string'
    ? source.length
    : source.byteLength
  const text = latin1SourceText(
    source,
    Math.min(sourceBytes, resolved.maximumSourceBytes + 1),
  )
  const estimatedStatements = estimateNativeStatements(text)
  const maximumObservedNesting = maximumNativeNesting(text)
  const declaredBinaryBytes = declaredNativeBinaryBytes(text)
  const activeContentIndicators = ACTIVE_POSTSCRIPT_OPERATORS
    .filter(([, expression]) => expression.test(text))
    .map(([name]) => name)
  const externalReferences = [...text.matchAll(
    /(?:https?|file):\/\/[^\s()<>{}\[\]]+/giu,
  )].map((match) => match[0])
  const limitDiagnostics: string[] = []
  if (sourceBytes > resolved.maximumSourceBytes) {
    limitDiagnostics.push(
      `Source exceeds the ${resolved.maximumSourceBytes}-byte security limit.`,
    )
  }
  if (estimatedStatements > resolved.maximumStatements) {
    limitDiagnostics.push(
      `Source exceeds the ${resolved.maximumStatements}-statement security limit.`,
    )
  }
  if (maximumObservedNesting > resolved.maximumNesting) {
    limitDiagnostics.push(
      `Source exceeds the ${resolved.maximumNesting}-level nesting security limit.`,
    )
  }
  if (declaredBinaryBytes > resolved.maximumDeclaredBinaryBytes) {
    limitDiagnostics.push(
      `Declared binary resources exceed the ${resolved.maximumDeclaredBinaryBytes}-byte security limit.`,
    )
  }
  if (externalReferences.length > resolved.maximumExternalReferences) {
    limitDiagnostics.push(
      `Source exceeds the ${resolved.maximumExternalReferences}-reference external resource limit.`,
    )
  }
  const diagnostics = [...limitDiagnostics]
  if (activeContentIndicators.length > 0) {
    diagnostics.push(
      'Active PostScript operators are retained only as data and are never executed.',
    )
  }
  if (externalReferences.length > 0) {
    diagnostics.push(
      'External references require an explicit resolver policy; implicit network access is forbidden.',
    )
  }
  return {
    safeToParse: limitDiagnostics.length === 0,
    sourceBytes,
    estimatedStatements,
    maximumObservedNesting,
    declaredBinaryBytes,
    activeContentIndicators,
    externalReferences,
    diagnostics,
  }
}

export interface NativeMutationCase {
  id: string
  description: string
  bytes: Uint8Array
}

function nativeSourceBytes(source: string | Uint8Array): Uint8Array {
  if (source instanceof Uint8Array) return source.slice()
  const result = new Uint8Array(source.length)
  for (let index = 0; index < source.length; index++) {
    result[index] = source.charCodeAt(index) & 0xff
  }
  return result
}

function concatenateNativeBytes(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength)
  result.set(left)
  result.set(right, left.byteLength)
  return result
}

export function createDeterministicNativeMutations(
  source: string | Uint8Array,
  maximumCases = 64,
): readonly NativeMutationCase[] {
  if (!Number.isSafeInteger(maximumCases) || maximumCases < 0) {
    throw new RangeError(
      'maximumCases must be a non-negative safe integer.',
    )
  }
  const input = nativeSourceBytes(source)
  const cases: NativeMutationCase[] = []
  const push = (description: string, bytes: Uint8Array): void => {
    if (cases.length >= maximumCases) return
    cases.push({
      id: `mutation:${cases.length}:${nativeFNV1a(description)}`,
      description,
      bytes,
    })
  }
  push('empty input', new Uint8Array())
  push(
    'one-byte truncation',
    input.subarray(0, Math.max(0, input.length - 1)),
  )
  push('half truncation', input.subarray(0, Math.floor(input.length / 2)))
  push(
    'unterminated string prefix',
    concatenateNativeBytes(input, Uint8Array.of(0x0a, 0x28, 0x78)),
  )
  push(
    'unterminated array prefix',
    concatenateNativeBytes(input, Uint8Array.of(0x0a, 0x5b, 0x31)),
  )
  push(
    'oversized BeginData declaration',
    concatenateNativeBytes(
      input,
      nativeSourceBytes('\n%%BeginData: 999999999 Binary\n'),
    ),
  )
  push(
    'active file operator',
    concatenateNativeBytes(
      input,
      nativeSourceBytes('\n(secret) (r) file\n'),
    ),
  )
  push(
    'external URL reference',
    concatenateNativeBytes(
      input,
      nativeSourceBytes('\n(https://example.invalid/resource)\n'),
    ),
  )
  const remaining = Math.max(1, maximumCases - cases.length)
  const stride = Math.max(1, Math.floor(input.length / remaining))
  for (
    let offset = 0;
    offset < input.length && cases.length < maximumCases;
    offset += stride
  ) {
    const mutated = input.slice()
    mutated[offset] = (mutated[offset] ?? 0) ^ 0xff
    push(`bitwise byte mutation at ${offset}`, mutated)
  }
  return cases
}

export interface NativeMutationCampaignResult {
  total: number
  completed: number
  timeouts: readonly Readonly<{
    id: string
    message: string
  }>[]
}

export async function runNativeMutationCampaign(
  mutations: readonly NativeMutationCase[],
  exercise: (bytes: Uint8Array) => unknown | Promise<unknown>,
  options: Readonly<{
    signal?: AbortSignal
    timeoutMs?: number
  }> = {},
): Promise<NativeMutationCampaignResult> {
  const timeouts: { id: string; message: string }[] = []
  let completed = 0
  for (const mutation of mutations) {
    if (options.signal?.aborted === true) {
      throw new DOMException('Mutation campaign aborted.', 'AbortError')
    }
    try {
      if (options.timeoutMs === undefined) {
        await exercise(mutation.bytes)
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.resolve(exercise(mutation.bytes)),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new DOMException(
                  `Mutation ${mutation.id} timed out.`,
                  'TimeoutError',
                ))
              }, options.timeoutMs)
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        timeouts.push({ id: mutation.id, message: error.message })
      }
    }
    completed++
  }
  return {
    total: mutations.length,
    completed,
    timeouts,
  }
}

export interface NativeOracleManifest {
  schemaVersion: 1
  fixtureId: string
  illustratorVersion: string
  extension: 'ai' | 'ait'
  license: string
  sourceSha256: string
  structureOracle?: Readonly<{
    artboards?: number
    layers?: number
    groups?: number
    paths?: number
    compoundPaths?: number
    clipGroups?: number
    textFrames?: number
    rasterImages?: number
    placedArt?: number
    resources?: number
    requiredFonts?: readonly string[]
    fidelity?: NativeFidelity
  }>
  visualOracle?: Readonly<{
    renderer: string
    width: number
    height: number
    pixelSha256?: string
    channelThreshold?: number
    maximumDifferentPixelRatio?: number
    maximumMeanChannelDelta?: number
  }>
  notes?: string
}

export interface NativeStructureSnapshot {
  artboards: number
  layers: number
  groups: number
  paths: number
  compoundPaths: number
  clipGroups: number
  textFrames: number
  rasterImages: number
  placedArt: number
  resources: number
  requiredFonts: readonly string[]
  fidelity: NativeFidelity
}

export interface NativeVisualDiffResult {
  width: number
  height: number
  pixels: number
  differentPixels: number
  differentPixelRatio: number
  meanChannelDelta: number
  maximumChannelDelta: number
  passed: boolean
  diagnostics: readonly string[]
}

export interface NativeOracleEvaluation {
  fixtureId: string
  structureDiagnostics: readonly string[]
  visual?: NativeVisualDiffResult
  passed: boolean
  evidence: readonly NativeFidelityEvidence[]
}

export function validateNativeOracleManifest(
  value: unknown,
): readonly string[] {
  const diagnostics: string[] = []
  const manifest = asNativeRecord(value)
  if (manifest?.schemaVersion !== 1) {
    diagnostics.push('schemaVersion must equal 1.')
  }
  for (const field of [
    'fixtureId',
    'illustratorVersion',
    'license',
    'sourceSha256',
  ] as const) {
    const fieldValue = manifest?.[field]
    if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
      diagnostics.push(`${field} must be a non-empty string.`)
    }
  }
  if (manifest?.extension !== 'ai' && manifest?.extension !== 'ait') {
    diagnostics.push('extension must be ai or ait.')
  }
  if (
    typeof manifest?.sourceSha256 === 'string'
    && !/^[a-f0-9]{64}$/iu.test(manifest.sourceSha256)
  ) {
    diagnostics.push(
      'sourceSha256 must be a 64-character hexadecimal SHA-256 digest.',
    )
  }
  const structure = asNativeRecord(manifest?.structureOracle)
  if (structure !== undefined) {
    for (const field of [
      'artboards',
      'layers',
      'groups',
      'paths',
      'compoundPaths',
      'clipGroups',
      'textFrames',
      'rasterImages',
      'placedArt',
      'resources',
    ] as const) {
      const fieldValue = structure[field]
      if (
        fieldValue !== undefined
        && (
          !Number.isSafeInteger(fieldValue)
          || (fieldValue as number) < 0
        )
      ) {
        diagnostics.push(
          `structureOracle.${field} must be a non-negative integer.`,
        )
      }
    }
    if (
      structure.fidelity !== undefined
      && !isNativeFidelity(structure.fidelity)
    ) diagnostics.push('structureOracle.fidelity is invalid.')
    if (
      structure.requiredFonts !== undefined
      && !Array.isArray(structure.requiredFonts)
    ) {
      diagnostics.push(
        'structureOracle.requiredFonts must be an array.',
      )
    }
  }
  const visual = asNativeRecord(manifest?.visualOracle)
  if (visual !== undefined) {
    if (typeof visual.renderer !== 'string' || visual.renderer.trim() === '') {
      diagnostics.push('visualOracle.renderer is required.')
    }
    for (const field of ['width', 'height'] as const) {
      const fieldValue = visual[field]
      if (!Number.isSafeInteger(fieldValue) || (fieldValue as number) <= 0) {
        diagnostics.push(
          `visualOracle.${field} must be a positive integer.`,
        )
      }
    }
  }
  return diagnostics
}

function sceneFidelity(scene: unknown): NativeFidelity {
  const record = asNativeRecord(scene)
  return isNativeFidelity(record?.fidelity)
    ? record.fidelity
    : 'structure-only'
}

export function nativeStructureSnapshot(
  scene: unknown,
  resources?: NativeResourceGraph,
  requiredFonts: readonly string[] = [],
  artboardCount?: number,
): NativeStructureSnapshot {
  const counts = {
    layers: 0,
    groups: 0,
    paths: 0,
    compoundPaths: 0,
    clipGroups: 0,
    textFrames: 0,
    rasterImages: 0,
    placedArt: 0,
  }
  walkNativeScene(scene, (node) => {
    const type = typeof node.type === 'string'
      ? node.type
      : typeof node.kind === 'string'
        ? node.kind
        : ''
    if (type === 'Layer' || type === 'layer') counts.layers++
    else if (type === 'Group' || type === 'group') counts.groups++
    else if (type === 'Path' || type === 'path') counts.paths++
    else if (type === 'CompoundPath' || type === 'compound-path') {
      counts.compoundPaths++
    } else if (type === 'ClipGroup' || type === 'clip-group') {
      counts.clipGroups++
    } else if (type === 'Text' || type === 'text') counts.textFrames++
    else if (type === 'RasterImage' || type === 'raster-image') {
      counts.rasterImages++
    } else if (type === 'PlacedArt' || type === 'placed-art') {
      counts.placedArt++
    }
  })
  const record = asNativeRecord(scene)
  const sceneArtboards = Array.isArray(record?.artboards)
    ? record.artboards.length
    : 0
  const sceneResources = asNativeRecord(record?.resources)
  return {
    artboards: artboardCount ?? sceneArtboards,
    ...counts,
    resources: resources?.values().length
      ?? (sceneResources === undefined ? 0 : Object.keys(sceneResources).length),
    requiredFonts: [...new Set(requiredFonts)].sort(),
    fidelity: sceneFidelity(scene),
  }
}

export function compareNativeStructureOracle(
  actual: NativeStructureSnapshot,
  expected: NonNullable<NativeOracleManifest['structureOracle']>,
): readonly string[] {
  const diagnostics: string[] = []
  for (const field of [
    'artboards',
    'layers',
    'groups',
    'paths',
    'compoundPaths',
    'clipGroups',
    'textFrames',
    'rasterImages',
    'placedArt',
    'resources',
  ] as const) {
    const expectation = expected[field]
    if (expectation !== undefined && actual[field] !== expectation) {
      diagnostics.push(
        `${field}: expected ${expectation}, received ${actual[field]}.`,
      )
    }
  }
  if (expected.requiredFonts !== undefined) {
    const actualFonts = [...actual.requiredFonts].sort().join('\n')
    const expectedFonts = [...expected.requiredFonts].sort().join('\n')
    if (actualFonts !== expectedFonts) {
      diagnostics.push(
        `requiredFonts: expected [${expected.requiredFonts.join(', ')}], received [${actual.requiredFonts.join(', ')}].`,
      )
    }
  }
  if (
    expected.fidelity !== undefined
    && actual.fidelity !== expected.fidelity
  ) {
    diagnostics.push(
      `fidelity: expected ${expected.fidelity}, received ${actual.fidelity}.`,
    )
  }
  return diagnostics
}

export function compareNativeRgbaOracle(
  actual: Uint8Array,
  expected: Uint8Array,
  width: number,
  height: number,
  options: Readonly<{
    channelThreshold?: number
    maximumDifferentPixelRatio?: number
    maximumMeanChannelDelta?: number
  }> = {},
): NativeVisualDiffResult {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError('width must be a positive integer.')
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError('height must be a positive integer.')
  }
  const required = width * height * 4
  if (actual.byteLength !== required || expected.byteLength !== required) {
    throw new RangeError(
      `RGBA buffers must contain exactly ${required} bytes.`,
    )
  }
  const channelThreshold = Math.max(
    0,
    Math.min(255, options.channelThreshold ?? 8),
  )
  const maximumDifferentPixelRatio = Math.max(
    0,
    Math.min(1, options.maximumDifferentPixelRatio ?? 0.001),
  )
  const maximumMeanChannelDelta = Math.max(
    0,
    Math.min(255, options.maximumMeanChannelDelta ?? 1),
  )
  let differentPixels = 0
  let sumDelta = 0
  let maximumChannelDelta = 0
  for (let pixel = 0; pixel < width * height; pixel++) {
    let pixelDifferent = false
    for (let channel = 0; channel < 4; channel++) {
      const index = pixel * 4 + channel
      const delta = Math.abs(
        (actual[index] ?? 0) - (expected[index] ?? 0),
      )
      sumDelta += delta
      maximumChannelDelta = Math.max(maximumChannelDelta, delta)
      if (delta > channelThreshold) pixelDifferent = true
    }
    if (pixelDifferent) differentPixels++
  }
  const pixels = width * height
  const differentPixelRatio = differentPixels / pixels
  const meanChannelDelta = sumDelta / required
  const diagnostics: string[] = []
  if (differentPixelRatio > maximumDifferentPixelRatio) {
    diagnostics.push(
      `Different pixel ratio ${differentPixelRatio} exceeds ${maximumDifferentPixelRatio}.`,
    )
  }
  if (meanChannelDelta > maximumMeanChannelDelta) {
    diagnostics.push(
      `Mean channel delta ${meanChannelDelta} exceeds ${maximumMeanChannelDelta}.`,
    )
  }
  return {
    width,
    height,
    pixels,
    differentPixels,
    differentPixelRatio,
    meanChannelDelta,
    maximumChannelDelta,
    passed: diagnostics.length === 0,
    diagnostics,
  }
}

export function evaluateNativeOracle(
  manifest: NativeOracleManifest,
  actual: NativeStructureSnapshot,
  visual?: Readonly<{
    actual: Uint8Array
    expected: Uint8Array
  }>,
): NativeOracleEvaluation {
  const manifestDiagnostics = validateNativeOracleManifest(manifest)
  const structureDiagnostics = manifest.structureOracle === undefined
    ? ['No structure Oracle is declared.']
    : compareNativeStructureOracle(actual, manifest.structureOracle)
  const visualResult = manifest.visualOracle === undefined || visual === undefined
    ? undefined
    : compareNativeRgbaOracle(
        visual.actual,
        visual.expected,
        manifest.visualOracle.width,
        manifest.visualOracle.height,
        {
          ...(manifest.visualOracle.channelThreshold === undefined
            ? {}
            : {
                channelThreshold: manifest.visualOracle.channelThreshold,
              }),
          ...(manifest.visualOracle.maximumDifferentPixelRatio === undefined
            ? {}
            : {
                maximumDifferentPixelRatio:
                  manifest.visualOracle.maximumDifferentPixelRatio,
              }),
          ...(manifest.visualOracle.maximumMeanChannelDelta === undefined
            ? {}
            : {
                maximumMeanChannelDelta:
                  manifest.visualOracle.maximumMeanChannelDelta,
              }),
        },
      )
  const structurePassed = manifestDiagnostics.length === 0
    && structureDiagnostics.length === 0
  const visualPassed = manifest.visualOracle === undefined
    ? true
    : visualResult?.passed === true
  const evidence: NativeFidelityEvidence[] = [
    {
      id: `${manifest.fixtureId}:real-fixture`,
      kind: 'real-illustrator-fixture',
      status: manifestDiagnostics.length === 0 ? 'passed' : 'failed',
      versions: [manifest.illustratorVersion],
      source: manifest.fixtureId,
    },
    {
      id: `${manifest.fixtureId}:structure`,
      kind: 'structure-oracle',
      status: manifest.structureOracle === undefined
        ? 'missing'
        : structurePassed
          ? 'passed'
          : 'failed',
      versions: [manifest.illustratorVersion],
      source: manifest.fixtureId,
      notes: structureDiagnostics.join(' '),
    },
    {
      id: `${manifest.fixtureId}:visual`,
      kind: 'visual-oracle',
      status: manifest.visualOracle === undefined || visual === undefined
        ? 'missing'
        : visualPassed
          ? 'passed'
          : 'failed',
      versions: [manifest.illustratorVersion],
      source: manifest.fixtureId,
      ...(visualResult === undefined
        ? {}
        : { notes: visualResult.diagnostics.join(' ') }),
    },
  ]
  return {
    fixtureId: manifest.fixtureId,
    structureDiagnostics: [
      ...manifestDiagnostics,
      ...structureDiagnostics,
    ],
    ...(visualResult === undefined ? {} : { visual: visualResult }),
    passed: structurePassed && visualPassed,
    evidence,
  }
}

export interface NativeBenchmarkResult {
  iterations: number
  minimumMs: number
  medianMs: number
  p95Ms: number
  maximumMs: number
  meanMs: number
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  )
  return sorted[index] ?? 0
}

export async function benchmarkNativeOperation(
  operation: () => unknown | Promise<unknown>,
  iterations = 10,
  now: () => number = () => performance.now(),
): Promise<NativeBenchmarkResult> {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError('iterations must be a positive safe integer.')
  }
  const measurements: number[] = []
  for (let index = 0; index < iterations; index++) {
    const start = now()
    await operation()
    measurements.push(Math.max(0, now() - start))
  }
  measurements.sort((left, right) => left - right)
  const sum = measurements.reduce((total, value) => total + value, 0)
  return {
    iterations,
    minimumMs: measurements[0] ?? 0,
    medianMs: percentile(measurements, 0.5),
    p95Ms: percentile(measurements, 0.95),
    maximumMs: measurements[measurements.length - 1] ?? 0,
    meanMs: sum / measurements.length,
  }
}

export function performanceEvidence(
  id: string,
  result: NativeBenchmarkResult,
  maximumP95Ms: number,
): NativeFidelityEvidence {
  const passed = result.p95Ms <= maximumP95Ms
  return {
    id,
    kind: 'performance-budget',
    status: passed ? 'passed' : 'failed',
    notes: `p95=${result.p95Ms}ms, budget=${maximumP95Ms}ms`,
  }
}
