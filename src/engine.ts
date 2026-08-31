import type {
  IllustratorArtboard,
  IllustratorDiagnostic,
  IllustratorDocument,
  IllustratorDocumentSummary,
  IllustratorEngine,
  IllustratorEngineOptions,
  IllustratorInput,
  IllustratorLayerNode,
  IllustratorLosslessAst,
  IllustratorSceneDocument,
  IllustratorSupportReport,
  OpenOptions,
  RenderOptions,
  RenderResult,
  SceneExportOptions,
  SvgExportOptions,
} from './types.js'
import type { ContainerRuntimeOptions } from './container.js'
import { decodeIllustratorPrivateSource } from './container.js'
import { parseIllustratorSource } from './ast.js'
import { lowerIllustratorAst } from './semantic.js'
import { renderIllustratorScene } from './render-canvas.js'
import { exportIllustratorSvg } from './render-svg.js'
import { collectDiagnostics, createIllustratorSupportReport, getIllustratorDocumentSummary } from './scene.js'
import { IllustratorError } from './errors.js'
import { inputToBytes } from './util.js'
import { resolveLimits } from './limits.js'
import { createBrowserCodecProvider } from './codecs.js'
import { WorkerIllustratorEngine } from './worker-client.js'

interface ParsedDocumentData {
  ast: IllustratorLosslessAst
  scene: IllustratorSceneDocument
  diagnostics: readonly IllustratorDiagnostic[]
}

export async function parseIllustratorDocument(
  input: IllustratorInput,
  options: OpenOptions = {},
  runtime: ContainerRuntimeOptions = {},
): Promise<ParsedDocumentData> {
  const decoded = await decodeIllustratorPrivateSource(input, options, runtime)
  const ast = parseIllustratorSource(decoded.bytes, { ...options, sourceFingerprint: decoded.fingerprint })
  const lowered = lowerIllustratorAst(ast, { ...options, sourceFingerprint: decoded.fingerprint })
  const scene: IllustratorSceneDocument = {
    ...lowered,
    diagnostics: [...decoded.diagnostics, ...lowered.diagnostics],
  }
  const diagnostics = collectDiagnostics(scene)
  return { ast, scene, diagnostics }
}

class DirectIllustratorDocument implements IllustratorDocument {
  private disposed = false
  private ast?: IllustratorLosslessAst
  private scene?: IllustratorSceneDocument
  private diagnostics?: readonly IllustratorDiagnostic[]
  constructor(data: ParsedDocumentData, private readonly onDispose: () => void) {
    this.ast = data.ast; this.scene = data.scene; this.diagnostics = data.diagnostics
  }
  private ensure(): { ast: IllustratorLosslessAst; scene: IllustratorSceneDocument; diagnostics: readonly IllustratorDiagnostic[] } {
    if (this.disposed || this.ast === undefined || this.scene === undefined || this.diagnostics === undefined) throw new IllustratorError('AI_SESSION_DISPOSED', 'resource', 'Illustrator document session has been disposed.')
    return { ast: this.ast, scene: this.scene, diagnostics: this.diagnostics }
  }
  async getSummary(): Promise<IllustratorDocumentSummary> { return getIllustratorDocumentSummary(this.ensure().scene) }
  async getArtboards(): Promise<readonly IllustratorArtboard[]> { return this.ensure().scene.artboards }
  async getLayerTree(): Promise<readonly IllustratorLayerNode[]> { return this.ensure().scene.layers }
  async getSupportReport(): Promise<IllustratorSupportReport> { return createIllustratorSupportReport(this.ensure().scene) }
  async getDiagnostics(): Promise<readonly IllustratorDiagnostic[]> { return this.ensure().diagnostics }
  async getLosslessAst(): Promise<IllustratorLosslessAst> { return this.ensure().ast }
  async render(target: HTMLCanvasElement, options: RenderOptions = {}): Promise<RenderResult> { return renderIllustratorScene(this.ensure().scene, target, options) }
  async renderToBitmap(options: RenderOptions = {}): Promise<ImageBitmap> {
    const scene = this.ensure().scene
    if (typeof OffscreenCanvas === 'undefined') throw new IllustratorError('AI_OFFSCREEN_UNAVAILABLE', 'render', 'OffscreenCanvas is unavailable; render into an HTMLCanvasElement instead.')
    const artboard = options.artboardId === undefined ? scene.artboards[0] : scene.artboards.find((candidate) => candidate.id === options.artboardId)
    const viewport = options.viewport ?? artboard?.bounds
    if (viewport === undefined) throw new IllustratorError('AI_VIEWPORT_MISSING', 'render', 'No artboard or viewport is available for bitmap rendering.')
    const width = Math.max(1, Math.round(options.width ?? viewport.right - viewport.left))
    const height = Math.max(1, Math.round(options.height ?? viewport.top - viewport.bottom))
    const canvas = new OffscreenCanvas(width, height)
    await renderIllustratorScene(scene, canvas, { ...options, width, height, dpr: 1 })
    return canvas.transferToImageBitmap()
  }
  async exportSvg(options: SvgExportOptions = {}): Promise<string> { return exportIllustratorSvg(this.ensure().scene, options) }
  async exportSceneJson(options: SceneExportOptions = {}): Promise<IllustratorSceneDocument> {
    const scene = structuredClone(this.ensure().scene)
    if (options.includeOpaqueResourceRaw === false) for (const resource of Object.values(scene.resources)) resource.raw = ''
    if (options.includeAstReferences === false) {
      const visit = (node: typeof scene.children[number]): void => {
        node.rawStatementIndices = []
        if (node.type === 'Layer' || node.type === 'Group' || node.type === 'ClipGroup' || node.type === 'SymbolDefinition') for (const child of node.children) visit(child)
      }
      for (const child of scene.children) visit(child)
    }
    return scene
  }
  async trimCache(_maxBytes?: number): Promise<void> { this.ensure() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.ast = undefined; this.scene = undefined; this.diagnostics = undefined; this.onDispose()
  }
}

export class DirectIllustratorEngine implements IllustratorEngine {
  private disposed = false
  private readonly sessions = new Set<DirectIllustratorDocument>()
  private readonly runtime: ContainerRuntimeOptions
  constructor(private readonly options: IllustratorEngineOptions = {}, runtime: ContainerRuntimeOptions = {}) {
    this.runtime = runtime.codecProvider === undefined && runtime.zstdDecoder === undefined
      ? { codecProvider: createBrowserCodecProvider(options.zstdDecoder) }
      : runtime
  }
  async open(input: IllustratorInput, options: OpenOptions = {}): Promise<IllustratorDocument> {
    if (this.disposed) throw new IllustratorError('AI_ENGINE_DISPOSED', 'resource', 'Illustrator engine has been disposed.')
    const limits = resolveLimits({ ...this.options.limits, ...options.limits })
    const bytes = await inputToBytes(input)
    const data = await parseIllustratorDocument(bytes, { ...options, limits, timeoutMs: options.timeoutMs ?? this.options.defaultTimeoutMs }, this.runtime)
    let document!: DirectIllustratorDocument
    document = new DirectIllustratorDocument(data, () => this.sessions.delete(document))
    this.sessions.add(document)
    return document
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const session of [...this.sessions]) session.dispose()
    this.sessions.clear()
  }
}

export async function createIllustratorEngine(options: IllustratorEngineOptions = {}): Promise<IllustratorEngine> {
  if (options.forceDirect === true) return new DirectIllustratorEngine(options)
  if (options.workerFactory !== undefined) return new WorkerIllustratorEngine(options.workerFactory(), options)
  if (typeof Worker === 'undefined') throw new IllustratorError('AI_WORKER_REQUIRED', 'resource', 'Production browser parsing requires a Dedicated Worker. Use the Node entry point or explicitly set forceDirect only for controlled diagnostics/tests.')
  const workerUrl = options.workerUrl ?? new URL('./worker-entry.js', import.meta.url)
  return new WorkerIllustratorEngine(new Worker(workerUrl, { type: 'module', name: 'illustrator-pgf' }), options)
}
