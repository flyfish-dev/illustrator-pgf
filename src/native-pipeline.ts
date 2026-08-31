import { parseIllustratorSource } from './ast.js'
import { decodeIllustratorPrivateSource } from './container.js'
import {
  asNativeRecord,
  nativeAstStatements,
} from './native-common.js'
import { extractNativeArtboards } from './native-artboards.js'
import { buildNativeAdvancedObjectModel } from './native-effects.js'
import {
  isNativeFidelity,
  resolveNativeFidelity,
  type NativeFidelity,
  type NativeFidelityDecision,
  type NativeFidelityEvidence,
} from './native-fidelity.js'
import {
  nativeStructureSnapshot,
  type NativeStructureSnapshot,
} from './native-oracle.js'
import {
  buildNativeRenderPlanV2,
  executeNativeRenderPlanV2,
  renderNativePlanToSvgV2,
  type ExecuteNativeRenderPlanV2Options,
  type NativeRenderPlanV2,
} from './native-render-plan-v2.js'
import {
  buildNativeResourceGraph,
  resolveNativeResource,
  type NativeResourceGraph,
  type NativeResourceRequest,
  type NativeResourceResolverOptions,
  type NativeResolvedResource,
} from './native-resources.js'
import { decodeNativeResources } from './native-resource-decoders.js'
import {
  ByteLruCache,
  CooperativeBudget,
} from './native-runtime.js'
import {
  scanNativeSourceSecurity,
  type NativeSecurityLimits,
  type NativeSecurityReport,
} from './native-security.js'
import { classifyNativeSourceSections } from './native-source-sections.js'
import { buildNativeTextModel } from './native-text.js'
import { buildNativeTransparencyModel } from './native-transparency.js'
import { detectIllustratorVersionProfile } from './native-version.js'
import { lowerIllustratorAst } from './semantic.js'

export type NativeDecodedSource = Awaited<
  ReturnType<typeof decodeIllustratorPrivateSource>
>
export type NativeIllustratorAst = ReturnType<typeof parseIllustratorSource>
export type NativeIllustratorScene = ReturnType<typeof lowerIllustratorAst>

export interface OpenNativeIllustratorOptions {
  decodeOptions?: Parameters<typeof decodeIllustratorPrivateSource>[1]
  parseOptions?: Parameters<typeof parseIllustratorSource>[1]
  evidence?: readonly NativeFidelityEvidence[]
  requestedFidelity?: NativeFidelity
  operationBudget?: CooperativeBudget
  resourceCacheBytes?: number
  securityLimits?: Readonly<Partial<NativeSecurityLimits>>
}

export interface NativeIllustratorAnalysis {
  decoded: NativeDecodedSource
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
  renderPlan: NativeRenderPlanV2
  security: NativeSecurityReport
  snapshot: NativeStructureSnapshot
  fidelity: NativeFidelityDecision
  diagnostics: readonly string[]
}

function requestedSceneFidelity(
  scene: NativeIllustratorScene,
): NativeFidelity {
  const record = asNativeRecord(scene)
  return isNativeFidelity(record?.fidelity)
    ? record.fidelity
    : 'structure-only'
}

function defaultEvidence(
  security: NativeSecurityReport,
): NativeFidelityEvidence[] {
  return [
    {
      id: 'package-synthetic-regression-suite',
      kind: 'synthetic-fixture',
      status: 'passed',
      source: 'tests',
      notes: 'The package regression suite covers the public native pipeline.',
    },
    {
      id: 'runtime-security-scan',
      kind: 'security-budget',
      status: security.safeToParse ? 'passed' : 'failed',
      notes: security.diagnostics.join(' '),
    },
  ]
}

export async function analyzeNativeIllustratorDocument(
  input: Uint8Array,
  options: OpenNativeIllustratorOptions = {},
): Promise<NativeIllustratorAnalysis> {
  const budget = options.operationBudget ?? new CooperativeBudget()
  budget.checkpoint()
  const decoded = await decodeIllustratorPrivateSource(
    input,
    options.decodeOptions,
  )
  budget.checkpoint(
    Math.max(1, Math.ceil(decoded.bytes.byteLength / 4096)),
  )
  const security = scanNativeSourceSecurity(
    decoded.bytes,
    options.securityLimits,
  )
  if (!security.safeToParse) {
    throw new RangeError(
      `Decoded Illustrator source violates security limits: ${security.diagnostics.join(' ')}`,
    )
  }
  const ast = parseIllustratorSource(decoded.bytes, options.parseOptions)
  budget.checkpoint(Math.max(1, nativeAstStatements(ast).length))
  const scene = lowerIllustratorAst(ast)
  budget.checkpoint()
  const profile = detectIllustratorVersionProfile(decoded.bytes)
  const artboards = extractNativeArtboards(decoded.bytes, scene)
  const sourceSections = classifyNativeSourceSections(ast)
  const resources = buildNativeResourceGraph(ast, scene)
  const decodedResources = decodeNativeResources(
    decoded.bytes,
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
  const renderPlan = buildNativeRenderPlanV2(scene)
  const snapshot = nativeStructureSnapshot(
    scene,
    resources,
    text.requiredFonts,
  )
  const requestedFidelity = options.requestedFidelity
    ?? requestedSceneFidelity(scene)
  const fidelity = resolveNativeFidelity(
    requestedFidelity,
    [
      ...defaultEvidence(security),
      ...(options.evidence ?? []),
    ],
  )
  const diagnostics = [
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
  ]
  return {
    decoded,
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
  get renderPlan(): NativeRenderPlanV2 { return this.analysis.renderPlan }
  get fidelity(): NativeFidelityDecision { return this.analysis.fidelity }

  summary(): NativeIllustratorSummary {
    const analysis = this.analysis
    return {
      versionFamily: analysis.profile.family,
      ...(analysis.profile.creator === undefined
        ? {}
        : { creator: analysis.profile.creator }),
      artboards: analysis.artboards.length,
      layers: analysis.snapshot.layers,
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

  toSvg(
    options: Parameters<typeof renderNativePlanToSvgV2>[1] = {},
  ): string {
    return renderNativePlanToSvgV2(this.renderPlan, options)
  }

  render(
    context: CanvasRenderingContext2D,
    options: ExecuteNativeRenderPlanV2Options = {},
  ): readonly string[] {
    return executeNativeRenderPlanV2(this.renderPlan, context, options)
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

  trimResourceCache(maximumBytes = 0): void {
    this.#resourceCache.resize(maximumBytes)
  }

  dispose(): void {
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
