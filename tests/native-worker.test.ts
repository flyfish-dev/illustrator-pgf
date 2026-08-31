import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NativeIllustratorWorkerClient,
  installNativeIllustratorWorker,
  type NativeIllustratorWorkerResponse,
  type NativeIllustratorWorkerScope,
  type NativeWorkerLike,
} from '../src/native-worker.js'
import { DIRECT_SOURCE_BYTES } from './fixtures.js'

type MessageListener = (event: MessageEvent<unknown>) => void
type ErrorListener = (event: Event) => void

class FakeNativeWorker implements NativeWorkerLike {
  readonly messages: unknown[] = []
  readonly transfers: Transferable[][] = []
  terminated = false
  autoRespond = true
  readonly #messageListeners = new Set<MessageListener>()
  readonly #errorListeners = new Set<ErrorListener>()
  readonly #messageErrorListeners = new Set<ErrorListener>()

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.messages.push(message)
    this.transfers.push(transfer)
    if (!this.autoRespond) return
    const record = message as {
      id: number
      type: string
    }
    queueMicrotask(() => {
      this.emitMessage({
        id: record.id,
        ok: true,
        type: record.type,
        value: record.type === 'open'
          ? { sessionId: 'fake-session', summary: {} }
          : true,
      })
    })
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: MessageListener | ErrorListener,
  ): void {
    if (type === 'message') {
      this.#messageListeners.add(listener as MessageListener)
    } else if (type === 'error') {
      this.#errorListeners.add(listener as ErrorListener)
    } else {
      this.#messageErrorListeners.add(listener as ErrorListener)
    }
  }

  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: MessageListener | ErrorListener,
  ): void {
    if (type === 'message') {
      this.#messageListeners.delete(listener as MessageListener)
    } else if (type === 'error') {
      this.#errorListeners.delete(listener as ErrorListener)
    } else {
      this.#messageErrorListeners.delete(listener as ErrorListener)
    }
  }

  terminate(): void {
    this.terminated = true
  }

  emitMessage(value: unknown): void {
    const event = { data: value } as MessageEvent<unknown>
    for (const listener of this.#messageListeners) listener(event)
  }

  emitError(type: 'error' | 'messageerror', message: string): void {
    const event = { type, message } as Event & { message: string }
    const listeners = type === 'error'
      ? this.#errorListeners
      : this.#messageErrorListeners
    for (const listener of listeners) listener(event)
  }
}

class FakeNativeWorkerScope implements NativeIllustratorWorkerScope {
  readonly #listeners = new Set<MessageListener>()
  readonly #responses: NativeIllustratorWorkerResponse[] = []
  readonly #waiters: Array<(
    response: NativeIllustratorWorkerResponse,
  ) => void> = []

  addEventListener(
    _type: 'message',
    listener: MessageListener,
  ): void {
    this.#listeners.add(listener)
  }

  removeEventListener(
    _type: 'message',
    listener: MessageListener,
  ): void {
    this.#listeners.delete(listener)
  }

  postMessage(response: NativeIllustratorWorkerResponse): void {
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#responses.push(response)
    else waiter(response)
  }

  dispatch(value: unknown): void {
    const event = { data: value } as MessageEvent<unknown>
    for (const listener of this.#listeners) listener(event)
  }

  nextResponse(): Promise<NativeIllustratorWorkerResponse> {
    const response = this.#responses.shift()
    if (response !== undefined) return Promise.resolve(response)
    return new Promise((resolve) => this.#waiters.push(resolve))
  }
}

test('native worker client transfers an owned ArrayBuffer', async () => {
  const worker = new FakeNativeWorker()
  const client = new NativeIllustratorWorkerClient(worker)
  const input = Uint8Array.of(1, 2, 3)
  const opened = await client.open(input)
  assert.equal(opened.sessionId, 'fake-session')
  assert.equal(worker.messages.length, 1)
  assert.equal(worker.transfers[0]?.length, 1)
  const request = worker.messages[0] as {
    bytes: ArrayBuffer
  }
  assert.ok(request.bytes instanceof ArrayBuffer)
  assert.notEqual(request.bytes, input.buffer)
  assert.equal(request.bytes.byteLength, input.byteLength)
  client.dispose()
})

test('pre-aborted native worker request terminates the actual worker', async () => {
  const worker = new FakeNativeWorker()
  const client = new NativeIllustratorWorkerClient(worker)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => client.open(Uint8Array.of(1), { signal: controller.signal }),
    (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError',
  )
  assert.equal(worker.terminated, true)
  assert.equal(client.disposed, true)
})

test('native worker request timeout terminates the actual worker and rejects pending work', async () => {
  const worker = new FakeNativeWorker()
  worker.autoRespond = false
  const client = new NativeIllustratorWorkerClient(worker)
  await assert.rejects(
    () => client.summary('never-responds', { timeoutMs: 5 }),
    (error: unknown) =>
      error instanceof DOMException && error.name === 'TimeoutError',
  )
  assert.equal(worker.terminated, true)
  assert.equal(client.disposed, true)
})

test('native worker messageerror is fatal and prevents reuse', async () => {
  const worker = new FakeNativeWorker()
  worker.autoRespond = false
  const client = new NativeIllustratorWorkerClient(worker)
  const pending = client.summary('pending')
  worker.emitError('messageerror', 'clone failed')
  await assert.rejects(() => pending, /clone failed/iu)
  await assert.rejects(() => client.summary('again'), /clone failed/iu)
  assert.equal(worker.terminated, true)
})

test('native worker runtime opens, queries and disposes a real session', async () => {
  const scope = new FakeNativeWorkerScope()
  const runtime = installNativeIllustratorWorker(scope, {
    maximumSessions: 1,
  })
  const owned = new Uint8Array(DIRECT_SOURCE_BYTES.byteLength)
  owned.set(DIRECT_SOURCE_BYTES)
  scope.dispatch({
    id: 1,
    type: 'open',
    bytes: owned.buffer as ArrayBuffer,
  })
  const opened = await scope.nextResponse()
  assert.equal(opened.ok, true)
  const value = opened.ok
    ? opened.value as { sessionId: string }
    : undefined
  assert.equal(typeof value?.sessionId, 'string')

  scope.dispatch({
    id: 2,
    type: 'summary',
    sessionId: value?.sessionId,
  })
  const summary = await scope.nextResponse()
  assert.equal(summary.ok, true)

  scope.dispatch({
    id: 3,
    type: 'dispose',
    sessionId: value?.sessionId,
  })
  const disposed = await scope.nextResponse()
  assert.equal(disposed.ok, true)
  assert.equal(disposed.ok ? disposed.value : false, true)
  runtime.dispose()
})
