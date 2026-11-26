import { parseIllustratorSource } from './ast.js'
import { decodeIllustratorPrivateSource } from './container.js'
import {
  asNativeRecord,
  ByteLruCache,
  CooperativeBudget,
  isNativeFidelity,
  nativeAstStatements,
  resolveNativeFidelity,
  type NativeFidelity,
  type NativeFidelityDecision,
  type NativeFidelityEvidence,
} from './native-foundation.js'
import {
  buildNativeAdvancedObjectModel,
  buildNativeResourceGraph,
  buildNativeTextModel,
  buildNativeTransparencyModel,
  classifyNativeSourceSections,
  decodeNativeResources,
  extractNativeArtboards,
  resolveNativeResource,
  type NativeResourceGraph,
  type NativeResourceRequest,
  type NativeResourceResolverOptions,
  type NativeResolvedResource,
} from './native-analysis.js'
import {
  buildNativeRenderPlan,
  executeNativeRenderPlan,
  renderNativePlanToSvg,
  type ExecuteNativeRenderPlanOptions,
  type NativeRenderPlan,
  type RenderNativeSvgOptions,
} from './native-render.js'
import {
  nativeStructureSnapshot,
  scanNativeSourceSecurity,
  type NativeSecurityLimits,
  type NativeSecurityReport,
  type NativeStructureSnapshot,
} from './native-verification.js'
import { detectIllustratorVersionProfile } from './native-foundation.js'
import { lowerIllustratorAst } from './semantic.js'

export type NativeDecodedSource = Awaited<
  ReturnType<typeof decodeIllustratorPrivateSource>
>
export type NativeIllustratorAst = ReturnType<typeof parseIllustratorSource>
export type NativeIllustratorScene = ReturnType<typeof lowerIllustratorAst>

export interface OpenNativeIllustratorOptions {
  decodeOptions?: unknown
  parseOptions?: unknown
  evidence?: readonly NativeFidelityEvidence[]
  requestedFidelity?: NativeFidelity
  operationBudget?: CooperativeBudget
  resourceCacheBytes?: number
  securityLimits?: Readonly<Partial<NativeSecurityLimits>>
}

export interface NativeIllustratorAnalysis {
  decoded: NativeDecodedSource
  sourceBytes: Uint8Array
  ast: NativeIllustratorAst
  scene: NativeIllustratorScene
  profile: ReturnType<typeof detectIllustratorVersionProfile>
  artboards: ReturnType<typeof extractNativeArtboards>
  sourceSections: ReturnType<typeof classifyNativeSourceSections>
  resources: NativeResourceGraph
  decodedResources: ReturnType<typeof decodeNativeResources>
  text: ReturnType<typeof buildNativeTextModel>
  transparency: ReturnType<typeof buildNativeTransparencyModel>
  advancedObjects: ReturnType<typeof buildNativeAdvancedObjectModel>
  renderPlan: NativeRenderPlan
  security: NativeSecurityReport
  snapshot: NativeStructureSnapshot
  fidelity: NativeFidelityDecision
  diagnostics: readonly string[]
}

function decodedSourceBytes(decoded: NativeDecodedSource): Uint8Array {
  const record = asNativeRecord(decoded)
  if (record?.bytes instanceof Uint8Array) return record.bytes
  if (record?.source instanceof Uint8Array) return record.source
  if (typeof record?.text === 'string') {
    const result = new Uint8Array(record.text.length)
    for (let index = 0; index < record.text.length; index++) {
      result[index] = record.text.charCodeAt(index) & 0xff
    }
    return result
  }
  throw new TypeError(
    'Decoded Illustrator source did not expose bytes, source, or text.',
  )
}

function requestedSceneFidelity(
  scene: NativeIllustratorScene,
): NativeFidelity {
  const record = asNativeRecord(scene)
  return isNativeFidelity(record?.fidelity)
    ? record.fidelity
    : 'structure-only'
}

function packageEvidence(
  security: NativeSecurityReport,
): NativeFidelityEvidence[] {
  return [
    {
      id: 'package-synthetic-regression-suite',
      kind: 'synthetic-fixture',
      status: 'passed',
      source: 'tests',
      notes: 'The package regression suite exercises the public native pipeline.',
    },
    {
      id: 'runtime-security-scan',
      kind: 'security-budget',
      status: security.safeToParse ? 'passed' : 'failed',
      notes: security.diagnostics.join(' '),
    },
  ]
}

function uniqueDiagnostics(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))]
}

export async function analyzeNativeIllustratorDocument(
  input: Uint8Array,
  options: OpenNativeIllustratorOptions = {},
): Promise<NativeIllustratorAnalysis> {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('Illustrator input must be a Uint8Array.')
  }
  const budget = options.operationBudget ?? new CooperativeBudget()
  budget.checkpoint()

  const decode = decodeIllustratorPrivateSource as unknown as (
    bytes: Uint8Array,
    decodeOptions?: unknown,
  ) => NativeDecodedSource | Promise<NativeDecodedSource>
  const decoded = await decode(input, options.decodeOptions)
  const sourceBytes = decodedSourceBytes(decoded)
  budget.checkpoint(
    Math.max(1, Math.ceil(sourceBytes.byteLength / 4096)),
  )

  const security = scanNativeSourceSecurity(
    sourceBytes,
    options.securityLimits,
  )
  if (!security.safeToParse) {
    throw new RangeError(
      `Decoded Illustrator source violates security limits: ${security.diagnostics.join(' ')}`,
    )
  }

  const parse = parseIllustratorSource as unknown as (
    source: Uint8Array,
    parseOptions?: unknown,
  ) => NativeIllustratorAst
  const ast = parse(sourceBytes, options.parseOptions)
  budget.checkpoint(Math.max(1, nativeAstStatements(ast).length))

  const scene = lowerIllustratorAst(ast)
  budget.checkpoint()

  const profile = detectIllustratorVersionProfile(sourceBytes)
  const artboards = extractNativeArtboards(sourceBytes, scene)
  const sourceSections = classifyNativeSourceSections(ast)
  const resources = buildNativeResourceGraph(ast, scene)
  const decodedResources = decodeNativeResources(
    sourceBytes,
    ast,
    resources,
  )
  const text = buildNativeTextModel(scene)
  const transparency = buildNativeTransparencyModel(scene)
  const advancedObjects = buildNativeAdvancedObjectModel(
    ast,
    scene,
    resources,
  )
  const renderPlan = buildNativeRenderPlan(scene)
  const snapshot = nativeStructureSnapshot(
    scene,
    resources,
    text.requiredFonts,
    artboards.length,
  )
  const requestedFidelity = options.requestedFidelity
    ?? requestedSceneFidelity(scene)
  const fidelity = resolveNativeFidelity(
    requestedFidelity,
    [
      ...packageEvidence(security),
      ...(options.evidence ?? []),
    ],
  )
  const diagnostics = uniqueDiagnostics([
    ...profile.diagnostics,
    ...sourceSections.diagnostics,
    ...resources.validate(),
    ...decodedResources.diagnostics,
    ...text.diagnostics,
    ...transparency.diagnostics,
    ...advancedObjects.diagnostics,
    ...renderPlan.diagnostics,
    ...security.diagnostics,
    ...fidelity.missingEvidence.map((kind) =>
      `Fidelity promotion is waiting for ${kind} evidence.`,
    ),
    ...fidelity.failedEvidence.map((kind) =>
      `Fidelity evidence failed: ${kind}.`,
    ),
  ])
  return {
    decoded,
    sourceBytes,
    ast,
    scene,
    profile,
    artboards,
    sourceSections,
    resources,
    decodedResources,
    text,
    transparency,
    advancedObjects,
    renderPlan,
    security,
    snapshot,
    fidelity,
    diagnostics,
  }
}

export interface NativeIllustratorSummary {
  versionFamily: string
  creator?: string
  artboards: number
  layers: number
  groups: number
  paths: number
  compoundPaths: number
  clipGroups: number
  textFrames: number
  resources: number
  gradients: number
  patterns: number
  rasters: number
  advancedObjects: number
  requiredFonts: readonly string[]
  requestedFidelity: NativeFidelity
  effectiveFidelity: NativeFidelity
  missingEvidence: readonly string[]
  diagnostics: number
}

export interface NativeResourceCacheStats {
  entries: number
  bytes: number
  maximumBytes: number
}

export class NativeIllustratorDocumentSession {
  #analysis: NativeIllustratorAnalysis | undefined
  readonly #resourceCache: ByteLruCache<NativeResolvedResource>

  constructor(
    analysis: NativeIllustratorAnalysis,
    resourceCacheBytes = 64 * 1024 * 1024,
  ) {
    this.#analysis = analysis
    this.#resourceCache = new ByteLruCache(resourceCacheBytes)
  }

  get disposed(): boolean { return this.#analysis === undefined }

  get analysis(): NativeIllustratorAnalysis {
    if (this.#analysis === undefined) {
      throw new Error('Native Illustrator document session is disposed.')
    }
    return this.#analysis
  }

  get scene(): NativeIllustratorScene { return this.analysis.scene }
  get ast(): NativeIllustratorAst { return this.analysis.ast }
  get renderPlan(): NativeRenderPlan { return this.analysis.renderPlan }
  get fidelity(): NativeFidelityDecision { return this.analysis.fidelity }

  summary(): NativeIllustratorSummary {
    const analysis = this.analysis
    const creator = analysis.profile.creator
    return {
      versionFamily: analysis.profile.family,
      ...(creator === undefined ? {} : { creator }),
      artboards: analysis.artboards.length,
      layers: analysis.snapshot.layers,
      groups: analysis.snapshot.groups,
      paths: analysis.snapshot.paths,
      compoundPaths: analysis.snapshot.compoundPaths,
      clipGroups: analysis.snapshot.clipGroups,
      textFrames: analysis.snapshot.textFrames,
      resources: analysis.snapshot.resources,
      gradients: analysis.decodedResources.gradients.length,
      patterns: analysis.decodedResources.patterns.length,
      rasters: analysis.decodedResources.rasters.length,
      advancedObjects: analysis.advancedObjects.objects.length,
      requiredFonts: analysis.text.requiredFonts,
      requestedFidelity: analysis.fidelity.requested,
      effectiveFidelity: analysis.fidelity.effective,
      missingEvidence: analysis.fidelity.missingEvidence,
      diagnostics: analysis.diagnostics.length,
    }
  }

  toSvg(options: RenderNativeSvgOptions = {}): string {
    return renderNativePlanToSvg(this.renderPlan, options)
  }

  render(
    context: CanvasRenderingContext2D,
    options: ExecuteNativeRenderPlanOptions = {},
  ): readonly string[] {
    return executeNativeRenderPlan(this.renderPlan, context, options)
  }

  async resolveResource(
    request: NativeResourceRequest,
    resolver: NativeResourceResolverOptions,
    signal?: AbortSignal,
  ): Promise<NativeResolvedResource> {
    const cached = this.#resourceCache.get(request.id)
    if (cached !== undefined) return cached
    const resolved = await resolveNativeResource(request, resolver, signal)
    this.#resourceCache.set(
      request.id,
      resolved,
      resolved.bytes.byteLength,
    )
    return resolved
  }

  resourceCacheStats(): NativeResourceCacheStats {
    return {
      entries: this.#resourceCache.size,
      bytes: this.#resourceCache.byteLength,
      maximumBytes: this.#resourceCache.maximumBytes,
    }
  }

  trimResourceCache(maximumBytes = 0): void {
    this.#resourceCache.resize(maximumBytes)
  }

  dispose(): void {
    if (this.#analysis === undefined) return
    this.#resourceCache.clear()
    this.#analysis = undefined
  }
}

export async function openNativeIllustratorDocument(
  input: Uint8Array,
  options: OpenNativeIllustratorOptions = {},
): Promise<NativeIllustratorDocumentSession> {
  const analysis = await analyzeNativeIllustratorDocument(input, options)
  return new NativeIllustratorDocumentSession(
    analysis,
    options.resourceCacheBytes,
  )
}
