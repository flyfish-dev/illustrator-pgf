export interface ByteLruEntry<V> {
  key: string
  value: V
  bytes: number
}

export class ByteLruCache<V> {
  readonly #entries = new Map<string, ByteLruEntry<V>>()
  #bytes = 0
  #maximumBytes: number

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError('maximumBytes must be a non-negative safe integer.')
    }
    this.#maximumBytes = maximumBytes
  }

  get maximumBytes(): number { return this.#maximumBytes }
  get byteLength(): number { return this.#bytes }
  get size(): number { return this.#entries.size }

  has(key: string): boolean { return this.#entries.has(key) }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: V, bytes: number): readonly ByteLruEntry<V>[] {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError('bytes must be a non-negative safe integer.')
    }
    const previous = this.#entries.get(key)
    if (previous !== undefined) {
      this.#entries.delete(key)
      this.#bytes -= previous.bytes
    }
    const entry = { key, value, bytes }
    this.#entries.set(key, entry)
    this.#bytes += bytes
    return this.evict()
  }

  delete(key: string): boolean {
    const entry = this.#entries.get(key)
    if (entry === undefined) return false
    this.#entries.delete(key)
    this.#bytes -= entry.bytes
    return true
  }

  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }

  resize(maximumBytes: number): readonly ByteLruEntry<V>[] {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError('maximumBytes must be a non-negative safe integer.')
    }
    this.#maximumBytes = maximumBytes
    return this.evict()
  }

  entries(): readonly ByteLruEntry<V>[] {
    return [...this.#entries.values()]
  }

  private evict(): readonly ByteLruEntry<V>[] {
    const evicted: ByteLruEntry<V>[] = []
    while (this.#bytes > this.#maximumBytes && this.#entries.size > 0) {
      const first = this.#entries.entries().next().value as
        | [string, ByteLruEntry<V>]
        | undefined
      if (first === undefined) break
      this.#entries.delete(first[0])
      this.#bytes -= first[1].bytes
      evicted.push(first[1])
    }
    return evicted
  }
}

export interface CooperativeBudgetOptions {
  signal?: AbortSignal
  deadline?: number
  maximumOperations?: number
  now?: () => number
}

export class CooperativeBudget {
  readonly #signal: AbortSignal | undefined
  readonly #deadline: number | undefined
  readonly #maximumOperations: number
  readonly #now: () => number
  #operations = 0

  constructor(options: CooperativeBudgetOptions = {}) {
    this.#signal = options.signal
    this.#deadline = options.deadline
    this.#maximumOperations = options.maximumOperations ?? 1_000_000
    this.#now = options.now ?? (() => Date.now())
    if (!Number.isSafeInteger(this.#maximumOperations) || this.#maximumOperations < 1) {
      throw new RangeError('maximumOperations must be a positive safe integer.')
    }
  }

  get operations(): number { return this.#operations }

  checkpoint(amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new RangeError('Checkpoint amount must be a non-negative safe integer.')
    }
    this.#operations += amount
    if (this.#signal?.aborted === true) {
      throw new DOMException('Operation aborted.', 'AbortError')
    }
    if (this.#deadline !== undefined && this.#now() > this.#deadline) {
      throw new DOMException('Operation timed out.', 'TimeoutError')
    }
    if (this.#operations > this.#maximumOperations) {
      throw new RangeError(
        `Operation budget exceeded ${this.#maximumOperations} checkpoints.`,
      )
    }
  }
}

export interface NativeRevisionGate {
  current(): number
  next(): number
  isCurrent(revision: number): boolean
}

export function createNativeRevisionGate(initialRevision = 0): NativeRevisionGate {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
    throw new RangeError('initialRevision must be a non-negative safe integer.')
  }
  let revision = initialRevision
  return {
    current: () => revision,
    next: () => ++revision,
    isCurrent: (candidate) => candidate === revision,
  }
}
