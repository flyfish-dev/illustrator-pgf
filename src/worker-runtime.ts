import type {
  IllustratorDocument,
  IllustratorEngineOptions,
  IllustratorLimits,
} from './types.js'
import type {
  IllustratorWorkerRequest,
  IllustratorWorkerResponse,
  SerializedIllustratorError,
  WorkerBitmapResult,
} from './worker-protocol.js'
import { DirectIllustratorEngine } from './engine.js'
import { IllustratorError } from './errors.js'

export interface IllustratorWorkerRuntimeOptions {
  limits?: Partial<IllustratorLimits>
  defaultTimeoutMs?: number
  zstdDecoder?: IllustratorEngineOptions['zstdDecoder']
}

export interface IllustratorWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<IllustratorWorkerRequest>) => void): void
  postMessage(message: IllustratorWorkerResponse, transfer?: Transferable[]): void
  close?(): void
}

function serializeError(error: unknown): SerializedIllustratorError {
  if (error instanceof IllustratorError) {
    return {
      name: error.name,
      code: error.code,
      stage: error.stage,
      message: error.message,
      diagnostics: error.diagnostics,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { name: error.name, code: 'AI_ABORTED', stage: 'resource', message: error.message || 'The Illustrator operation was aborted.' }
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: 'AI_WORKER_UNEXPECTED',
    stage: 'resource',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  }
}

function sessionIdOf(request: IllustratorWorkerRequest): number | undefined {
  return 'sessionId' in request ? request.sessionId : undefined
}

/** Installs the bounded parser protocol into a Dedicated Worker-like scope. The runtime never fetches network resources. */
export function installIllustratorWorker(
  scope: IllustratorWorkerScope,
  options: IllustratorWorkerRuntimeOptions = {},
): { dispose(): void } {
  const engine = new DirectIllustratorEngine({
    forceDirect: true,
    limits: options.limits,
    defaultTimeoutMs: options.defaultTimeoutMs,
    zstdDecoder: options.zstdDecoder,
  })
  const sessions = new Map<number, IllustratorDocument>()
  const controllers = new Map<number, AbortController>()
  let nextSessionId = 1
  let disposed = false

  const respond = (response: IllustratorWorkerResponse, transfer: Transferable[] = []): void => {
    if (!disposed || response.ok || response.requestId >= 0) scope.postMessage(response, transfer)
  }

  const requireSession = (request: IllustratorWorkerRequest): IllustratorDocument => {
    const sessionId = sessionIdOf(request)
    const session = sessionId === undefined ? undefined : sessions.get(sessionId)
    if (session === undefined) throw new IllustratorError('AI_SESSION_UNKNOWN', 'resource', `Unknown or disposed Illustrator session ${String(sessionId)}.`)
    return session
  }

  const handle = async (request: IllustratorWorkerRequest): Promise<void> => {
    if (!Number.isSafeInteger(request.requestId) || request.requestId < 0) return
    if (request.type === 'cancel') {
      controllers.get(request.targetRequestId)?.abort(new DOMException('The operation was cancelled by the host.', 'AbortError'))
      respond({ requestId: request.requestId, ok: true, result: null })
      return
    }
    if (disposed) {
      respond({ requestId: request.requestId, ok: false, error: serializeError(new IllustratorError('AI_ENGINE_DISPOSED', 'resource', 'Illustrator worker runtime has been disposed.')) })
      return
    }
    if (controllers.has(request.requestId)) {
      respond({ requestId: request.requestId, ok: false, error: serializeError(new IllustratorError('AI_REQUEST_DUPLICATE', 'resource', `Duplicate worker request ID ${request.requestId}.`)) })
      return
    }
    const controller = new AbortController()
    controllers.set(request.requestId, controller)
    try {
      switch (request.type) {
        case 'open': {
          const document = await engine.open(new Uint8Array(request.bytes), { ...request.options, signal: controller.signal })
          const sessionId = nextSessionId++
          sessions.set(sessionId, document)
          respond({ requestId: request.requestId, ok: true, result: { sessionId } })
          return
        }
        case 'getSummary': respond({ requestId: request.requestId, ok: true, result: await requireSession(request).getSummary() }); return
        case 'getArtboards': respond({ requestId: request.requestId, ok: true, result: await requireSession(request).getArtboards() }); return
        case 'getLayers': respond({ requestId: request.requestId, ok: true, result: await requireSession(request).getLayerTree() }); return
        case 'getSupportReport': respond({ requestId: request.requestId, ok: true, result: await requireSession(request).getSupportReport() }); return
        case 'getDiagnostics': respond({ requestId: request.requestId, ok: true, result: await requireSession(request).getDiagnostics() }); return
        case 'getLosslessAst': respond({ requestId: request.requestId, ok: true, result: await requireSession(request).getLosslessAst() }); return
        case 'renderBitmap': {
          const document = requireSession(request)
          const bitmap = await document.renderToBitmap({ ...request.options, signal: controller.signal })
          const support = await document.getSupportReport()
          const result: WorkerBitmapResult = {
            bitmap,
            render: {
              width: bitmap.width,
              height: bitmap.height,
              revision: request.options.revision ?? 0,
              fidelity: support.fidelity,
              diagnostics: support.diagnostics.filter((diagnostic) => diagnostic.stage === 'render'),
            },
          }
          respond({ requestId: request.requestId, ok: true, result }, [bitmap])
          return
        }
        case 'exportSvg': respond({ requestId: request.requestId, ok: true, result: await requireSession(request).exportSvg({ ...request.options, signal: controller.signal }) }); return
        case 'exportScene': respond({ requestId: request.requestId, ok: true, result: await requireSession(request).exportSceneJson(request.options) }); return
        case 'trimCache': await requireSession(request).trimCache(request.maxBytes); respond({ requestId: request.requestId, ok: true, result: null }); return
        case 'disposeSession': {
          const session = requireSession(request)
          session.dispose(); sessions.delete(request.sessionId)
          respond({ requestId: request.requestId, ok: true, result: null })
          return
        }
        case 'disposeEngine': {
          for (const session of sessions.values()) session.dispose()
          sessions.clear(); engine.dispose()
          respond({ requestId: request.requestId, ok: true, result: null })
          disposed = true
          scope.close?.()
          return
        }
      }
    } catch (error) {
      respond({ requestId: request.requestId, ok: false, error: serializeError(error) })
    } finally {
      controllers.delete(request.requestId)
    }
  }

  scope.addEventListener('message', (event) => { void handle(event.data) })
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const controller of controllers.values()) controller.abort(new DOMException('The worker runtime was disposed.', 'AbortError'))
      controllers.clear()
      for (const session of sessions.values()) session.dispose()
      sessions.clear()
      engine.dispose()
    },
  }
}
