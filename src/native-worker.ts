import {
  openNativeIllustratorDocument,
  type NativeIllustratorDocumentSession,
  type OpenNativeIllustratorOptions,
} from './native-pipeline.js'

export type NativeIllustratorWorkerRequest =
  | Readonly<{
      id: number
      type: 'open'
      bytes: ArrayBuffer
      options?: Omit<
        OpenNativeIllustratorOptions,
        'operationBudget' | 'decodeOptions'
      >
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
  decodeOptions?: OpenNativeIllustratorOptions['decodeOptions']
}

function asRequest(value: unknown): NativeIllustratorWorkerRequest | undefined {
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

function serializeError(error: unknown): Readonly<{
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
    throw new RangeError('maximumSessions must be a positive safe integer.')
  }
  const sessions = new Map<string, NativeIllustratorDocumentSession>()
  let sequence = 0
  let disposed = false

  const reply = (
    response: NativeIllustratorWorkerResponse,
  ): void => scope.postMessage(response)

  const session = (id: string): NativeIllustratorDocumentSession => {
    const value = sessions.get(id)
    if (value === undefined) throw new Error(`Unknown native session ${id}.`)
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
    const request = asRequest(event.data)
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
              ...request.options,
              decodeOptions: options.decodeOptions,
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
            value: session(request.sessionId).toSvg(request.options),
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
          error: serializeError(error),
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
