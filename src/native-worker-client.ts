import type {
  NativeIllustratorWorkerRequest,
  NativeIllustratorWorkerResponse,
} from './native-worker.js'
import type {
  NativeIllustratorSummary,
  OpenNativeIllustratorOptions,
} from './native-pipeline.js'
import type { NativeRenderPlanV2 } from './native-render-plan-v2.js'

export interface NativeWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  addEventListener(
    type: 'error' | 'messageerror',
    listener: (event: Event) => void,
  ): void
  removeEventListener?(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  removeEventListener?(
    type: 'error' | 'messageerror',
    listener: (event: Event) => void,
  ): void
  terminate(): void
}

export interface NativeWorkerRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

type Pending = {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abort?: () => void
}

function isResponse(value: unknown): value is NativeIllustratorWorkerResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Number.isSafeInteger(record.id)
    && typeof record.ok === 'boolean'
    && typeof record.type === 'string'
}

function responseError(
  response: Extract<NativeIllustratorWorkerResponse, { ok: false }>,
): Error {
  const error = new Error(response.error.message)
  error.name = response.error.name
  if (response.error.stack !== undefined) error.stack = response.error.stack
  return error
}

export class NativeIllustratorWorkerClient {
  readonly #worker: NativeWorkerLike
  readonly #pending = new Map<number, Pending>()
  #requestId = 0
  #fatal: Error | undefined

  constructor(worker: NativeWorkerLike) {
    this.#worker = worker
    worker.addEventListener('message', this.#onMessage)
    worker.addEventListener('error', this.#onFatal)
    worker.addEventListener('messageerror', this.#onFatal)
  }

  get disposed(): boolean { return this.#fatal !== undefined }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (!isResponse(event.data)) return
    const pending = this.#pending.get(event.data.id)
    if (pending === undefined) return
    this.#pending.delete(event.data.id)
    this.#cleanupPending(pending)
    if (event.data.ok) pending.resolve(event.data.value)
    else pending.reject(responseError(event.data))
  }

  readonly #onFatal = (event: Event): void => {
    const record = event as Event & {
      error?: unknown
      message?: string
    }
    const error = record.error instanceof Error
      ? record.error
      : new Error(record.message ?? `Native worker ${event.type}.`)
    this.#terminate(error)
  }

  #cleanupPending(pending: Pending): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener('abort', pending.abort)
    }
  }

  #terminate(error: Error): void {
    if (this.#fatal !== undefined) return
    this.#fatal = error
    this.#worker.removeEventListener?.('message', this.#onMessage)
    this.#worker.removeEventListener?.('error', this.#onFatal)
    this.#worker.removeEventListener?.('messageerror', this.#onFatal)
    this.#worker.terminate()
    for (const pending of this.#pending.values()) {
      this.#cleanupPending(pending)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #request<T>(
    request: Omit<NativeIllustratorWorkerRequest, 'id'>,
    options: NativeWorkerRequestOptions = {},
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.#fatal !== undefined) return Promise.reject(this.#fatal)
    if (options.signal?.aborted === true) {
      const error = new DOMException('Worker request aborted.', 'AbortError')
      this.#terminate(error)
      return Promise.reject(error)
    }
    const id = ++this.#requestId
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        resolve: (value) => resolve(value as T),
        reject,
      }
      if (options.timeoutMs !== undefined) {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          reject(new RangeError('timeoutMs must be a positive finite number.'))
          return
        }
        pending.timer = setTimeout(() => {
          const error = new DOMException(
            `Worker request ${id} timed out.`,
            'TimeoutError',
          )
          this.#terminate(error)
        }, options.timeoutMs)
      }
      if (options.signal !== undefined) {
        pending.signal = options.signal
        pending.abort = () => {
          const error = new DOMException(
            `Worker request ${id} aborted.`,
            'AbortError',
          )
          this.#terminate(error)
        }
        options.signal.addEventListener('abort', pending.abort, { once: true })
      }
      this.#pending.set(id, pending)
      try {
        this.#worker.postMessage({ ...request, id }, transfer)
      } catch (error) {
        this.#pending.delete(id)
        this.#cleanupPending(pending)
        reject(error)
      }
    })
  }

  open(
    bytes: Uint8Array,
    options: NativeWorkerRequestOptions & Readonly<{
      document?: Omit<
        OpenNativeIllustratorOptions,
        'operationBudget' | 'decodeOptions'
      >
    }> = {},
  ): Promise<Readonly<{
    sessionId: string
    summary: NativeIllustratorSummary
  }>> {
    const owned = new Uint8Array(bytes.byteLength)
    owned.set(bytes)
    const buffer = owned.buffer
    return this.#request(
      {
        type: 'open',
        bytes: buffer,
        ...(options.document === undefined
          ? {}
          : { options: options.document }),
      },
      options,
      [buffer],
    )
  }

  summary(
    sessionId: string,
    options?: NativeWorkerRequestOptions,
  ): Promise<NativeIllustratorSummary> {
    return this.#request(
      { type: 'summary', sessionId },
      options,
    )
  }

  ast<T = unknown>(
    sessionId: string,
    options?: NativeWorkerRequestOptions,
  ): Promise<T> {
    return this.#request({ type: 'ast', sessionId }, options)
  }

  scene<T = unknown>(
    sessionId: string,
    options?: NativeWorkerRequestOptions,
  ): Promise<T> {
    return this.#request({ type: 'scene', sessionId }, options)
  }

  renderPlan(
    sessionId: string,
    options?: NativeWorkerRequestOptions,
  ): Promise<NativeRenderPlanV2> {
    return this.#request({ type: 'render-plan', sessionId }, options)
  }

  svg(
    sessionId: string,
    svgOptions: Readonly<{
      width?: number
      height?: number
      namespace?: string
    }> = {},
    options?: NativeWorkerRequestOptions,
  ): Promise<string> {
    return this.#request(
      { type: 'svg', sessionId, options: svgOptions },
      options,
    )
  }

  disposeSession(
    sessionId: string,
    options?: NativeWorkerRequestOptions,
  ): Promise<boolean> {
    return this.#request({ type: 'dispose', sessionId }, options)
  }

  dispose(): void {
    this.#terminate(new Error('Native Illustrator worker client disposed.'))
  }
}
