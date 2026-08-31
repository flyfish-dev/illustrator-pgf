export function asNativeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

export function nativeString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const record = asNativeRecord(value)
  return typeof record?.value === 'string' ? record.value : undefined
}

export function nativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const record = asNativeRecord(value)
  return typeof record?.value === 'number' && Number.isFinite(record.value)
    ? record.value
    : undefined
}

export function nativeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  const record = asNativeRecord(value)
  return typeof record?.value === 'boolean' ? record.value : undefined
}

export function latin1SourceText(
  input: string | Uint8Array,
  maximumBytes = Number.POSITIVE_INFINITY,
): string {
  if (typeof input === 'string') return input.slice(0, maximumBytes)
  const length = Math.min(input.byteLength, maximumBytes)
  const chunkSize = 32 * 1024
  const chunks: string[] = []
  for (let offset = 0; offset < length; offset += chunkSize) {
    const end = Math.min(length, offset + chunkSize)
    let chunk = ''
    for (let index = offset; index < end; index++) {
      chunk += String.fromCharCode(input[index] ?? 0)
    }
    chunks.push(chunk)
  }
  return chunks.join('')
}

export function nativeFNV1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function stableNativeSerialize(
  value: unknown,
  seen = new Set<unknown>(),
): string {
  if (value === undefined) return '"[Undefined]"'
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`)
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return JSON.stringify(String(value))
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (seen.has(value)) return '"[Circular]"'
  seen.add(value)
  if (value instanceof Uint8Array) {
    const serialized = `{"$bytes":"${Array.from(value, (entry) => entry.toString(16).padStart(2, '0')).join('')}"}`
    seen.delete(value)
    return serialized
  }
  if (Array.isArray(value)) {
    const serialized = `[${value.map((entry) => stableNativeSerialize(entry, seen)).join(',')}]`
    seen.delete(value)
    return serialized
  }
  const record = value as Record<string, unknown>
  const serialized = `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableNativeSerialize(record[key], seen)}`)
    .join(',')}}`
  seen.delete(value)
  return serialized
}

export function nativeBoundsFrom(value: unknown): Readonly<{
  left: number
  top: number
  right: number
  bottom: number
}> | undefined {
  const record = asNativeRecord(value)
  const left = nativeNumber(record?.left)
  const top = nativeNumber(record?.top)
  const right = nativeNumber(record?.right)
  const bottom = nativeNumber(record?.bottom)
  if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
    return undefined
  }
  return { left, top, right, bottom }
}

export function walkNativeScene(
  scene: unknown,
  visit: (node: Record<string, unknown>, parent?: Record<string, unknown>) => void,
): void {
  const root = asNativeRecord(scene)
  const roots = Array.isArray(root?.children)
    ? root.children
    : Array.isArray(root?.nodes)
      ? root.nodes
      : Array.isArray(root?.layers)
        ? root.layers
        : []
  const seen = new Set<unknown>()
  const walk = (value: unknown, parent?: Record<string, unknown>): void => {
    if (seen.has(value)) return
    const record = asNativeRecord(value)
    if (record === undefined) return
    seen.add(value)
    visit(record, parent)
    if (Array.isArray(record.children)) {
      for (const child of record.children) walk(child, record)
    }
  }
  for (const value of roots) walk(value)
}

export function nativeAstStatements(ast: unknown): readonly unknown[] {
  const record = asNativeRecord(ast)
  return Array.isArray(record?.statements) ? record.statements : []
}
