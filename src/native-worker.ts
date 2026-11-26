import type {
  NativeFidelity,
  NativeFidelityEvidence,
} from './native-foundation.js'
import {
  openNativeIllustratorDocument,
  type NativeIllustratorDocumentSession,
  type NativeIllustratorSummary,
} from './native-pipeline.js'
import type { NativeRenderPlan } from './native-render.js'
import type { NativeSecurityLimits } from './native-verification.js'

export interface NativeSerializableOpenOptions {
  evidence?: readonly NativeFidelityEvidence[]
  requestedFidelity?: NativeFidelity
  resourceCacheBytes?: number
  securityLimits?: Readonly<Partial<NativeSecurityLimits>>
}

export type NativeIllustratorWorkerRequest =
  | Readonly<{
      id: number
      type: 'open'
      bytes: ArrayBuffer
      options?: NativeSerializableOpenOptions
    }>
  | Readonly<{ id: number; type: 'summary'; sessionId: string }>
  | Readonly<{ id: number; type: 'ast'; sessionId: string }>
  | Readonly<{ id: number; type: 'scene'; sessionId: string }>
  | Readonly<{ id: number; type: 'render-plan'; sessionId: string }>
  | Readonly<{
      id: number
      type: 'svg'
      sessionId: string
      options?: Readonly<{
        width?: number
        height?: number
        namespace?: string
      }>
    }>
  | Readonly<{ id: number; type: 'dispose'; sessionId: string }>
  | Readonly<{ id: number; type: 'dispose-all' }>

export type NativeIllustratorWorkerResponse =
  | Readonly<{
      id: number
      ok: true
      type: NativeIllustratorWorkerRequest['type']
      value?: unknown
    }>
  | Readonly<{
      id: number
      ok: false
      type: NativeIllustratorWorkerRequest['type'] | 'invalid'
      error: Readonly<{
        name: string
        message: string
        stack?: string
      }>
    }>

export interface NativeIllustratorWorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  removeEventListener?(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  postMessage(message: NativeIllustratorWorkerResponse): void
}

export interface InstallNativeIllustratorWorkerOptions {
  maximumSessions?: number
  decodeOptions?: unknown
  parseOptions?: unknown
}

function asWorkerRequest(
  value: unknown,
): NativeIllustratorWorkerRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.id) || typeof record.type !== 'string') {
    return undefined
  }
  const valid = new Set([
    'open',
    'summary',
    'ast',
    'scene',
    'render-plan',
    'svg',
    'dispose',
    'dispose-all',
  ])
  return valid.has(record.type)
    ? value as NativeIllustratorWorkerRequest
    : undefined
}

function serializeWorkerError(error: unknown): Readonly<{
  name: string
  message: string
  stack?: string
}> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
  }
  return { name: 'Error', message: String(error) }
}

export function installNativeIllustratorWorker(
  scope: NativeIllustratorWorkerScope,
  options: InstallNativeIllustratorWorkerOptions = {},
): Readonly<{ dispose(): void }> {
  const maximumSessions = options.maximumSessions ?? 8
  if (!Number.isSafeInteger(maximumSessions) || maximumSessions < 1) {
    throw new RangeError(
      'maximumSessions must be a positive safe integer.',
    )
  }
  const sessions = new Map<string, NativeIllustratorDocumentSession>()
  let sequence = 0
  let disposed = false

  const reply = (response: NativeIllustratorWorkerResponse): void => {
    scope.postMessage(response)
  }

  const session = (id: string): NativeIllustratorDocumentSession => {
    const value = sessions.get(id)
    if (value === undefined) {
      throw new Error(`Unknown native Illustrator session ${id}.`)
    }
    sessions.delete(id)
    sessions.set(id, value)
    return value
  }

  const enforceSessionLimit = (): void => {
    while (sessions.size > maximumSessions) {
      const oldest = sessions.entries().next().value as
        | [string, NativeIllustratorDocumentSession]
        | undefined
      if (oldest === undefined) break
      sessions.delete(oldest[0])
      oldest[1].dispose()
    }
  }

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (disposed) return
    const request = asWorkerRequest(event.data)
    if (request === undefined) {
      reply({
        id: -1,
        ok: false,
        type: 'invalid',
        error: {
          name: 'TypeError',
          message: 'Worker request is malformed.',
        },
      })
      return
    }
    void (async () => {
      try {
        if (request.type === 'open') {
          if (!(request.bytes instanceof ArrayBuffer)) {
            throw new TypeError('open.bytes must be an ArrayBuffer.')
          }
          const opened = await openNativeIllustratorDocument(
            new Uint8Array(request.bytes),
            {
              ...(request.options ?? {}),
              decodeOptions: options.decodeOptions,
              parseOptions: options.parseOptions,
            },
          )
          const sessionId = `native-${++sequence}`
          sessions.set(sessionId, opened)
          enforceSessionLimit()
          reply({
            id: request.id,
            ok: true,
            type: request.type,
            value: {
              sessionId,
              summary: opened.summary(),
            },
          })
        } else if (request.type === 'summary') {
          reply({
            id: request.id,
            ok: true,
            type: request.type,
            value: session(request.sessionId).summary(),
          })
        } else if (request.type === 'ast') {
          reply({
            id: request.id,
            ok: true,
            type: request.type,
            value: session(request.sessionId).ast,
          })
        } else if (request.type === 'scene') {
          reply({
            id: request.id,
            ok: true,
            type: request.type,
            value: session(request.sessionId).scene,
          })
        } else if (request.type === 'render-plan') {
          reply({
            id: request.id,
            ok: true,
            type: request.type,
            value: session(request.sessionId).renderPlan,
          })
        } else if (request.type === 'svg') {
          reply({
            id: request.id,
            ok: true,
            type: request.type,
            value: session(request.sessionId).toSvg(
              request.options ?? {},
            ),
          })
        } else if (request.type === 'dispose') {
          const value = sessions.get(request.sessionId)
          sessions.delete(request.sessionId)
          value?.dispose()
          reply({
            id: request.id,
            ok: true,
            type: request.type,
            value: true,
          })
        } else {
          for (const value of sessions.values()) value.dispose()
          sessions.clear()
          reply({
            id: request.id,
            ok: true,
            type: request.type,
            value: true,
          })
        }
      } catch (error) {
        reply({
          id: request.id,
          ok: false,
          type: request.type,
          error: serializeWorkerError(error),
        })
      }
    })()
  }

  scope.addEventListener('message', onMessage)
  return {
    dispose() {
      if (disposed) return
      disposed = true
      scope.removeEventListener?.('message', onMessage)
      for (const value of sessions.values()) value.dispose()
      sessions.clear()
    },
  }
}

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

type PendingWorkerRequest = {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abort?: () => void
}

type WithoutWorkerId<T> = T extends unknown ? Omit<T, 'id'> : never
type NativeWorkerRequestWithoutId = WithoutWorkerId<
  NativeIllustratorWorkerRequest
>

function isWorkerResponse(
  value: unknown,
): value is NativeIllustratorWorkerResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Number.isSafeInteger(record.id)
    && typeof record.ok === 'boolean'
    && typeof record.type === 'string'
}

function deserializeWorkerError(
  response: Extract<NativeIllustratorWorkerResponse, { ok: false }>,
): Error {
  const error = new Error(response.error.message)
  error.name = response.error.name
  if (response.error.stack !== undefined) error.stack = response.error.stack
  return error
}

export class NativeIllustratorWorkerClient {
  readonly #worker: NativeWorkerLike
  readonly #pending = new Map<number, PendingWorkerRequest>()
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
    if (!isWorkerResponse(event.data)) return
    const pending = this.#pending.get(event.data.id)
    if (pending === undefined) return
    this.#pending.delete(event.data.id)
    this.#cleanupPending(pending)
    if (event.data.ok) pending.resolve(event.data.value)
    else pending.reject(deserializeWorkerError(event.data))
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

  #cleanupPending(pending: PendingWorkerRequest): void {
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
    request: NativeWorkerRequestWithoutId,
    options: NativeWorkerRequestOptions = {},
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.#fatal !== undefined) return Promise.reject(this.#fatal)
    if (options.signal?.aborted === true) {
      const error = new DOMException(
        'Worker request aborted.',
        'AbortError',
      )
      this.#terminate(error)
      return Promise.reject(error)
    }
    const id = ++this.#requestId
    return new Promise<T>((resolve, reject) => {
      const pending: PendingWorkerRequest = {
        resolve: (value) => resolve(value as T),
        reject,
      }
      if (options.timeoutMs !== undefined) {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          reject(new RangeError(
            'timeoutMs must be a positive finite number.',
          ))
          return
        }
        pending.timer = setTimeout(() => {
          this.#terminate(new DOMException(
            `Worker request ${id} timed out.`,
            'TimeoutError',
          ))
        }, options.timeoutMs)
      }
      if (options.signal !== undefined) {
        pending.signal = options.signal
        pending.abort = () => {
          this.#terminate(new DOMException(
            `Worker request ${id} aborted.`,
            'AbortError',
          ))
        }
        options.signal.addEventListener(
          'abort',
          pending.abort,
          { once: true },
        )
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
      document?: NativeSerializableOpenOptions
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
    options: NativeWorkerRequestOptions = {},
  ): Promise<NativeIllustratorSummary> {
    return this.#request({ type: 'summary', sessionId }, options)
  }

  ast<T = unknown>(
    sessionId: string,
    options: NativeWorkerRequestOptions = {},
  ): Promise<T> {
    return this.#request({ type: 'ast', sessionId }, options)
  }

  scene<T = unknown>(
    sessionId: string,
    options: NativeWorkerRequestOptions = {},
  ): Promise<T> {
    return this.#request({ type: 'scene', sessionId }, options)
  }

  renderPlan(
    sessionId: string,
    options: NativeWorkerRequestOptions = {},
  ): Promise<NativeRenderPlan> {
    return this.#request(
      { type: 'render-plan', sessionId },
      options,
    )
  }

  svg(
    sessionId: string,
    svgOptions: Readonly<{
      width?: number
      height?: number
      namespace?: string
    }> = {},
    options: NativeWorkerRequestOptions = {},
  ): Promise<string> {
    return this.#request(
      { type: 'svg', sessionId, options: svgOptions },
      options,
    )
  }

  disposeSession(
    sessionId: string,
    options: NativeWorkerRequestOptions = {},
  ): Promise<boolean> {
    return this.#request(
      { type: 'dispose', sessionId },
      options,
    )
  }

  disposeAll(
    options: NativeWorkerRequestOptions = {},
  ): Promise<boolean> {
    return this.#request({ type: 'dispose-all' }, options)
  }

  dispose(): void {
    this.#terminate(
      new Error('Native Illustrator worker client disposed.'),
    )
  }
}
