import test from 'node:test'
import assert from 'node:assert/strict'
import { createIllustratorEngine } from '../src/node.js'
import { WorkerIllustratorEngine } from '../src/worker-client.js'
import { installIllustratorWorker, type IllustratorWorkerScope } from '../src/worker-runtime.js'
import type { IllustratorWorkerRequest, IllustratorWorkerResponse } from '../src/worker-protocol.js'
import { DIRECT_SOURCE_BYTES } from './fixtures.js'

class LinkedWorker {
  readonly main = new Map<string, Set<(event: any) => void>>()
  readonly worker = new Set<(event: MessageEvent<IllustratorWorkerRequest>) => void>()
  terminated = false
  readonly runtime
  constructor() {
    const scope: IllustratorWorkerScope = {
      addEventListener: (_type, listener) => { this.worker.add(listener) },
      postMessage: (message: IllustratorWorkerResponse) => {
        queueMicrotask(() => { if (!this.terminated) for (const listener of this.main.get('message') ?? []) listener({ data: message }) })
      },
      close: () => { this.terminated = true },
    }
    this.runtime = installIllustratorWorker(scope)
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    const entries = this.main.get(type) ?? new Set(); entries.add(listener); this.main.set(type, entries)
  }
  removeEventListener(type: string, listener: (event: any) => void): void { this.main.get(type)?.delete(listener) }
  postMessage(message: IllustratorWorkerRequest): void {
    queueMicrotask(() => { if (!this.terminated) for (const listener of this.worker) listener({ data: message } as MessageEvent<IllustratorWorkerRequest>) })
  }
  terminate(): void { if (this.terminated) return; this.terminated = true; this.runtime.dispose() }
}

class HungWorker {
  terminated = false
  private readonly listeners = new Map<string, Set<(event: any) => void>>()
  addEventListener(type: string, listener: (event: any) => void): void { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set) }
  removeEventListener(type: string, listener: (event: any) => void): void { this.listeners.get(type)?.delete(listener) }
  postMessage(): void { /* deliberately never responds */ }
  terminate(): void { this.terminated = true }
}

class InvalidWorker extends HungWorker {
  override postMessage(): void {
    queueMicrotask(() => {
      const listeners = (this as any).listeners as Map<string, Set<(event: any) => void>>
      for (const listener of listeners.get('message') ?? []) listener({ data: { invalid: true } })
    })
  }
}

test('Node engine exposes one coherent parse/session/export lifecycle', async () => {
  const engine = await createIllustratorEngine()
  const document = await engine.open(DIRECT_SOURCE_BYTES)
  const summary = await document.getSummary()
  assert.equal(summary.artboards, 1)
  assert.equal(summary.layers, 1)
  assert.ok((await document.getLosslessAst()).tokens.length > 0)
  assert.match(await document.exportSvg(), /^<svg/u)
  const stripped = await document.exportSceneJson({ includeAstReferences: false, includeOpaqueResourceRaw: false })
  assert.ok(stripped.children.length > 0)
  document.dispose()
  await assert.rejects(() => document.getSummary(), /disposed/iu)
  engine.dispose()
  await assert.rejects(() => engine.open(DIRECT_SOURCE_BYTES), /disposed/iu)
})

test('worker client and worker runtime exchange summaries, AST and Scene IR', async () => {
  const linked = new LinkedWorker()
  const engine = new WorkerIllustratorEngine(linked as unknown as Worker, { defaultTimeoutMs: 1000 })
  const document = await engine.open(DIRECT_SOURCE_BYTES)
  assert.equal((await document.getSummary()).paths, 1)
  assert.equal((await document.getLayerTree())[0]?.name, 'Artwork')
  assert.ok((await document.getLosslessAst()).statements.length > 0)
  assert.equal((await document.exportSceneJson()).format, 'adobe-illustrator.scene')
  assert.ok((await document.getSupportReport()).unknownOperators.mysteryVisibleOperator >= 1)
  document.dispose()
  await assert.rejects(() => document.getDiagnostics(), /disposed/iu)
  engine.dispose()
  assert.equal(linked.terminated, true)
})

test('AbortSignal terminates a pending worker rather than only rejecting a Promise', async () => {
  const worker = new HungWorker()
  const engine = new WorkerIllustratorEngine(worker as unknown as Worker, { defaultTimeoutMs: 1000 })
  const controller = new AbortController()
  const pending = engine.open(DIRECT_SOURCE_BYTES, { signal: controller.signal })
  await Promise.resolve()
  await Promise.resolve()
  controller.abort()
  await assert.rejects(() => pending, /abort|terminated/iu)
  assert.equal(worker.terminated, true)
  await assert.rejects(() => engine.open(DIRECT_SOURCE_BYTES), /no longer available|terminated/iu)
})

test('request timeout terminates an unresponsive worker and all pending work', async () => {
  const worker = new HungWorker()
  const engine = new WorkerIllustratorEngine(worker as unknown as Worker, { defaultTimeoutMs: 10 })
  await assert.rejects(() => engine.open(DIRECT_SOURCE_BYTES), /timeout|exceeded/iu)
  assert.equal(worker.terminated, true)
})

test('invalid worker messages fail closed as protocol errors', async () => {
  const worker = new InvalidWorker()
  const engine = new WorkerIllustratorEngine(worker as unknown as Worker, { defaultTimeoutMs: 1000 })
  await assert.rejects(() => engine.open(DIRECT_SOURCE_BYTES), /invalid response|protocol/iu)
  assert.equal(worker.terminated, true)
})
