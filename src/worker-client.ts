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
import type {
  IllustratorWorkerRequest,
  IllustratorWorkerResponse,
  IllustratorWorkerRequestPayload,
  SerializableOpenOptions,
  SerializableRenderOptions,
  SerializableSvgExportOptions,
  WorkerBitmapResult,
  WorkerOpenResult,
} from './worker-protocol.js'
import { isIllustratorWorkerResponse } from './worker-protocol.js'
import { IllustratorError, isIllustratorError } from './errors.js'
import { inputToBytes } from './util.js'
import { resolveLimits } from './limits.js'

interface PendingRequest {
  resolve(value: unknown): void
  reject(reason: unknown): void
  timer?: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

function deserializeError(error: Extract<IllustratorWorkerResponse, { ok: false }>['error']): IllustratorError {
  const stage = error.stage === 'container' || error.stage === 'decode' || error.stage === 'lex' || error.stage === 'parse' || error.stage === 'lower' || error.stage === 'render' || error.stage === 'resource'
    ? error.stage
    : 'resource'
  const result = new IllustratorError(error.code, stage, error.message, error.diagnostics)
  if (error.stack !== undefined) result.stack = error.stack
  return result
}

function withoutSignal<T extends { signal?: AbortSignal }>(options: T): Omit<T, 'signal'> {
  const { signal: _signal, ...rest } = options
  return rest
}

class WorkerIllustratorDocument implements IllustratorDocument {
  private disposed = false
  private latestRenderRevision = 0
  constructor(private readonly engine: WorkerIllustratorEngine, readonly sessionId: number) {}

  private ensure(): void {
    if (this.disposed) throw new IllustratorError('AI_SESSION_DISPOSED', 'resource', 'Illustrator document session has been disposed.')
  }

  private nextRenderOptions(options: RenderOptions): SerializableRenderOptions {
    const revision = options.revision ?? this.latestRenderRevision + 1
    this.latestRenderRevision = Math.max(this.latestRenderRevision, revision)
    return { ...withoutSignal(options), revision }
  }

  private ensureFresh(result: WorkerBitmapResult): WorkerBitmapResult {
    if (result.render.revision < this.latestRenderRevision) {
      result.bitmap.close()
      throw new IllustratorError('AI_RENDER_STALE', 'render', `Discarded stale render revision ${result.render.revision}; latest is ${this.latestRenderRevision}.`)
    }
    return result
  }

  async getSummary(): Promise<IllustratorDocumentSummary> {
    this.ensure(); return this.engine.request({ type: 'getSummary', sessionId: this.sessionId }) as Promise<IllustratorDocumentSummary>
  }
  async getArtboards(): Promise<readonly IllustratorArtboard[]> {
    this.ensure(); return this.engine.request({ type: 'getArtboards', sessionId: this.sessionId }) as Promise<readonly IllustratorArtboard[]>
  }
  async getLayerTree(): Promise<readonly IllustratorLayerNode[]> {
    this.ensure(); return this.engine.request({ type: 'getLayers', sessionId: this.sessionId }) as Promise<readonly IllustratorLayerNode[]>
  }
  async getSupportReport(): Promise<IllustratorSupportReport> {
    this.ensure(); return this.engine.request({ type: 'getSupportReport', sessionId: this.sessionId }) as Promise<IllustratorSupportReport>
  }
  async getDiagnostics(): Promise<readonly IllustratorDiagnostic[]> {
    this.ensure(); return this.engine.request({ type: 'getDiagnostics', sessionId: this.sessionId }) as Promise<readonly IllustratorDiagnostic[]>
  }
  async getLosslessAst(): Promise<IllustratorLosslessAst> {
    this.ensure(); return this.engine.request({ type: 'getLosslessAst', sessionId: this.sessionId }) as Promise<IllustratorLosslessAst>
  }

  async render(target: HTMLCanvasElement, options: RenderOptions = {}): Promise<RenderResult> {
    this.ensure()
    const renderOptions = this.nextRenderOptions(options)
    const value = this.ensureFresh(await this.engine.request(
      { type: 'renderBitmap', sessionId: this.sessionId, options: renderOptions },
      undefined,
      options.signal,
    ) as WorkerBitmapResult)
    try {
      target.width = value.render.width
      target.height = value.render.height
      const context = target.getContext('2d')
      if (context === null) throw new IllustratorError('AI_CANVAS_CONTEXT', 'render', 'The target canvas has no 2D rendering context.')
      context.clearRect(0, 0, target.width, target.height)
      context.drawImage(value.bitmap, 0, 0)
      return value.render
    } finally {
      value.bitmap.close()
    }
  }

  async renderToBitmap(options: RenderOptions = {}): Promise<ImageBitmap> {
    this.ensure()
    const renderOptions = this.nextRenderOptions(options)
    const value = this.ensureFresh(await this.engine.request(
      { type: 'renderBitmap', sessionId: this.sessionId, options: renderOptions },
      undefined,
      options.signal,
    ) as WorkerBitmapResult)
    return value.bitmap
  }

  async exportSvg(options: SvgExportOptions = {}): Promise<string> {
    this.ensure()
    return this.engine.request(
      { type: 'exportSvg', sessionId: this.sessionId, options: withoutSignal(options) as SerializableSvgExportOptions },
      undefined,
      options.signal,
    ) as Promise<string>
  }

  async exportSceneJson(options: SceneExportOptions = {}): Promise<IllustratorSceneDocument> {
    this.ensure(); return this.engine.request({ type: 'exportScene', sessionId: this.sessionId, options }) as Promise<IllustratorSceneDocument>
  }

  async trimCache(maxBytes?: number): Promise<void> {
    this.ensure(); await this.engine.request({ type: 'trimCache', sessionId: this.sessionId, maxBytes })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.engine.forgetSession(this)
    void this.engine.request({ type: 'disposeSession', sessionId: this.sessionId }).catch(() => undefined)
  }
}

export class WorkerIllustratorEngine implements IllustratorEngine {
  private disposed = false
  private fatal = false
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly sessions = new Set<WorkerIllustratorDocument>()
  private readonly limits
  private readonly onMessage = (event: MessageEvent<unknown>): void => this.handleMessage(event.data)
  private readonly onError = (event: ErrorEvent): void => this.failAll(new IllustratorError('AI_WORKER_ERROR', 'resource', event.message || 'The Illustrator worker failed.'))
  private readonly onMessageError = (): void => this.failAll(new IllustratorError('AI_WORKER_MESSAGE_ERROR', 'resource', 'The Illustrator worker produced an unreadable structured-clone message.'))

  constructor(private readonly worker: Worker, private readonly options: IllustratorEngineOptions = {}) {
    this.limits = resolveLimits(options.limits)
    worker.addEventListener('message', this.onMessage)
    worker.addEventListener('error', this.onError)
    worker.addEventListener('messageerror', this.onMessageError)
  }

  private handleMessage(value: unknown): void {
    if (!isIllustratorWorkerResponse(value)) {
      this.failAll(new IllustratorError('AI_WORKER_PROTOCOL', 'resource', 'The Illustrator worker returned an invalid response.'))
      return
    }
    const pending = this.pending.get(value.requestId)
    if (pending === undefined) {
      if (value.ok && typeof value.result === 'object' && value.result !== null && 'bitmap' in value.result) (value.result as WorkerBitmapResult).bitmap.close()
      return
    }
    this.pending.delete(value.requestId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.removeAbort?.()
    if (value.ok) pending.resolve(value.result)
    else pending.reject(deserializeError(value.error))
  }

  private fatalStop(reason: unknown): void {
    if (this.fatal) return
    this.fatal = true
    this.worker.terminate()
    const error = isIllustratorError(reason)
      ? reason
      : new IllustratorError('AI_WORKER_TERMINATED', 'resource', reason instanceof Error ? reason.message : String(reason))
    for (const [requestId, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.reject(error)
      this.pending.delete(requestId)
    }
  }

  private failAll(reason: unknown): void { this.fatalStop(reason) }

  request(
    request: IllustratorWorkerRequestPayload,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
    timeoutMs = this.options.defaultTimeoutMs ?? this.limits.maxWorkerTimeMs,
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new IllustratorError('AI_ENGINE_DISPOSED', 'resource', 'Illustrator engine has been disposed.'))
    if (this.fatal) return Promise.reject(new IllustratorError('AI_WORKER_TERMINATED', 'resource', 'The Illustrator worker is no longer available. Create a new engine.'))
    if (signal?.aborted === true) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    const requestId = this.nextRequestId++
    const payload = { ...request, requestId } as IllustratorWorkerRequest
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.fatalStop(new IllustratorError('AI_WORKER_TIMEOUT', 'resource', `The Illustrator worker exceeded the ${timeoutMs} ms request timeout.`))
        }, timeoutMs)
      }
      if (signal !== undefined) {
        const onAbort = (): void => this.fatalStop(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
        signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(requestId, pending)
      try {
        this.worker.postMessage(payload, transfer)
      } catch (error) {
        this.pending.delete(requestId)
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        pending.removeAbort?.()
        reject(error)
      }
    })
  }

  async open(input: IllustratorInput, options: OpenOptions = {}): Promise<IllustratorDocument> {
    if (this.disposed) throw new IllustratorError('AI_ENGINE_DISPOSED', 'resource', 'Illustrator engine has been disposed.')
    const source = await inputToBytes(input)
    const owned = source.slice()
    const openOptions: SerializableOpenOptions = {
      ...withoutSignal(options),
      limits: { ...this.options.limits, ...options.limits },
      timeoutMs: options.timeoutMs ?? this.options.defaultTimeoutMs,
    }
    const result = await this.request(
      { type: 'open', bytes: owned.buffer, options: openOptions },
      [owned.buffer],
      options.signal,
      openOptions.timeoutMs,
    ) as WorkerOpenResult
    const document = new WorkerIllustratorDocument(this, result.sessionId)
    this.sessions.add(document)
    return document
  }

  forgetSession(session: WorkerIllustratorDocument): void { this.sessions.delete(session) }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const session of [...this.sessions]) session.dispose()
    this.sessions.clear()
    if (!this.fatal) {
      try { this.worker.postMessage({ type: 'disposeEngine', requestId: this.nextRequestId++ } satisfies IllustratorWorkerRequest) } catch { /* already stopping */ }
      this.worker.terminate()
    }
    this.fatalStop(new IllustratorError('AI_ENGINE_DISPOSED', 'resource', 'Illustrator engine has been disposed.'))
  }
}
