export type IllustratorInput = ArrayBuffer | Uint8Array | Blob
export type IllustratorStage = 'container' | 'decode' | 'lex' | 'parse' | 'lower' | 'render' | 'resource'
export type IllustratorSeverity = 'info' | 'warning' | 'error'
export type IllustratorFidelity = 'exact' | 'high' | 'partial' | 'structure-only' | 'unsupported'

export interface SourcePosition { offset: number; line: number; column: number }
export interface SourceSpan { start: SourcePosition; end: SourcePosition }
export interface IllustratorDiagnostic {
  code: string
  severity: IllustratorSeverity
  stage: IllustratorStage
  message: string
  sourceSpan?: SourceSpan
  nodeId?: string
  feature?: string
  recovery?: string
  details?: Readonly<Record<string, unknown>>
}

export interface IllustratorLimits {
  maxFileBytes: number
  maxDecodedBytes: number
  maxPdfObjects: number
  maxPrivateBlocks: number
  maxTokens: number
  maxStatements: number
  maxNodes: number
  maxPathPoints: number
  maxNesting: number
  maxStringBytes: number
  maxSingleRasterPixels: number
  maxTotalRasterBytes: number
  maxWorkerTimeMs: number
  maxRenderPixels: number
  maxCacheBytes: number
}

export interface IllustratorVersionFingerprint {
  sourceKind: 'direct-postscript' | 'pdf-private' | 'pdf-surface-only' | 'unknown'
  pdfVersion?: string
  containerVersion?: number
  creatorVersion?: number
  roundtripVersion?: number
  ai8CreatorVersion?: string
  ai5FileFormat?: number
  featureMarkers: readonly string[]
  mime?: string
  creator?: string
  illustratorNamespace?: string
  sourceSha256?: string
  contradictions: readonly string[]
}

export interface IllustratorContainerInspection {
  kind: 'direct-postscript' | 'pdf-private' | 'pdf-surface-only' | 'unknown'
  illustratorEvidence: boolean
  pdfSurface: 'usable' | 'warning-placeholder' | 'absent' | 'unknown'
  privateSource: 'present' | 'missing' | 'corrupt' | 'unknown'
  compression?: 'none' | 'deflate' | 'zstd'
  containerVersion?: number
  creatorVersion?: number
  roundtripVersion?: number
  privateBlocks: number
  fingerprint: IllustratorVersionFingerprint
  diagnostics: readonly IllustratorDiagnostic[]
}

export interface IllustratorPrivateBlockInfo {
  part: number
  objectNumber?: number
  generation?: number
  encodedBytes: number
  decodedBytes?: number
  sha256: string
  filters: readonly string[]
}
export interface IllustratorDecodedSource {
  bytes: Uint8Array
  text: string
  compression: 'none' | 'deflate' | 'zstd'
  fingerprint: IllustratorVersionFingerprint
  blocks: readonly IllustratorPrivateBlockInfo[]
  diagnostics: readonly IllustratorDiagnostic[]
}

export type IllustratorTokenKind =
  | 'whitespace' | 'comment' | 'pseudo-comment' | 'number' | 'boolean' | 'null'
  | 'word' | 'literal-name' | 'string' | 'hex-string' | 'ascii85'
  | 'array-start' | 'array-end' | 'dict-start' | 'dict-end'
  | 'procedure-start' | 'procedure-end' | 'binary' | 'unknown'
export interface IllustratorToken {
  kind: IllustratorTokenKind
  raw: string
  span: SourceSpan
  value?: number | string | boolean | null | Uint8Array
}

export type IllustratorAstValue =
  | { kind: 'number'; value: number; span: SourceSpan; tokenIndex: number }
  | { kind: 'boolean'; value: boolean; span: SourceSpan; tokenIndex: number }
  | { kind: 'null'; value: null; span: SourceSpan; tokenIndex: number }
  | { kind: 'name'; value: string; literal: boolean; span: SourceSpan; tokenIndex: number }
  | { kind: 'string'; value: string; rawBytes: Uint8Array; span: SourceSpan; tokenIndex: number }
  | { kind: 'hex-string' | 'ascii85' | 'binary'; value: Uint8Array; span: SourceSpan; tokenIndex: number }
  | { kind: 'array' | 'procedure'; values: readonly IllustratorAstValue[]; span: SourceSpan; tokenRange: readonly [number, number] }
  | { kind: 'dictionary'; entries: readonly IllustratorAstDictionaryEntry[]; span: SourceSpan; tokenRange: readonly [number, number] }
  | { kind: 'unknown'; raw: string; span: SourceSpan; tokenIndex: number }
export interface IllustratorAstDictionaryEntry { key: IllustratorAstValue; value: IllustratorAstValue }
export interface IllustratorAstOperatorStatement {
  kind: 'operator'; operator: string; operands: readonly IllustratorAstValue[]
  span: SourceSpan; tokenRange: readonly [number, number]; raw: string
}
export interface IllustratorAstCommentStatement {
  kind: 'comment'; pseudo: boolean; text: string; span: SourceSpan
  tokenRange: readonly [number, number]; raw: string
}
export interface IllustratorAstResourceStatement {
  kind: 'resource'; resourceKind: 'binary' | 'ascii85' | 'hex'; value: Uint8Array
  span: SourceSpan; tokenRange: readonly [number, number]; raw: string
}
export interface IllustratorAstTrailingStatement {
  kind: 'trailing-values'; values: readonly IllustratorAstValue[]; span: SourceSpan
  tokenRange: readonly [number, number]; raw: string
}
export type IllustratorAstStatement = IllustratorAstOperatorStatement | IllustratorAstCommentStatement | IllustratorAstResourceStatement | IllustratorAstTrailingStatement
export interface IllustratorLosslessAst {
  format: 'adobe-illustrator.lossless-ast'; schemaVersion: 1; encoding: 'latin1'
  sourceByteLength: number; tokens: readonly IllustratorToken[]
  statements: readonly IllustratorAstStatement[]; diagnostics: readonly IllustratorDiagnostic[]
}

export interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }
export interface Point { x: number; y: number }
export interface Bounds { left: number; bottom: number; right: number; top: number }
export type PathSegment = { kind: 'line'; to: Point } | { kind: 'cubic'; control1: Point; control2: Point; to: Point }
export interface PathContour { start: Point; segments: readonly PathSegment[]; closed: boolean }
export interface PathGeometry { contours: readonly PathContour[]; fillRule: 'nonzero' | 'evenodd' }

export type IllustratorPaint =
  | { kind: 'none' }
  | { kind: 'gray'; gray: number; alpha: number }
  | { kind: 'rgb'; red: number; green: number; blue: number; alpha: number }
  | { kind: 'cmyk'; cyan: number; magenta: number; yellow: number; black: number; alpha: number }
  | { kind: 'lab'; lightness: number; a: number; b: number; alpha: number }
  | { kind: 'spot'; name: string; tint: number; alternate: IllustratorPaint; alpha: number }
  | { kind: 'linear-gradient' | 'radial-gradient' | 'pattern' | 'raster'; resourceId: string; transform: Matrix; alpha: number }
  | { kind: 'mesh-gradient'; resourceId: string; alpha: number }
export interface StrokeStyle {
  paint: IllustratorPaint; width: number; alignment: 'center' | 'inside' | 'outside'
  cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round' | 'bevel'; miterLimit: number
  dashArray: readonly number[]; dashOffset: number; opacity: number; overprint: boolean
}
export interface IllustratorEffect { kind: string; parameters: Readonly<Record<string, unknown>>; fallbackNodeIds: readonly string[]; supported: boolean }
export interface IllustratorAppearance {
  fills: readonly { paint: IllustratorPaint; opacity: number; overprint: boolean }[]
  strokes: readonly StrokeStyle[]; opacity: number; blendMode: string
  clippingMask?: string; opacityMask?: string; knockout: boolean; isolated: boolean
  effects: readonly IllustratorEffect[]; source: 'native' | 'expanded' | 'fallback' | 'alternate'
}
export interface IllustratorNodeBase {
  id: string; name?: string; sourceSpan?: SourceSpan; parentId?: string; layerId?: string
  transform: Matrix; bounds?: Bounds; visible: boolean; locked: boolean; printable: boolean
  appearance: IllustratorAppearance; fidelity: IllustratorFidelity
  diagnostics: readonly IllustratorDiagnostic[]; rawStatementIndices: readonly number[]
}
export interface IllustratorGroupNode extends IllustratorNodeBase { type: 'Group' | 'ClipGroup'; children: IllustratorSceneNode[]; isolated: boolean; knockout: boolean }
export interface IllustratorLayerNode extends IllustratorNodeBase { type: 'Layer'; children: IllustratorSceneNode[]; color?: IllustratorPaint; preview: boolean }
export interface IllustratorPathNode extends IllustratorNodeBase { type: 'Path' | 'CompoundPath'; geometry: PathGeometry; paintPath: boolean; clippingPath: boolean }
export interface IllustratorTextRun {
  text: string; fontPostScriptName?: string; fontSize: number; tracking: number; kerning?: number
  baselineShift: number; horizontalScale: number; verticalScale: number
  fill: IllustratorPaint; stroke: IllustratorPaint; opacity: number
}
export interface IllustratorTextNode extends IllustratorNodeBase {
  type: 'Text'; textKind: 'point' | 'area' | 'path' | 'threaded' | 'unknown'
  direction: 'horizontal' | 'vertical'; storyId?: string; frameId?: string
  runs: readonly IllustratorTextRun[]; frame?: Bounds; pathId?: string
}
export interface IllustratorRasterNode extends IllustratorNodeBase {
  type: 'RasterImage' | 'PlacedImage'; resourceId: string; pixelWidth?: number; pixelHeight?: number
  dpi?: number; crop?: Bounds; linked: boolean
}
export interface IllustratorSymbolDefinitionNode extends IllustratorNodeBase { type: 'SymbolDefinition'; children: IllustratorSceneNode[]; resourceId: string }
export interface IllustratorSymbolInstanceNode extends IllustratorNodeBase { type: 'SymbolInstance'; resourceId: string }
export interface IllustratorGradientMeshNode extends IllustratorNodeBase { type: 'GradientMesh'; resourceId: string; rows?: number; columns?: number }
export interface IllustratorPluginNode extends IllustratorNodeBase { type: 'PluginObject'; pluginId?: string; payload: string; fallbackNodeIds: readonly string[]; unsupportedReason: string }
export interface IllustratorUnknownNode extends IllustratorNodeBase { type: 'UnknownNode'; operator?: string; payload: string; visibleImpact: boolean; unsupportedReason: string }
export type IllustratorSceneNode = IllustratorGroupNode | IllustratorLayerNode | IllustratorPathNode | IllustratorTextNode | IllustratorRasterNode | IllustratorSymbolDefinitionNode | IllustratorSymbolInstanceNode | IllustratorGradientMeshNode | IllustratorPluginNode | IllustratorUnknownNode

export interface IllustratorArtboard {
  id: string; name: string; uuid?: string; bounds: Bounds
  bleed: { top: number; right: number; bottom: number; left: number }
  rulerOrigin: Point; selected: boolean; locked: boolean; pixelAspectRatio: number
}
export interface IllustratorOpaqueResource {
  id: string; kind: 'gradient' | 'pattern' | 'symbol' | 'brush' | 'font' | 'icc' | 'image' | 'plugin' | 'unknown'
  name?: string; sourceSpan?: SourceSpan; raw: string; sha256?: string
  metadata: Readonly<Record<string, unknown>>; fidelity: IllustratorFidelity
}
export interface IllustratorUnsupportedFeature {
  feature: string; count: number; visible: boolean; fidelity: IllustratorFidelity
  statementIndices: readonly number[]; diagnostics: readonly string[]
}
export interface IllustratorSceneDocument {
  format: 'adobe-illustrator.scene'; schemaVersion: 1; unit: 'pt'; coordinateSystem: 'illustrator-y-up'
  largeCanvasScale: number; colorMode: 'gray' | 'rgb' | 'cmyk' | 'lab' | 'unknown'
  iccProfileResourceId?: string; metadata: Readonly<Record<string, string | number | boolean>>
  artboards: readonly IllustratorArtboard[]; layers: IllustratorLayerNode[]; children: IllustratorSceneNode[]
  resources: Readonly<Record<string, IllustratorOpaqueResource>>; diagnostics: readonly IllustratorDiagnostic[]
  unsupportedFeatures: readonly IllustratorUnsupportedFeature[]; sourceFingerprint: IllustratorVersionFingerprint
  fidelity: IllustratorFidelity
}
export interface IllustratorSupportReport {
  fidelity: IllustratorFidelity; exactFeatures: readonly string[]; highFeatures: readonly string[]
  partialFeatures: readonly string[]; structureOnlyFeatures: readonly string[]
  unsupportedFeatures: readonly IllustratorUnsupportedFeature[]
  unknownOperators: Readonly<Record<string, number>>; diagnostics: readonly IllustratorDiagnostic[]
}
export interface IllustratorDocumentSummary {
  sourceKind: IllustratorContainerInspection['kind']; compression?: IllustratorContainerInspection['compression']
  artboards: number; layers: number; nodes: number; paths: number; textFrames: number; resources: number
  fidelity: IllustratorFidelity; bounds?: Bounds; sourceFingerprint: IllustratorVersionFingerprint
}

export interface InspectOptions { limits?: Partial<IllustratorLimits>; signal?: AbortSignal; timeoutMs?: number; mime?: string }
export interface DecodeOptions extends InspectOptions { strictSourceTermination?: boolean }
export interface LexOptions { limits?: Partial<IllustratorLimits>; signal?: AbortSignal; timeoutMs?: number }
export interface ParseOptions extends LexOptions { sourceFingerprint?: IllustratorVersionFingerprint }
export interface LowerOptions extends LexOptions { sourceFingerprint?: IllustratorVersionFingerprint }
export interface RenderOptions {
  artboardId?: string; viewport?: Bounds; width?: number; height?: number; dpr?: number; background?: string
  hiddenLayerIds?: readonly string[]; maxPixels?: number; revision?: number; signal?: AbortSignal
}
export interface SvgExportOptions extends RenderOptions { namespace?: string; includeMetadata?: boolean; allowExternalUrls?: boolean; allowForeignObject?: boolean }
export interface SceneExportOptions { includeAstReferences?: boolean; includeOpaqueResourceRaw?: boolean }
export interface RenderResult { width: number; height: number; revision: number; fidelity: IllustratorFidelity; diagnostics: readonly IllustratorDiagnostic[] }
export interface IllustratorFontReference { postScriptName: string; family?: string; style?: string; subset?: boolean }
export interface IllustratorResourceReference { id: string; kind: string; path?: string; uri?: string; sha256?: string }
export interface IllustratorFontResolver { resolve(reference: IllustratorFontReference, signal: AbortSignal): Promise<ArrayBuffer | FontFace | null> }
export interface IllustratorResourceResolver { resolve(reference: IllustratorResourceReference, signal: AbortSignal): Promise<ArrayBuffer | null> }
export interface IllustratorEngineOptions {
  limits?: Partial<IllustratorLimits>; workerUrl?: string | URL; workerFactory?: () => Worker
  zstdDecoder?: (input: Uint8Array, maxOutputBytes: number, signal?: AbortSignal) => Promise<Uint8Array>
  fontResolver?: IllustratorFontResolver; resourceResolver?: IllustratorResourceResolver
  defaultTimeoutMs?: number; forceDirect?: boolean
}
export interface OpenOptions extends DecodeOptions { mode?: 'native' | 'inspect' }
export interface IllustratorEngine { open(input: IllustratorInput, options?: OpenOptions): Promise<IllustratorDocument>; dispose(): void }
export interface IllustratorDocument {
  getSummary(): Promise<IllustratorDocumentSummary>; getArtboards(): Promise<readonly IllustratorArtboard[]>
  getLayerTree(): Promise<readonly IllustratorLayerNode[]>; getSupportReport(): Promise<IllustratorSupportReport>
  getDiagnostics(): Promise<readonly IllustratorDiagnostic[]>; getLosslessAst(): Promise<IllustratorLosslessAst>
  render(target: HTMLCanvasElement, options?: RenderOptions): Promise<RenderResult>
  renderToBitmap(options?: RenderOptions): Promise<ImageBitmap>; exportSvg(options?: SvgExportOptions): Promise<string>
  exportSceneJson(options?: SceneExportOptions): Promise<IllustratorSceneDocument>; trimCache(maxBytes?: number): Promise<void>; dispose(): void
}
