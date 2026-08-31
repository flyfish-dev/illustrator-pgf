import type {
  Bounds,
  IllustratorAppearance,
  IllustratorArtboard,
  IllustratorAstOperatorStatement,
  IllustratorAstStatement,
  IllustratorAstValue,
  IllustratorDiagnostic,
  IllustratorFidelity,
  IllustratorGroupNode,
  IllustratorLayerNode,
  IllustratorLosslessAst,
  IllustratorOpaqueResource,
  IllustratorPaint,
  IllustratorPathNode,
  IllustratorSceneDocument,
  IllustratorSceneNode,
  IllustratorTextNode,
  IllustratorTextRun,
  IllustratorUnsupportedFeature,
  IllustratorVersionFingerprint,
  LowerOptions,
  Matrix,
  PathContour,
  PathGeometry,
  Point,
  SourceSpan,
  StrokeStyle,
} from './types.js'
import { IllustratorError, diagnostic } from './errors.js'
import { resolveLimits } from './limits.js'
import { BLACK_PAINT, NONE_PAINT, cloneMatrix, emptyAppearance, lowerFidelity, validateIllustratorScene } from './scene.js'
import { IDENTITY_MATRIX, WorkBudget, boundsFromPoints, clamp, multiplyMatrix, stableId, transformPoint, unionBounds } from './util.js'
import { reconstructIllustratorSourceText } from './ast.js'

export type IllustratorOperandKind = 'number' | 'boolean' | 'string' | 'name' | 'array' | 'dictionary' | 'data' | 'any'
export interface IllustratorOperatorDefinition {
  operator: string
  family: 'base' | 'ai3' | 'ai5' | 'ai7' | 'ai8' | 'ai9' | 'ai10' | 'ai11-text' | 'ai12' | 'ai14' | 'ai17' | 'ai24'
  minVersion?: number
  maxVersion?: number
  operands: readonly IllustratorOperandKind[]
  variadic?: boolean
  stateReads: readonly string[]
  stateWrites: readonly string[]
  produces: 'scene' | 'resource' | 'metadata' | 'fallback' | 'none'
  fidelity: IllustratorFidelity
  fixtureId: string
  handler: (context: OperatorContext) => void
}

export interface IllustratorOperatorCoverageEntry extends Omit<IllustratorOperatorDefinition, 'handler'> {}

export class IllustratorOperatorRegistry {
  private readonly definitions = new Map<string, IllustratorOperatorDefinition[]>()
  register(definition: IllustratorOperatorDefinition): this {
    const entries = this.definitions.get(definition.operator) ?? []
    entries.push(definition)
    entries.sort((a, b) => (b.minVersion ?? -Infinity) - (a.minVersion ?? -Infinity))
    this.definitions.set(definition.operator, entries)
    return this
  }
  resolve(operator: string, version?: number): IllustratorOperatorDefinition | undefined {
    const entries = this.definitions.get(operator)
    if (entries === undefined) return undefined
    return entries.find((entry) => (version === undefined || entry.minVersion === undefined || version >= entry.minVersion) && (version === undefined || entry.maxVersion === undefined || version <= entry.maxVersion))
  }
  coverage(): readonly IllustratorOperatorCoverageEntry[] {
    return [...this.definitions.values()].flat().map(({ handler: _handler, ...entry }) => entry).sort((a, b) => a.operator.localeCompare(b.operator) || a.family.localeCompare(b.family))
  }
}

interface GraphicsState {
  transform: Matrix
  fill: IllustratorPaint
  stroke: IllustratorPaint
  lineWidth: number
  lineCap: StrokeStyle['cap']
  lineJoin: StrokeStyle['join']
  miterLimit: number
  dashArray: number[]
  dashOffset: number
  fillOpacity: number
  strokeOpacity: number
  opacity: number
  blendMode: string
  overprintFill: boolean
  overprintStroke: boolean
  fillRule: PathGeometry['fillRule']
}
interface MutableContour { start: Point; segments: PathContour['segments'] extends readonly (infer T)[] ? T[] : never; closed: boolean }
interface MutablePath { contours: MutableContour[]; current?: MutableContour; startedAt?: SourceSpan; statementIndices: number[] }
interface ContainerFrame { node?: IllustratorGroupNode | IllustratorLayerNode; children: IllustratorSceneNode[]; layerId?: string }
interface SavedState { state: GraphicsState; containerDepth: number }
interface TextContext {
  kind: IllustratorTextNode['textKind']
  direction: IllustratorTextNode['direction']
  matrix: Matrix
  position: Point
  runs: IllustratorTextRun[]
  font?: string
  fontSize: number
  statementIndices: number[]
  startSpan: SourceSpan
}
interface CompoundContext {
  contours: PathContour[]
  statementIndices: number[]
  startSpan: SourceSpan
  ready: boolean
  fill: boolean
  stroke: boolean
  fillRule: PathGeometry['fillRule']
}
interface ResourceCapture { kind: IllustratorOpaqueResource['kind']; id: string; name?: string; raw: string[]; startSpan: SourceSpan; fidelity: IllustratorFidelity }
interface UnsupportedAccumulator { count: number; visible: boolean; fidelity: IllustratorFidelity; statementIndices: number[]; diagnostics: string[] }

interface OperatorContext {
  builder: SceneBuilder
  statement: IllustratorAstOperatorStatement
  statementIndex: number
  operands: readonly IllustratorAstValue[]
}

function numberValue(value: IllustratorAstValue | undefined): number | undefined { return value?.kind === 'number' ? value.value : undefined }
function stringValue(value: IllustratorAstValue | undefined): string | undefined { return value?.kind === 'string' ? value.value : value?.kind === 'name' ? value.value : undefined }
function numberArray(value: IllustratorAstValue | undefined): number[] | undefined {
  if (value?.kind !== 'array') return undefined
  const values = value.values.map(numberValue)
  return values.some((entry) => entry === undefined) ? undefined : values as number[]
}
function tailNumbers(operands: readonly IllustratorAstValue[], count: number): number[] | undefined {
  if (operands.length < count) return undefined
  const values = operands.slice(-count).map(numberValue)
  return values.some((value) => value === undefined) ? undefined : values as number[]
}
function tailString(operands: readonly IllustratorAstValue[]): string | undefined { return stringValue(operands.at(-1)) }
function clonePaint(paint: IllustratorPaint): IllustratorPaint { return structuredClone(paint) as IllustratorPaint }
function cloneState(state: GraphicsState): GraphicsState { return { ...state, transform: cloneMatrix(state.transform), fill: clonePaint(state.fill), stroke: clonePaint(state.stroke), dashArray: [...state.dashArray] } }

function decodePsString(value: string): string {
  return value.replace(/\\([nrtbf()\\]|[0-7]{1,3})/gu, (_whole, escape: string) => {
    if (/^[0-7]+$/u.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8))
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[escape] ?? escape
  })
}

function extractArtboards(source: string): IllustratorArtboard[] {
  const result: IllustratorArtboard[] = []
  for (const match of source.matchAll(/^%AIArtboard\s*:\s*([^|\r\n]+)\|\s*([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)/gimu)) {
    const left = Number(match[2]); const bottom = Number(match[3]); const right = Number(match[4]); const top = Number(match[5])
    if ([left,bottom,right,top].every(Number.isFinite)) result.push({ id: stableId('artboard', result.length), name: match[1]!.trim(), bounds: { left: Math.min(left,right), bottom: Math.min(bottom,top), right: Math.max(left,right), top: Math.max(bottom,top) }, bleed: { top: 0, right: 0, bottom: 0, left: 0 }, rulerOrigin: { x: 0, y: 0 }, selected: result.length === 0, locked: false, pixelAspectRatio: 1 })
  }
  const arrayAt = source.indexOf('(ArtboardArray)')
  if (result.length === 0 && arrayAt >= 0) {
    const prefix = source.slice(Math.max(0, arrayAt - 512 * 1024), arrayAt)
    const chunks = prefix.split(/%_?\s*\/Dictionary\s*:/u)
    const number = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`
    for (const chunk of chunks) {
      const point = (name: string): RegExp => new RegExp(`(${number})\\s+(${number})\\s+/RealPointRelToROrigin[\\s%_]*\\(${name}\\)`, 'u')
      const first = point('PositionPoint1').exec(chunk)
      const second = point('PositionPoint2').exec(chunk)
      const name = /\(((?:\\.|[^\\)])*)\)\s+\/UnicodeString\s+\(Name\)/u.exec(chunk)
      if (first === null || second === null || name === null) continue
      const x1 = Number(first[1]); const y1 = Number(first[2]); const x2 = Number(second[1]); const y2 = Number(second[2])
      if (![x1,y1,x2,y2].every(Number.isFinite)) continue
      result.push({ id: stableId('artboard', result.length), name: decodePsString(name[1]!), bounds: { left: Math.min(x1,x2), bottom: Math.min(y1,y2), right: Math.max(x1,x2), top: Math.max(y1,y2) }, bleed: { top: 0, right: 0, bottom: 0, left: 0 }, rulerOrigin: { x: 0, y: 0 }, selected: result.length === 0, locked: false, pixelAspectRatio: 1 })
    }
  }
  if (result.length === 0) {
    const match = /%%HiResBoundingBox\s*:\s*([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)/iu.exec(source) ?? /%%BoundingBox\s*:\s*([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)/iu.exec(source)
    if (match !== null) {
      const values = match.slice(1).map(Number)
      if (values.every(Number.isFinite)) result.push({ id: 'artboard-0', name: 'Artboard 1', bounds: { left: values[0]!, bottom: values[1]!, right: values[2]!, top: values[3]! }, bleed: { top: 0, right: 0, bottom: 0, left: 0 }, rulerOrigin: { x: 0, y: 0 }, selected: true, locked: false, pixelAspectRatio: 1 })
    }
  }
  return result
}

class SceneBuilder {
  readonly diagnostics: IllustratorDiagnostic[]
  readonly resources: Record<string, IllustratorOpaqueResource> = {}
  readonly layers: IllustratorLayerNode[] = []
  readonly rootChildren: IllustratorSceneNode[] = []
  readonly containers: ContainerFrame[] = [{ children: this.rootChildren }]
  readonly savedStates: SavedState[] = []
  readonly unsupported = new Map<string, UnsupportedAccumulator>()
  state: GraphicsState = {
    transform: cloneMatrix(), fill: BLACK_PAINT, stroke: NONE_PAINT,
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    dashArray: [], dashOffset: 0, fillOpacity: 1, strokeOpacity: 1, opacity: 1,
    blendMode: 'normal', overprintFill: false, overprintStroke: false, fillRule: 'nonzero',
  }
  path: MutablePath = { contours: [], statementIndices: [] }
  text?: TextContext
  compound?: CompoundContext
  pendingClipRule?: PathGeometry['fillRule']
  resourceCapture?: ResourceCapture
  contentActive = true
  colorMode: IllustratorSceneDocument['colorMode'] = 'unknown'
  fidelity: IllustratorFidelity = 'high'
  nodeCounter = 0
  resourceCounter = 0
  statementIndex = -1

  constructor(
    readonly ast: IllustratorLosslessAst,
    readonly source: string,
    readonly fingerprint: IllustratorVersionFingerprint,
    readonly limits: ReturnType<typeof resolveLimits>,
    readonly budget: WorkBudget,
  ) { this.diagnostics = [...ast.diagnostics] }

  build(registry: IllustratorOperatorRegistry): IllustratorSceneDocument {
    const futureMarkers = this.fingerprint.featureMarkers.map((marker) => Number(/%AI(\d+)/u.exec(marker)?.[1])).filter((value) => Number.isFinite(value) && value > 24)
    if (futureMarkers.length > 0) {
      this.fidelity = lowerFidelity(this.fidelity, 'partial')
      this.diagnostics.push(diagnostic('AI_FUTURE_VERSION', 'warning', 'lower', `Unknown future Illustrator format marker(s): ${futureMarkers.join(', ')}. Unknown extensions will remain opaque.`))
    }
    for (let index = 0; index < this.ast.statements.length; index++) {
      this.budget.checkpoint('lower')
      this.statementIndex = index
      const statement = this.ast.statements[index]!
      if (statement.kind === 'comment') { this.handleComment(statement.raw); continue }
      if (statement.kind === 'resource') {
        this.captureRaw(statement.raw)
        const id = stableId('binary-resource', this.resourceCounter++)
        this.resources[id] = { id, kind: 'unknown', raw: statement.raw, metadata: { bytes: statement.value.byteLength }, fidelity: 'structure-only', sourceSpan: statement.span }
        this.markUnsupported('binary-resource', false, 'structure-only', index, 'Binary resource is preserved but has no registered semantic decoder.')
        continue
      }
      if (statement.kind !== 'operator') continue
      this.captureRaw(statement.raw)
      const definition = registry.resolve(statement.operator, this.fingerprint.creatorVersion)
      if (definition === undefined) { this.handleUnknownOperator(statement, index); continue }
      if (statement.operands.length < definition.operands.length && !definition.variadic) {
        this.diagnostics.push(diagnostic('AI_OPERATOR_OPERANDS', 'warning', 'parse', `Operator ${statement.operator} expects at least ${definition.operands.length} operand(s), received ${statement.operands.length}.`, { sourceSpan: statement.span, feature: statement.operator }))
      }
      try { definition.handler({ builder: this, statement, statementIndex: index, operands: statement.operands }) }
      catch (error) {
        this.diagnostics.push(diagnostic('AI_OPERATOR_HANDLER_FAILED', 'error', 'lower', `Operator ${statement.operator} could not be lowered: ${error instanceof Error ? error.message : String(error)}`, { sourceSpan: statement.span, feature: statement.operator }))
        this.handleUnknownOperator(statement, index)
      }
    }
    this.flushPath(false, false, this.state.fillRule, this.ast.statements.at(-1)?.span)
    if (this.compound !== undefined) this.emitCompound(this.compound.fill, this.compound.stroke, this.compound.fillRule, this.ast.statements.at(-1)?.span)
    if (this.text !== undefined) this.endText(this.ast.statements.at(-1)?.span)
    while (this.containers.length > 1) {
      const frame = this.containers.pop()!
      this.diagnostics.push(diagnostic('AI_HIERARCHY_UNCLOSED', 'warning', 'lower', `Unclosed ${frame.node?.type ?? 'container'} was closed at end of source.`, { nodeId: frame.node?.id }))
    }
    while (this.savedStates.length > 0) {
      this.savedStates.pop()
      this.diagnostics.push(diagnostic('AI_GSTATE_UNCLOSED', 'warning', 'lower', 'Unclosed graphics-state save was discarded at end of source.'))
    }
    const artboards = extractArtboards(this.source)
    const bounds = this.computeAllBounds()
    if (artboards.length === 0 && bounds !== undefined) artboards.push({ id: 'artboard-0', name: 'Artboard 1', bounds, bleed: { top: 0, right: 0, bottom: 0, left: 0 }, rulerOrigin: { x: 0, y: 0 }, selected: true, locked: false, pixelAspectRatio: 1 })
    const unsupportedFeatures: IllustratorUnsupportedFeature[] = [...this.unsupported.entries()].map(([feature, value]) => ({ feature, count: value.count, visible: value.visible, fidelity: value.fidelity, statementIndices: value.statementIndices, diagnostics: value.diagnostics })).sort((a, b) => a.feature.localeCompare(b.feature))
    const largeCanvasScale = Number(/(?:LargeCanvasScale|largeCanvasScale)\D+([\d.]+)/iu.exec(this.source)?.[1] ?? 1)
    const document: IllustratorSceneDocument = {
      format: 'adobe-illustrator.scene', schemaVersion: 1, unit: 'pt', coordinateSystem: 'illustrator-y-up',
      largeCanvasScale: Number.isFinite(largeCanvasScale) && largeCanvasScale > 0 ? largeCanvasScale : 1,
      colorMode: this.colorMode,
      metadata: this.extractMetadata(),
      artboards,
      layers: this.layers,
      children: this.rootChildren,
      resources: this.resources,
      diagnostics: this.diagnostics,
      unsupportedFeatures,
      sourceFingerprint: this.fingerprint,
      fidelity: unsupportedFeatures.reduce((current, feature) => lowerFidelity(current, feature.fidelity), this.fidelity),
    }
    validateIllustratorScene(document)
    return document
  }

  private extractMetadata(): Record<string, string | number | boolean> {
    const output: Record<string, string | number | boolean> = {}
    for (const name of ['Title', 'Creator', 'For', 'CreationDate', 'DocumentData', 'LanguageLevel']) {
      const value = new RegExp(`^%%${name}\\s*:\\s*([^\\r\\n]+)`, 'imu').exec(this.source)?.[1]?.trim()
      if (value !== undefined) output[name] = value
    }
    return output
  }

  private currentFrame(): ContainerFrame { return this.containers[this.containers.length - 1]! }
  private currentLayerId(): string | undefined { return this.currentFrame().layerId }

  private nodeBase(span: SourceSpan | undefined, appearance: IllustratorAppearance, fidelity: IllustratorFidelity, statementIndices: readonly number[], parentOverride?: string): Omit<IllustratorSceneNode, 'type'> {
    const frame = this.currentFrame()
    const parentId = parentOverride ?? frame.node?.id
    return {
      id: stableId('node', this.nodeCounter++),
      ...(span === undefined ? {} : { sourceSpan: span }),
      ...(parentId === undefined ? {} : { parentId }),
      ...(this.currentLayerId() === undefined ? {} : { layerId: this.currentLayerId() }),
      transform: cloneMatrix(this.state.transform), visible: true, locked: false, printable: true,
      appearance, fidelity, diagnostics: [], rawStatementIndices: [...statementIndices],
    } as Omit<IllustratorSceneNode, 'type'>
  }

  addNode(node: IllustratorSceneNode): void {
    this.budget.consume('nodes', 1, this.limits.maxNodes, 'lower')
    this.currentFrame().children.push(node)
  }

  beginGroup(kind: 'Group' | 'ClipGroup', span: SourceSpan, statementIndex: number): IllustratorGroupNode {
    const appearance = emptyAppearance()
    appearance.opacity = this.state.opacity; appearance.blendMode = this.state.blendMode
    const node = { ...this.nodeBase(span, appearance, 'high', [statementIndex]), type: kind, children: [], isolated: false, knockout: false } as IllustratorGroupNode
    this.addNode(node)
    this.containers.push({ node, children: node.children, layerId: this.currentLayerId() })
    return node
  }

  endContainer(expected: readonly IllustratorSceneNode['type'][], span: SourceSpan): void {
    for (let index = this.containers.length - 1; index > 0; index--) {
      const frame = this.containers[index]!
      if (frame.node !== undefined && expected.includes(frame.node.type)) {
        while (this.containers.length - 1 >= index) this.containers.pop()
        return
      }
    }
    this.diagnostics.push(diagnostic('AI_HIERARCHY_UNDERFLOW', 'warning', 'lower', `No open ${expected.join('/')} exists for closing operator.`, { sourceSpan: span }))
  }

  moveTo(point: Point, span: SourceSpan, statementIndex: number): void {
    const contour: MutableContour = { start: point, segments: [], closed: false }
    this.path.contours.push(contour); this.path.current = contour
    this.path.startedAt ??= span; this.path.statementIndices.push(statementIndex)
    this.budget.consume('pathPoints', 1, this.limits.maxPathPoints, 'lower')
  }

  lineTo(point: Point, span: SourceSpan, statementIndex: number): void {
    const contour = this.ensureContour(span, statementIndex)
    contour.segments.push({ kind: 'line', to: point })
    this.path.statementIndices.push(statementIndex)
    this.budget.consume('pathPoints', 1, this.limits.maxPathPoints, 'lower')
  }

  cubicTo(control1: Point, control2: Point, point: Point, span: SourceSpan, statementIndex: number): void {
    const contour = this.ensureContour(span, statementIndex)
    contour.segments.push({ kind: 'cubic', control1, control2, to: point })
    this.path.statementIndices.push(statementIndex)
    this.budget.consume('pathPoints', 3, this.limits.maxPathPoints, 'lower')
  }

  closePath(statementIndex: number): void {
    if (this.path.current === undefined) return
    this.path.current.closed = true
    this.path.statementIndices.push(statementIndex)
  }

  currentPoint(): Point {
    const contour = this.path.current
    if (contour === undefined) return { x: 0, y: 0 }
    return contour.segments.at(-1)?.to ?? contour.start
  }

  markClip(rule: PathGeometry['fillRule']): void { this.pendingClipRule = rule }

  beginCompound(span: SourceSpan, statementIndex: number): void {
    if (this.compound !== undefined) {
      this.diagnostics.push(diagnostic('AI_COMPOUND_NESTED', 'warning', 'lower', 'Nested compound-path start was preserved as unsupported.', { sourceSpan: span }))
      this.markUnsupported('nested-compound-path', true, 'partial', statementIndex, 'Nested compound path requires version-specific recovery.')
      return
    }
    this.compound = { contours: [], statementIndices: [statementIndex], startSpan: span, ready: false, fill: false, stroke: false, fillRule: this.state.fillRule }
  }

  endCompound(span: SourceSpan, statementIndex: number): void {
    if (this.compound === undefined) {
      this.diagnostics.push(diagnostic('AI_COMPOUND_UNDERFLOW', 'warning', 'lower', 'Compound-path end has no matching start.', { sourceSpan: span }))
      return
    }
    this.appendPathToCompound(false, false, this.state.fillRule)
    this.compound.statementIndices.push(statementIndex)
    this.compound.ready = true
  }

  flushPath(fill: boolean, stroke: boolean, fillRule: PathGeometry['fillRule'], span?: SourceSpan): void {
    if (this.compound?.ready === true) {
      this.compound.fill ||= fill; this.compound.stroke ||= stroke; this.compound.fillRule = fillRule
      this.emitCompound(this.compound.fill, this.compound.stroke, fillRule, span)
      return
    }
    if (this.compound !== undefined) {
      this.appendPathToCompound(fill, stroke, fillRule)
      return
    }
    if (this.path.contours.length === 0) return
    const geometry: PathGeometry = { contours: this.path.contours.map((contour) => ({ start: { ...contour.start }, segments: contour.segments.map((segment) => structuredClone(segment)), closed: contour.closed })), fillRule }
    const statementIndices = [...new Set(this.path.statementIndices)]
    const sourceSpan = this.path.startedAt === undefined ? span : { start: this.path.startedAt.start, end: (span ?? this.path.startedAt).end }
    const clipping = this.pendingClipRule !== undefined
    this.path = { contours: [], statementIndices: [] }
    if (!this.contentActive) { this.pendingClipRule = undefined; return }
    if (clipping) {
      const group = this.beginGroup('ClipGroup', sourceSpan ?? span!, statementIndices.at(-1) ?? this.statementIndex)
      const node = this.createPathNode(geometry, false, false, sourceSpan, statementIndices, true)
      group.appearance.clippingMask = node.id
      this.addNode(node)
      this.pendingClipRule = undefined
      return
    }
    const node = this.createPathNode(geometry, fill, stroke, sourceSpan, statementIndices, false)
    this.addNode(node)
  }

  private appendPathToCompound(fill: boolean, stroke: boolean, fillRule: PathGeometry['fillRule']): void {
    if (this.compound === undefined || this.path.contours.length === 0) return
    this.compound.contours.push(...this.path.contours.map((contour) => ({ start: { ...contour.start }, segments: contour.segments.map((segment) => structuredClone(segment)), closed: contour.closed })))
    this.compound.statementIndices.push(...this.path.statementIndices)
    this.compound.fill ||= fill; this.compound.stroke ||= stroke; this.compound.fillRule = fillRule
    this.path = { contours: [], statementIndices: [] }
  }

  private emitCompound(fill: boolean, stroke: boolean, fillRule: PathGeometry['fillRule'], span?: SourceSpan): void {
    const compound = this.compound
    if (compound === undefined) return
    this.appendPathToCompound(fill, stroke, fillRule)
    this.compound = undefined
    if (compound.contours.length === 0 || !this.contentActive) return
    const sourceSpan = { start: compound.startSpan.start, end: (span ?? compound.startSpan).end }
    const node = this.createPathNode({ contours: compound.contours, fillRule }, fill, stroke, sourceSpan, [...new Set(compound.statementIndices)], false, true)
    this.addNode(node)
  }

  private ensureContour(span: SourceSpan, statementIndex: number): MutableContour {
    if (this.path.current !== undefined) return this.path.current
    this.diagnostics.push(diagnostic('AI_PATH_IMPLICIT_MOVE', 'warning', 'lower', 'Path segment appeared before move; an implicit move to (0,0) was inserted.', { sourceSpan: span }))
    this.moveTo({ x: 0, y: 0 }, span, statementIndex)
    return this.path.current!
  }

  private appearance(fill: boolean, stroke: boolean): IllustratorAppearance {
    const appearance = emptyAppearance()
    if (fill && this.state.fill.kind !== 'none') appearance.fills = [{ paint: clonePaint(this.state.fill), opacity: this.state.fillOpacity, overprint: this.state.overprintFill }]
    if (stroke && this.state.stroke.kind !== 'none') appearance.strokes = [{ paint: clonePaint(this.state.stroke), width: this.state.lineWidth, alignment: 'center', cap: this.state.lineCap, join: this.state.lineJoin, miterLimit: this.state.miterLimit, dashArray: [...this.state.dashArray], dashOffset: this.state.dashOffset, opacity: this.state.strokeOpacity, overprint: this.state.overprintStroke }]
    appearance.opacity = this.state.opacity; appearance.blendMode = this.state.blendMode
    return appearance
  }

  private createPathNode(geometry: PathGeometry, fill: boolean, stroke: boolean, span: SourceSpan | undefined, statementIndices: readonly number[], clipping: boolean, forceCompound = false): IllustratorPathNode {
    const points: Point[] = []
    for (const contour of geometry.contours) {
      points.push(transformPoint(this.state.transform, contour.start))
      for (const segment of contour.segments) {
        if (segment.kind === 'cubic') { points.push(transformPoint(this.state.transform, segment.control1), transformPoint(this.state.transform, segment.control2)) }
        points.push(transformPoint(this.state.transform, segment.to))
      }
    }
    const node = {
      ...this.nodeBase(span, this.appearance(fill, stroke), 'high', statementIndices),
      type: forceCompound || geometry.contours.length > 1 ? 'CompoundPath' : 'Path',
      geometry,
      paintPath: fill || stroke,
      clippingPath: clipping,
      bounds: boundsFromPoints(points),
      visible: clipping || fill || stroke,
    } as IllustratorPathNode
    return node
  }

  saveGraphicsState(): void { this.savedStates.push({ state: cloneState(this.state), containerDepth: this.containers.length }) }
  restoreGraphicsState(span: SourceSpan): void {
    const saved = this.savedStates.pop()
    if (saved === undefined) { this.diagnostics.push(diagnostic('AI_GSTATE_UNDERFLOW', 'warning', 'lower', 'Graphics-state restore has no matching save.', { sourceSpan: span })); return }
    this.state = saved.state
    while (this.containers.length > saved.containerDepth) this.containers.pop()
  }

  concatTransform(matrix: Matrix): void { this.state.transform = multiplyMatrix(this.state.transform, matrix) }
  setTransform(matrix: Matrix): void { this.state.transform = cloneMatrix(matrix) }

  beginLayer(operands: readonly IllustratorAstValue[], span: SourceSpan, statementIndex: number): void {
    const extended = operands.slice(-14).map(numberValue)
    const compact = operands.slice(-10).map(numberValue)
    const extendedValid = extended.length === 14 && extended.every((value) => value !== undefined)
    const compactValid = compact.length === 10 && compact.every((value) => value !== undefined)
    const valid = extendedValid || compactValid
    const flags = extendedValid ? extended as number[] : compactValid ? compact as number[] : [1, 1, 1, 1, 0, 0, 0, 79, 128, 255]
    const colorOffset = extendedValid ? 8 : 7
    if (!valid) this.diagnostics.push(diagnostic('AI_LAYER_FLAGS_INVALID', 'warning', 'lower', 'Layer flags were incomplete; safe defaults were used.', { sourceSpan: span }))
    const appearance = emptyAppearance()
    const node = {
      ...this.nodeBase(span, appearance, 'high', [statementIndex]),
      type: 'Layer', children: [], preview: flags[1] !== 0,
      visible: flags[0] !== 0, locked: flags[2] === 0, printable: flags[3] !== 0,
      color: { kind: 'rgb', red: clamp(flags[colorOffset]! / 255), green: clamp(flags[colorOffset + 1]! / 255), blue: clamp(flags[colorOffset + 2]! / 255), alpha: 1 },
    } as IllustratorLayerNode
    node.layerId = node.id
    this.addNode(node); this.layers.push(node)
    this.containers.push({ node, children: node.children, layerId: node.id })
  }

  nameLayer(name: string, span: SourceSpan): void {
    for (let index = this.containers.length - 1; index > 0; index--) {
      const node = this.containers[index]!.node
      if (node?.type === 'Layer') { node.name = name; return }
    }
    this.diagnostics.push(diagnostic('AI_LAYER_NAME_ORPHAN', 'warning', 'lower', 'Layer name has no open layer.', { sourceSpan: span }))
  }

  beginText(kindCode: number | undefined, span: SourceSpan, statementIndex: number): void {
    if (this.text !== undefined) this.endText(span)
    const kind: IllustratorTextNode['textKind'] = kindCode === 0 ? 'point' : kindCode === 1 ? 'area' : kindCode === 2 ? 'path' : 'unknown'
    this.text = { kind, direction: 'horizontal', matrix: cloneMatrix(this.state.transform), position: this.currentPoint(), runs: [], fontSize: 12, statementIndices: [statementIndex], startSpan: span }
  }

  setTextFont(font: string | undefined, size: number | undefined, statementIndex: number): void {
    if (this.text === undefined) return
    if (font !== undefined) this.text.font = font.replace(/^\//u, '')
    if (size !== undefined && size > 0) this.text.fontSize = size
    this.text.statementIndices.push(statementIndex)
  }

  setTextMatrix(values: readonly number[], statementIndex: number): void {
    if (this.text === undefined || values.length < 6) return
    this.text.matrix = { a: values[0]!, b: values[1]!, c: values[2]!, d: values[3]!, e: values[4]!, f: values[5]! }
    this.text.position = { x: 0, y: 0 }
    this.text.statementIndices.push(statementIndex)
  }

  moveText(dx: number, dy: number, statementIndex: number): void {
    if (this.text === undefined) return
    this.text.position = { x: this.text.position.x + dx, y: this.text.position.y + dy }
    this.text.statementIndices.push(statementIndex)
  }

  showText(text: string, statementIndex: number, span: SourceSpan): void {
    if (this.text === undefined) this.beginText(0, span, statementIndex)
    const context = this.text!
    context.runs.push({ text, ...(context.font === undefined ? {} : { fontPostScriptName: context.font }), fontSize: context.fontSize, tracking: 0, baselineShift: 0, horizontalScale: 1, verticalScale: 1, fill: clonePaint(this.state.fill), stroke: clonePaint(this.state.stroke), opacity: this.state.opacity })
    context.statementIndices.push(statementIndex)
  }

  endText(span?: SourceSpan): void {
    const context = this.text
    if (context === undefined) return
    this.text = undefined
    if (!this.contentActive) return
    const text = context.runs.map((run) => run.text).join('')
    const width = Math.max(1, context.runs.reduce((sum, run) => sum + run.text.length * run.fontSize * 0.6, 0))
    const height = Math.max(1, context.runs.reduce((maximum, run) => Math.max(maximum, run.fontSize * 1.2), context.fontSize * 1.2))
    const textTransform = multiplyMatrix(context.matrix, { a: 1, b: 0, c: 0, d: 1, e: context.position.x, f: context.position.y })
    const localBottom = -height * 0.2
    const localTop = height * 0.8
    const textBounds = boundsFromPoints([
      transformPoint(textTransform, { x: 0, y: localBottom }),
      transformPoint(textTransform, { x: width, y: localBottom }),
      transformPoint(textTransform, { x: width, y: localTop }),
      transformPoint(textTransform, { x: 0, y: localTop }),
    ])
    const appearance = emptyAppearance()
    if (context.runs.some((run) => run.fill.kind !== 'none')) appearance.fills = [{ paint: clonePaint(context.runs.find((run) => run.fill.kind !== 'none')?.fill ?? this.state.fill), opacity: this.state.fillOpacity, overprint: this.state.overprintFill }]
    const diagnostics: IllustratorDiagnostic[] = []
    if (context.font === undefined) diagnostics.push(diagnostic('AI_TEXT_FONT_UNKNOWN', 'warning', 'resource', 'Text frame has no resolved PostScript font name.', { feature: 'font' }))
    else diagnostics.push(diagnostic('AI_TEXT_FONT_EXTERNAL', 'warning', 'resource', `Font ${context.font} must be resolved by the host before layout can be considered exact.`, { feature: 'font' }))
    if (context.kind !== 'point') diagnostics.push(diagnostic('AI_TEXT_LAYOUT_PARTIAL', 'warning', 'lower', `${context.kind} text content is preserved, but full Illustrator layout is not reconstructed.`, { feature: `${context.kind}-text` }))
    const node = {
      ...this.nodeBase({ start: context.startSpan.start, end: (span ?? context.startSpan).end }, appearance, 'partial', [...new Set(context.statementIndices)]),
      type: 'Text', textKind: context.kind, direction: context.direction, runs: context.runs,
      transform: textTransform,
      ...(textBounds === undefined ? {} : { bounds: textBounds }),
      diagnostics,
    } as IllustratorTextNode
    this.addNode(node)
    this.fidelity = lowerFidelity(this.fidelity, 'partial')
    this.markUnsupported(context.kind === 'point' ? 'font-dependent-text-layout' : `${context.kind}-text-layout`, true, 'partial', context.statementIndices[0] ?? this.statementIndex, 'Text remains native and selectable, but needs a font resolver and version-specific layout rules.')
  }

  beginResource(kind: IllustratorOpaqueResource['kind'], name: string | undefined, span: SourceSpan, fidelity: IllustratorFidelity = 'structure-only'): void {
    if (this.resourceCapture !== undefined) this.endResource()
    this.resourceCapture = { kind, id: stableId(`${kind}-resource`, this.resourceCounter++), ...(name === undefined ? {} : { name }), raw: [], startSpan: span, fidelity }
  }

  captureRaw(raw: string): void { this.resourceCapture?.raw.push(raw) }

  endResource(): void {
    const capture = this.resourceCapture
    if (capture === undefined) return
    this.resourceCapture = undefined
    this.resources[capture.id] = { id: capture.id, kind: capture.kind, ...(capture.name === undefined ? {} : { name: capture.name }), sourceSpan: capture.startSpan, raw: capture.raw.join(''), metadata: {}, fidelity: capture.fidelity }
    this.fidelity = lowerFidelity(this.fidelity, capture.fidelity)
  }

  addImage(kind: 'RasterImage' | 'PlacedImage', statement: IllustratorAstOperatorStatement, statementIndex: number): void {
    if (!this.contentActive) return
    const resourceId = stableId(kind === 'RasterImage' ? 'image' : 'link', this.resourceCounter++)
    this.resources[resourceId] = { id: resourceId, kind: 'image', sourceSpan: statement.span, raw: statement.raw, metadata: { operator: statement.operator }, fidelity: 'structure-only' }
    const numbers = statement.operands.map(numberValue).filter((value): value is number => value !== undefined)
    const width = numbers.length >= 2 ? Math.abs(numbers.at(-2)!) : undefined
    const height = numbers.length >= 1 ? Math.abs(numbers.at(-1)!) : undefined
    const bounds = width !== undefined && height !== undefined ? boundsFromPoints([
      transformPoint(this.state.transform, { x: 0, y: 0 }),
      transformPoint(this.state.transform, { x: width, y: height }),
    ]) : undefined
    const node = {
      ...this.nodeBase(statement.span, emptyAppearance(), 'structure-only', [statementIndex]),
      type: kind, resourceId, ...(width === undefined ? {} : { pixelWidth: width }), ...(height === undefined ? {} : { pixelHeight: height }),
      linked: kind === 'PlacedImage', ...(bounds === undefined ? {} : { bounds }),
    } as IllustratorSceneNode
    this.addNode(node)
    this.markUnsupported(kind === 'RasterImage' ? 'embedded-raster-decoder' : 'placed-image-resolver', true, 'structure-only', statementIndex, 'Image identity and transform are preserved; pixel/link decoding requires a registered resource handler.')
  }

  markUnsupported(feature: string, visible: boolean, fidelity: IllustratorFidelity, statementIndex: number, message: string): void {
    const current = this.unsupported.get(feature) ?? { count: 0, visible: false, fidelity, statementIndices: [], diagnostics: [] }
    current.count++
    current.visible ||= visible
    current.fidelity = lowerFidelity(current.fidelity, fidelity)
    if (!current.statementIndices.includes(statementIndex)) current.statementIndices.push(statementIndex)
    if (!current.diagnostics.includes(message)) current.diagnostics.push(message)
    this.unsupported.set(feature, current)
    this.fidelity = lowerFidelity(this.fidelity, fidelity)
  }

  handleUnknownOperator(statement: IllustratorAstOperatorStatement, statementIndex: number): void {
    const feature = classifyUnknownFeature(statement.operator)
    const visible = this.contentActive && feature.visible
    const fidelity: IllustratorFidelity = visible ? 'partial' : 'structure-only'
    this.markUnsupported(feature.name, visible, fidelity, statementIndex, `Unknown operator ${statement.operator} is preserved losslessly and was not executed.`)
    this.diagnostics.push(diagnostic('AI_OPERATOR_UNKNOWN', visible ? 'warning' : 'info', 'lower', `Unknown Illustrator operator ${statement.operator} was preserved${visible ? ' and may affect visible output' : ''}.`, { sourceSpan: statement.span, feature: statement.operator }))
    if (!visible) return
    const node = {
      ...this.nodeBase(statement.span, emptyAppearance(), fidelity, [statementIndex]),
      type: 'UnknownNode', operator: statement.operator, payload: statement.raw, visibleImpact: true,
      unsupportedReason: `No declarative handler is registered for ${statement.operator}.`, visible: false,
    } as IllustratorSceneNode
    this.addNode(node)
  }

  handleComment(raw: string): void {
    if (/^%%BeginProlog\b/iu.test(raw) || /^%%BeginSetup\b/iu.test(raw)) this.contentActive = false
    else if (/^%%EndProlog\b/iu.test(raw) || /^%%EndSetup\b/iu.test(raw) || /^%%Page\b/iu.test(raw)) this.contentActive = true
    if (/^%AI11_BeginTextDocument\b/iu.test(raw)) this.beginResource('font', 'AI11 Text Document', this.ast.statements[this.statementIndex]!.span, 'structure-only')
    else if (/^%AI11_EndTextDocument\b/iu.test(raw)) {
      this.captureRaw(raw); this.endResource()
      this.markUnsupported('ai11-text-document', true, 'structure-only', this.statementIndex, 'AI11 text resource is preserved; only explicit text operators are lowered.')
    }
  }

  private computeAllBounds(): Bounds | undefined {
    const compute = (node: IllustratorSceneNode): Bounds | undefined => {
      let bounds = node.bounds
      if (node.type === 'Layer' || node.type === 'Group' || node.type === 'ClipGroup' || node.type === 'SymbolDefinition') {
        bounds = undefined
        for (const child of node.children) bounds = unionBounds(bounds, compute(child))
        if (bounds !== undefined) node.bounds = bounds
      }
      return bounds
    }
    let bounds: Bounds | undefined
    for (const child of this.rootChildren) bounds = unionBounds(bounds, compute(child))
    return bounds
  }
}

function classifyUnknownFeature(operator: string): { name: string; visible: boolean } {
  const lowered = operator.toLowerCase()
  if (/gradient|mesh|pattern|symbol|brush|effect|plugin|opacity|blend|mask|raster|image|placed|text|font/iu.test(operator)) return { name: lowered.replace(/[^a-z0-9]+/gu, '-') || 'unknown-extension', visible: true }
  if (/^(?:def|bind|begin|end|dict|array|string|dup|exch|pop|put|get|load|where|if|ifelse|for|repeat|loop|exit|currentdict|readonly|executeonly|cvx|cvlit|save|restore|setpagedevice|showpage|findfont|scalefont|setfont|mark|cleartomark)$/u.test(operator)) return { name: 'unexecuted-postscript-program', visible: false }
  return { name: 'unknown-visible-operator', visible: true }
}

function register(
  registry: IllustratorOperatorRegistry,
  operator: string,
  operands: readonly IllustratorOperandKind[],
  handler: IllustratorOperatorDefinition['handler'],
  options: Partial<Omit<IllustratorOperatorDefinition, 'operator' | 'operands' | 'handler'>> = {},
): void {
  registry.register({ operator, family: options.family ?? 'base', operands, stateReads: options.stateReads ?? [], stateWrites: options.stateWrites ?? [], produces: options.produces ?? 'scene', fidelity: options.fidelity ?? 'high', fixtureId: options.fixtureId ?? `operator-${operator.replace(/[^a-z0-9]/giu, '_')}`, ...(options.minVersion === undefined ? {} : { minVersion: options.minVersion }), ...(options.maxVersion === undefined ? {} : { maxVersion: options.maxVersion }), ...(options.variadic === undefined ? {} : { variadic: options.variadic }), handler })
}

function requireNumbers(context: OperatorContext, count: number): number[] | undefined {
  const values = tailNumbers(context.operands, count)
  if (values === undefined) context.builder.diagnostics.push(diagnostic('AI_OPERATOR_NUMBERS', 'warning', 'lower', `Operator ${context.statement.operator} requires ${count} numeric operand(s).`, { sourceSpan: context.statement.span }))
  return values
}

function paintHandler(fill: boolean, stroke: boolean, rule: PathGeometry['fillRule'], close = false): IllustratorOperatorDefinition['handler'] {
  return ({ builder, statement, statementIndex }) => {
    if (close) builder.closePath(statementIndex)
    builder.flushPath(fill, stroke, rule, statement.span)
  }
}

function setProcessColor(target: 'fill' | 'stroke', kind: 'gray' | 'rgb' | 'cmyk'): IllustratorOperatorDefinition['handler'] {
  const count = kind === 'gray' ? 1 : kind === 'rgb' ? 3 : 4
  return (context) => {
    const values = requireNumbers(context, count)
    if (values === undefined) return
    const paint: IllustratorPaint = kind === 'gray'
      ? { kind, gray: clamp(values[0]!), alpha: 1 }
      : kind === 'rgb'
        ? { kind, red: clamp(values[0]!), green: clamp(values[1]!), blue: clamp(values[2]!), alpha: 1 }
        : { kind, cyan: clamp(values[0]!), magenta: clamp(values[1]!), yellow: clamp(values[2]!), black: clamp(values[3]!), alpha: 1 }
    context.builder.state[target] = paint
    context.builder.colorMode = kind === 'gray' ? context.builder.colorMode : kind
  }
}

function setSpotColor(target: 'fill' | 'stroke'): IllustratorOperatorDefinition['handler'] {
  return (context) => {
    const name = [...context.operands].reverse().map(stringValue).find((value) => value !== undefined) ?? 'Unnamed Ink'
    const numeric = context.operands.map(numberValue).filter((value): value is number => value !== undefined)
    const tint = clamp(numeric.at(-1) ?? 1)
    const alternate: IllustratorPaint = numeric.length >= 5
      ? { kind: 'cmyk', cyan: clamp(numeric[0]!), magenta: clamp(numeric[1]!), yellow: clamp(numeric[2]!), black: clamp(numeric[3]!), alpha: 1 }
      : clonePaint(context.builder.state[target])
    context.builder.state[target] = { kind: 'spot', name, tint, alternate, alpha: 1 }
    context.builder.colorMode = 'cmyk'
  }
}

function setIllustratorCustomColor(target: 'fill' | 'stroke'): IllustratorOperatorDefinition['handler'] {
  return (context) => {
    const name = [...context.operands].reverse().map(stringValue).find((value) => value !== undefined) ?? 'Unnamed Ink'
    const numeric = context.operands.map(numberValue).filter((value): value is number => value !== undefined)
    const tint = clamp(numeric.at(-1) ?? 1)
    // AI5+ RGB documents retain both a four-channel CMYK fallback and the
    // authored RGB alternate before the custom-color name.
    const alternate: IllustratorPaint = numeric.length >= 7
      ? { kind: 'rgb', red: clamp(numeric[4]!), green: clamp(numeric[5]!), blue: clamp(numeric[6]!), alpha: 1 }
      : numeric.length >= 4
        ? { kind: 'cmyk', cyan: clamp(numeric[0]!), magenta: clamp(numeric[1]!), yellow: clamp(numeric[2]!), black: clamp(numeric[3]!), alpha: 1 }
        : clonePaint(context.builder.state[target])
    context.builder.state[target] = { kind: 'spot', name, tint, alternate, alpha: 1 }
    context.builder.colorMode = alternate.kind === 'rgb' ? 'rgb' : 'cmyk'
  }
}

export function createDefaultOperatorRegistry(): IllustratorOperatorRegistry {
  const registry = new IllustratorOperatorRegistry()
  register(registry, 'm', ['number','number'], (context) => { const v = requireNumbers(context, 2); if (v) context.builder.moveTo({ x: v[0]!, y: v[1]! }, context.statement.span, context.statementIndex) }, { stateWrites: ['path'], fixtureId: 'path-move' })
  register(registry, 'moveto', ['number','number'], registry.resolve('m')!.handler, { stateWrites: ['path'], fixtureId: 'path-moveto' })
  register(registry, 'l', ['number','number'], (context) => { const v = requireNumbers(context, 2); if (v) context.builder.lineTo({ x: v[0]!, y: v[1]! }, context.statement.span, context.statementIndex) }, { stateReads: ['path'], stateWrites: ['path'], fixtureId: 'path-line' })
  register(registry, 'lineto', ['number','number'], registry.resolve('l')!.handler, { stateReads: ['path'], stateWrites: ['path'], fixtureId: 'path-lineto' })
  register(registry, 'L', ['number','number'], registry.resolve('l')!.handler, { family: 'ai5', stateReads: ['path'], stateWrites: ['path'], fixtureId: 'path-line-ai' })
  register(registry, 'c', ['number','number','number','number','number','number'], (context) => { const v = requireNumbers(context, 6); if (v) context.builder.cubicTo({ x: v[0]!, y: v[1]! }, { x: v[2]!, y: v[3]! }, { x: v[4]!, y: v[5]! }, context.statement.span, context.statementIndex) }, { stateReads: ['path'], stateWrites: ['path'], fixtureId: 'path-cubic' })
  register(registry, 'curveto', ['number','number','number','number','number','number'], registry.resolve('c')!.handler, { stateReads: ['path'], stateWrites: ['path'], fixtureId: 'path-curveto' })
  register(registry, 'C', ['number','number','number','number','number','number'], registry.resolve('c')!.handler, { family: 'ai5', stateReads: ['path'], stateWrites: ['path'], fixtureId: 'path-cubic-ai' })
  register(registry, 'v', ['number','number','number','number'], (context) => { const v = requireNumbers(context, 4); if (v) { const current = context.builder.currentPoint(); context.builder.cubicTo(current, { x: v[0]!, y: v[1]! }, { x: v[2]!, y: v[3]! }, context.statement.span, context.statementIndex) } }, { family: 'ai3', stateReads: ['path'], stateWrites: ['path'], fixtureId: 'path-cubic-v' })
  register(registry, 'y', ['number','number','number','number'], (context) => { const v = requireNumbers(context, 4); if (v) { const end = { x: v[2]!, y: v[3]! }; context.builder.cubicTo({ x: v[0]!, y: v[1]! }, end, end, context.statement.span, context.statementIndex) } }, { family: 'ai3', stateReads: ['path'], stateWrites: ['path'], fixtureId: 'path-cubic-y' })
  for (const operator of ['h', 'closepath']) register(registry, operator, [], ({ builder, statementIndex }) => builder.closePath(statementIndex), { stateReads: ['path'], stateWrites: ['path'], fixtureId: `path-close-${operator}` })
  for (const [operator, fill, stroke, rule, close] of [
    ['n',false,false,'nonzero',false], ['N',false,false,'nonzero',false], ['S',false,true,'nonzero',false], ['stroke',false,true,'nonzero',false],
    ['s',false,true,'nonzero',true], ['f',true,false,'nonzero',false], ['F',true,false,'nonzero',false], ['fill',true,false,'nonzero',false],
    ['f*',true,false,'evenodd',false], ['eofill',true,false,'evenodd',false], ['B',true,true,'nonzero',false], ['B*',true,true,'evenodd',false],
    ['b',true,true,'nonzero',true], ['b*',true,true,'evenodd',true],
  ] as const) register(registry, operator, [], paintHandler(fill, stroke, rule, close), { stateReads: ['path','paint'], stateWrites: ['path'], fixtureId: `path-paint-${operator}` })
  register(registry, '*', ['string'], (context) => {
    const operation = tailString(context.operands)
    const dynamic = operation === undefined ? undefined : registry.resolve(operation)
    if (dynamic !== undefined && ['n','N','S','s','f','F','B','b','f*','B*','b*'].includes(operation!)) dynamic.handler(context)
    else context.builder.handleUnknownOperator(context.statement, context.statementIndex)
  }, { family: 'ai5', stateReads: ['path','paint'], stateWrites: ['path'], fixtureId: 'path-paint-indirect' })
  register(registry, 'W', [], ({ builder }) => builder.markClip('nonzero'), { stateReads: ['path'], stateWrites: ['clipping'], fixtureId: 'clip-nonzero' })
  register(registry, 'W*', [], ({ builder }) => builder.markClip('evenodd'), { stateReads: ['path'], stateWrites: ['clipping'], fixtureId: 'clip-evenodd' })
  register(registry, 'clip', [], ({ builder }) => builder.markClip('nonzero'), { stateReads: ['path'], stateWrites: ['clipping'], fixtureId: 'clip-ps' })
  register(registry, 'eoclip', [], ({ builder }) => builder.markClip('evenodd'), { stateReads: ['path'], stateWrites: ['clipping'], fixtureId: 'clip-eops' })
  register(registry, '*u', [], ({ builder, statement, statementIndex }) => builder.beginCompound(statement.span, statementIndex), { family: 'ai3', stateWrites: ['compound'], fixtureId: 'compound-begin' })
  register(registry, '*U', [], ({ builder, statement, statementIndex }) => builder.endCompound(statement.span, statementIndex), { family: 'ai3', stateWrites: ['compound'], fixtureId: 'compound-end' })
  register(registry, 'u', [], ({ builder, statement, statementIndex }) => builder.beginGroup('Group', statement.span, statementIndex), { family: 'ai3', stateWrites: ['hierarchy'], fixtureId: 'group-begin' })
  register(registry, 'U', [], ({ builder, statement }) => builder.endContainer(['Group','ClipGroup'], statement.span), { family: 'ai3', stateWrites: ['hierarchy'], fixtureId: 'group-end' })
  for (const operator of ['q','gsave']) register(registry, operator, [], ({ builder }) => builder.saveGraphicsState(), { stateReads: ['graphics-state'], stateWrites: ['graphics-state'], fixtureId: `gstate-save-${operator}` })
  for (const operator of ['Q','grestore']) register(registry, operator, [], ({ builder, statement }) => builder.restoreGraphicsState(statement.span), { stateReads: ['graphics-state'], stateWrites: ['graphics-state'], fixtureId: `gstate-restore-${operator}` })
  register(registry, 'cm', ['number','number','number','number','number','number'], (context) => { const v = requireNumbers(context, 6); if (v) context.builder.concatTransform({ a: v[0]!, b: v[1]!, c: v[2]!, d: v[3]!, e: v[4]!, f: v[5]! }) }, { stateWrites: ['transform'], fixtureId: 'transform-concat' })
  register(registry, 'concat', ['array'], (context) => { const v = numberArray(context.operands.at(-1)) ?? tailNumbers(context.operands, 6); if (v?.length === 6) context.builder.concatTransform({ a: v[0]!, b: v[1]!, c: v[2]!, d: v[3]!, e: v[4]!, f: v[5]! }) }, { stateWrites: ['transform'], fixtureId: 'transform-concat-array' })
  register(registry, 'setmatrix', ['array'], (context) => { const v = numberArray(context.operands.at(-1)) ?? tailNumbers(context.operands, 6); if (v?.length === 6) context.builder.setTransform({ a: v[0]!, b: v[1]!, c: v[2]!, d: v[3]!, e: v[4]!, f: v[5]! }) }, { stateWrites: ['transform'], fixtureId: 'transform-set' })
  register(registry, 'initmatrix', [], ({ builder }) => builder.setTransform(IDENTITY_MATRIX), { stateWrites: ['transform'], fixtureId: 'transform-init' })
  register(registry, 'translate', ['number','number'], (context) => { const v = requireNumbers(context, 2); if (v) context.builder.concatTransform({ a: 1,b: 0,c: 0,d: 1,e: v[0]!,f: v[1]! }) }, { stateWrites: ['transform'], fixtureId: 'transform-translate' })
  register(registry, 'scale', ['number','number'], (context) => { const v = requireNumbers(context, 2); if (v) context.builder.concatTransform({ a: v[0]!,b: 0,c: 0,d: v[1]!,e: 0,f: 0 }) }, { stateWrites: ['transform'], fixtureId: 'transform-scale' })
  register(registry, 'rotate', ['number'], (context) => { const v = requireNumbers(context, 1); if (v) { const r = v[0]! * Math.PI / 180; const c = Math.cos(r); const s = Math.sin(r); context.builder.concatTransform({ a:c,b:s,c:-s,d:c,e:0,f:0 }) } }, { stateWrites: ['transform'], fixtureId: 'transform-rotate' })
  for (const [operator,target,kind] of [
    ['g','fill','gray'], ['G','stroke','gray'], ['setgray','fill','gray'],
    ['rg','fill','rgb'], ['RG','stroke','rgb'], ['Xa','fill','rgb'], ['XA','stroke','rgb'], ['setrgbcolor','fill','rgb'],
    ['k','fill','cmyk'], ['K','stroke','cmyk'], ['setcmykcolor','fill','cmyk'],
  ] as const) register(registry, operator, Array(kind === 'gray' ? 1 : kind === 'rgb' ? 3 : 4).fill('number') as IllustratorOperandKind[], setProcessColor(target, kind), { stateWrites: [target, 'color-mode'], fixtureId: `paint-${operator}` })
  register(registry, 'x', ['any'], setSpotColor('fill'), { family: 'ai3', variadic: true, stateWrites: ['fill','color-mode'], fidelity: 'partial', fixtureId: 'paint-custom-fill' })
  register(registry, 'X', ['any'], setSpotColor('stroke'), { family: 'ai3', variadic: true, stateWrites: ['stroke','color-mode'], fidelity: 'partial', fixtureId: 'paint-custom-stroke' })
  register(registry, 'Xk', ['any'], setIllustratorCustomColor('fill'), { family: 'ai5', variadic: true, stateWrites: ['fill','color-mode'], fidelity: 'partial', fixtureId: 'paint-custom-fill-ai5' })
  register(registry, 'XK', ['any'], setIllustratorCustomColor('stroke'), { family: 'ai5', variadic: true, stateWrites: ['stroke','color-mode'], fidelity: 'partial', fixtureId: 'paint-custom-stroke-ai5' })
  register(registry, 'w', ['number'], (context) => { const v = requireNumbers(context, 1); if (v && v[0]! >= 0) context.builder.state.lineWidth = v[0]! }, { stateWrites: ['stroke'], fixtureId: 'stroke-width' })
  register(registry, 'setlinewidth', ['number'], registry.resolve('w')!.handler, { stateWrites: ['stroke'], fixtureId: 'stroke-width-ps' })
  register(registry, 'J', ['number'], (context) => { const v = requireNumbers(context, 1); if (v) context.builder.state.lineCap = v[0] === 1 ? 'round' : v[0] === 2 ? 'square' : 'butt' }, { stateWrites: ['stroke'], fixtureId: 'stroke-cap' })
  register(registry, 'setlinecap', ['number'], registry.resolve('J')!.handler, { stateWrites: ['stroke'], fixtureId: 'stroke-cap-ps' })
  register(registry, 'j', ['number'], (context) => { const v = requireNumbers(context, 1); if (v) context.builder.state.lineJoin = v[0] === 1 ? 'round' : v[0] === 2 ? 'bevel' : 'miter' }, { stateWrites: ['stroke'], fixtureId: 'stroke-join' })
  register(registry, 'setlinejoin', ['number'], registry.resolve('j')!.handler, { stateWrites: ['stroke'], fixtureId: 'stroke-join-ps' })
  register(registry, 'M', ['number'], (context) => { const v = requireNumbers(context, 1); if (v && v[0]! > 0) context.builder.state.miterLimit = v[0]! }, { stateWrites: ['stroke'], fixtureId: 'stroke-miter' })
  register(registry, 'setmiterlimit', ['number'], registry.resolve('M')!.handler, { stateWrites: ['stroke'], fixtureId: 'stroke-miter-ps' })
  register(registry, 'd', ['array','number'], (context) => {
    const offset = numberValue(context.operands.at(-1)); const array = numberArray(context.operands.at(-2))
    if (offset !== undefined && array !== undefined && array.every((value) => value >= 0)) { context.builder.state.dashArray = array; context.builder.state.dashOffset = offset }
    else context.builder.diagnostics.push(diagnostic('AI_DASH_INVALID', 'warning', 'lower', 'Stroke dash operands are invalid.', { sourceSpan: context.statement.span }))
  }, { stateWrites: ['stroke'], fixtureId: 'stroke-dash' })
  register(registry, 'setdash', ['array','number'], registry.resolve('d')!.handler, { stateWrites: ['stroke'], fixtureId: 'stroke-dash-ps' })
  register(registry, 'Lb', ['any'], ({ builder, operands, statement, statementIndex }) => builder.beginLayer(operands, statement.span, statementIndex), { family: 'ai5', minVersion: 5, variadic: true, stateWrites: ['hierarchy'], fixtureId: 'layer-begin' })
  register(registry, 'Ln', ['string'], ({ builder, operands, statement }) => builder.nameLayer(tailString(operands) ?? 'Unnamed Layer', statement.span), { family: 'ai5', minVersion: 5, stateWrites: ['hierarchy'], fixtureId: 'layer-name' })
  register(registry, 'LB', [], ({ builder, statement }) => builder.endContainer(['Layer'], statement.span), { family: 'ai5', minVersion: 5, stateWrites: ['hierarchy'], fixtureId: 'layer-end' })
  register(registry, 'Mb', ['any'], ({ builder, statementIndex }) => builder.markUnsupported('multi-layer-mask', true, 'structure-only', statementIndex, 'Multi-layer mask parameters are preserved, but the mask hierarchy is not reconstructed.'), { family: 'ai8', variadic: true, produces: 'metadata', fidelity: 'structure-only', fixtureId: 'multilayer-mask-begin' })
  register(registry, 'Md', ['any'], ({ builder, statementIndex }) => builder.markUnsupported('multi-layer-mask', true, 'structure-only', statementIndex, 'Multi-layer mask definition is opaque.'), { family: 'ai8', variadic: true, produces: 'metadata', fidelity: 'structure-only', fixtureId: 'multilayer-mask-define' })
  register(registry, 'MB', [], () => {}, { family: 'ai8', produces: 'metadata', fidelity: 'structure-only', fixtureId: 'multilayer-mask-end' })
  register(registry, 'To', ['number'], ({ builder, operands, statement, statementIndex }) => builder.beginText(numberValue(operands.at(-1)), statement.span, statementIndex), { family: 'ai3', stateWrites: ['text'], fidelity: 'partial', fixtureId: 'text-begin-ai' })
  register(registry, 'BT', [], ({ builder, statement, statementIndex }) => builder.beginText(0, statement.span, statementIndex), { stateWrites: ['text'], fidelity: 'partial', fixtureId: 'text-begin' })
  for (const operator of ['TO','ET']) register(registry, operator, [], ({ builder, statement }) => builder.endText(statement.span), { family: operator === 'TO' ? 'ai3' : 'base', stateWrites: ['text'], fidelity: 'partial', fixtureId: `text-end-${operator}` })
  register(registry, 'Tf', ['name','number'], ({ builder, operands, statementIndex }) => builder.setTextFont(stringValue(operands.at(-2)), numberValue(operands.at(-1)), statementIndex), { stateWrites: ['text'], fidelity: 'partial', fixtureId: 'text-font' })
  register(registry, 'Tm', ['number','number','number','number','number','number'], (context) => { const v = requireNumbers(context, 6); if (v) context.builder.setTextMatrix(v, context.statementIndex) }, { stateWrites: ['text'], fidelity: 'partial', fixtureId: 'text-matrix' })
  register(registry, 'Tp', ['any'], (context) => { const values = context.operands.map(numberValue).filter((value): value is number => value !== undefined); if (values.length >= 6) context.builder.setTextMatrix(values.slice(-6), context.statementIndex) }, { family: 'ai3', variadic: true, stateWrites: ['text'], fidelity: 'partial', fixtureId: 'text-path-matrix' })
  register(registry, 'Td', ['number','number'], (context) => { const v = requireNumbers(context, 2); if (v) context.builder.moveText(v[0]!, v[1]!, context.statementIndex) }, { stateWrites: ['text'], fidelity: 'partial', fixtureId: 'text-move' })
  for (const operator of ['Tx','Tj','show']) register(registry, operator, ['string'], ({ builder, operands, statement, statementIndex }) => builder.showText(tailString(operands) ?? '', statementIndex, statement.span), { family: operator === 'Tx' ? 'ai3' : 'base', stateWrites: ['text'], fidelity: 'partial', fixtureId: `text-show-${operator}` })
  register(registry, 'TJ', ['array'], ({ builder, operands, statement, statementIndex }) => {
    const value = operands.at(-1)
    const text = value?.kind === 'array' ? value.values.map((entry) => stringValue(entry) ?? '').join('') : ''
    builder.showText(text, statementIndex, statement.span)
  }, { stateWrites: ['text'], fidelity: 'partial', fixtureId: 'text-show-array' })
  for (const operator of ['XI','image','colorimage']) register(registry, operator, ['any'], ({ builder, statement, statementIndex }) => builder.addImage('RasterImage', statement, statementIndex), { family: operator === 'XI' ? 'ai3' : 'base', variadic: true, produces: 'scene', fidelity: 'structure-only', fixtureId: `image-raster-${operator}` })
  for (const operator of ['XF','XG']) register(registry, operator, ['any'], ({ builder, statement, statementIndex }) => builder.addImage('PlacedImage', statement, statementIndex), { family: 'ai7', variadic: true, produces: 'scene', fidelity: 'structure-only', fixtureId: `image-placed-${operator}` })
  register(registry, 'Bd', ['any'], ({ builder, operands, statement }) => builder.beginResource('gradient', tailString(operands), statement.span, 'structure-only'), { family: 'ai8', variadic: true, produces: 'resource', fidelity: 'structure-only', fixtureId: 'gradient-definition-begin' })
  register(registry, 'BD', [], ({ builder, statementIndex }) => { builder.endResource(); builder.markUnsupported('gradient-definition', true, 'structure-only', statementIndex, 'Gradient definition is preserved as an opaque resource.') }, { family: 'ai8', produces: 'resource', fidelity: 'structure-only', fixtureId: 'gradient-definition-end' })
  register(registry, 'Bg', ['any'], ({ builder, statement, statementIndex }) => builder.handleUnknownOperator(statement, statementIndex), { family: 'ai8', variadic: true, produces: 'fallback', fidelity: 'partial', fixtureId: 'gradient-instance' })
  register(registry, 'Bp', ['any'], ({ builder, operands, statement }) => builder.beginResource('pattern', tailString(operands), statement.span, 'structure-only'), { family: 'ai8', variadic: true, produces: 'resource', fidelity: 'structure-only', fixtureId: 'pattern-begin' })
  register(registry, 'EP', [], ({ builder, statementIndex }) => { builder.endResource(); builder.markUnsupported('pattern-definition', true, 'structure-only', statementIndex, 'Pattern definition is preserved as an opaque resource.') }, { family: 'ai8', produces: 'resource', fidelity: 'structure-only', fixtureId: 'pattern-end' })
  register(registry, 'ca', ['number'], (context) => { const v = requireNumbers(context, 1); if (v) context.builder.state.fillOpacity = clamp(v[0]!) }, { family: 'ai9', stateWrites: ['opacity'], fidelity: 'partial', fixtureId: 'opacity-fill' })
  register(registry, 'CA', ['number'], (context) => { const v = requireNumbers(context, 1); if (v) context.builder.state.strokeOpacity = clamp(v[0]!) }, { family: 'ai9', stateWrites: ['opacity'], fidelity: 'partial', fixtureId: 'opacity-stroke' })
  register(registry, 'setopacityalpha', ['number'], (context) => { const v = requireNumbers(context, 1); if (v) context.builder.state.opacity = clamp(v[0]!) }, { family: 'ai9', stateWrites: ['opacity'], fidelity: 'partial', fixtureId: 'opacity-object' })
  register(registry, 'Xy', ['any'], (context) => {
    const values = context.operands.map(numberValue).filter((value): value is number => value !== undefined)
    if (values.length >= 2) context.builder.state.opacity = clamp(values[1]!)
  }, { family: 'ai9', variadic: true, stateWrites: ['opacity','blend'], fidelity: 'partial', fixtureId: 'opacity-object-ai' })
  register(registry, 'BM', ['name'], ({ builder, operands }) => { builder.state.blendMode = stringValue(operands.at(-1)) ?? 'normal' }, { family: 'ai9', stateWrites: ['blend'], fidelity: 'partial', fixtureId: 'blend-mode' })
  register(registry, 'op', ['boolean'], ({ builder, operands }) => { const value = operands.at(-1); if (value?.kind === 'boolean') builder.state.overprintFill = value.value }, { stateWrites: ['overprint'], fidelity: 'partial', fixtureId: 'overprint-fill' })
  register(registry, 'OP', ['boolean'], ({ builder, operands }) => { const value = operands.at(-1); if (value?.kind === 'boolean') builder.state.overprintStroke = value.value }, { stateWrites: ['overprint'], fidelity: 'partial', fixtureId: 'overprint-stroke' })
  register(registry, 'newpath', [], ({ builder, statement }) => builder.flushPath(false, false, builder.state.fillRule, statement.span), { stateWrites: ['path'], produces: 'none', fixtureId: 'path-new' })
  register(registry, 'initgraphics', [], ({ builder }) => {
    builder.state = { transform: cloneMatrix(), fill: BLACK_PAINT, stroke: NONE_PAINT, lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, dashArray: [], dashOffset: 0, fillOpacity: 1, strokeOpacity: 1, opacity: 1, blendMode: 'normal', overprintFill: false, overprintStroke: false, fillRule: 'nonzero' }
  }, { stateWrites: ['graphics-state'], produces: 'none', fixtureId: 'graphics-init' })
  const harmless = [
    'def','bind','begin','end','dict','array','string','dup','exch','pop','put','get','load','where','if','ifelse','for','repeat','loop','exit','currentdict','readonly','executeonly','cvx','cvlit','save','restore','setpagedevice','showpage','findfont','scalefont','setfont','mark','cleartomark','count','index','roll','copy','known','maxlength','currentfile','readstring','readhexstring','flushfile','setflat','sethalftone','setscreen','settransfer','setcolortransfer','setcolorspace','setcolor','setrenderingintent','ri','ddef','xput','npop','Adobe_Illustrator_AI5','Adobe_Illustrator_AI8','terminate','exec','currentpoint','charpath','stringwidth','widthshow','ashow','awidthshow','kshow','rmoveto','rlineto','rcurveto',',',':',';',
  ]
  for (const operator of harmless) if (registry.resolve(operator) === undefined) register(registry, operator, [], () => {}, { variadic: true, produces: 'none', fidelity: 'structure-only', fixtureId: `program-${operator.replace(/[^a-z0-9]/giu, '_')}` })
  return registry
}

export function lowerIllustratorAst(
  ast: IllustratorLosslessAst,
  options: LowerOptions = {},
  registry: IllustratorOperatorRegistry = createDefaultOperatorRegistry(),
): IllustratorSceneDocument {
  const source = reconstructIllustratorSourceText(ast)
  const limits = resolveLimits(options.limits)
  const budget = new WorkBudget(options.signal, Math.min(options.timeoutMs ?? limits.maxWorkerTimeMs, limits.maxWorkerTimeMs))
  const fingerprint: IllustratorVersionFingerprint = options.sourceFingerprint ?? {
    sourceKind: /^%!PS-Adobe/u.test(source) ? 'direct-postscript' : 'unknown',
    featureMarkers: [...new Set([...source.matchAll(/%(AI\d+_[A-Za-z0-9_]+)/gu)].map((match) => `%${match[1]}`))],
    contradictions: [],
  }
  return new SceneBuilder(ast, source, fingerprint, limits, budget).build(registry)
}

export async function lowerIllustratorSource(
  input: string | Uint8Array,
  options: LowerOptions = {},
  registry: IllustratorOperatorRegistry = createDefaultOperatorRegistry(),
): Promise<IllustratorSceneDocument> {
  const { parseIllustratorSource } = await import('./ast.js')
  return lowerIllustratorAst(parseIllustratorSource(input, options), options, registry)
}
