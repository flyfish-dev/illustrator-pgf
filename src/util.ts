import type { Bounds, IllustratorInput, Matrix, Point, SourcePosition, SourceSpan } from './types.js'
import { IllustratorError } from './errors.js'

const BYTE_CHUNK = 0x8000

/** Strict ISO-8859-1 byte-to-code-point mapping. TextDecoder('latin1') is intentionally not used. */
export function latin1Decode(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += BYTE_CHUNK) {
    const end = Math.min(bytes.length, offset + BYTE_CHUNK)
    const codes = new Array<number>(end - offset)
    for (let i = offset; i < end; i++) codes[i - offset] = bytes[i]!
    chunks.push(String.fromCharCode(...codes))
  }
  return chunks.join('')
}

/** Inverse of latin1Decode; rejects characters that cannot be represented in one byte. */
export function latin1Encode(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0xff) {
      throw new IllustratorError('AI_ENCODING_NOT_LATIN1', 'lex', `Character U+${code.toString(16).toUpperCase()} at offset ${i} is not byte-preserving Latin-1.`)
    }
    bytes[i] = code
  }
  return bytes
}

export async function inputToBytes(input: IllustratorInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  return new Uint8Array(await input.arrayBuffer())
}

export function concatBytes(parts: readonly Uint8Array[], maxBytes = Number.MAX_SAFE_INTEGER): Uint8Array {
  let length = 0
  for (const part of parts) {
    length += part.byteLength
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      throw new IllustratorError('AI_CONCAT_LIMIT', 'decode', `Combined data exceeds the ${maxBytes}-byte limit.`)
    }
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!
  return difference === 0
}

export function bytesToHex(bytes: Uint8Array): string {
  let result = ''
  for (const value of bytes) result += value.toString(16).padStart(2, '0')
  return result
}

export function hexToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/gu, '')
  if (!/^[0-9a-f]*$/iu.test(normalized)) throw new IllustratorError('AI_HEX_INVALID', 'decode', 'Hex data contains a non-hexadecimal character.')
  const padded = normalized.length % 2 === 0 ? normalized : `${normalized}0`
  const bytes = new Uint8Array(padded.length / 2)
  for (let i = 0; i < padded.length; i += 2) bytes[i / 2] = Number.parseInt(padded.slice(i, i + 2), 16)
  return bytes
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle !== undefined) {
    const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer as ArrayBuffer
      : bytes.slice().buffer
    return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', owned)))
  }
  return bytesToHex(sha256Fallback(bytes))
}

function sha256Fallback(message: Uint8Array): Uint8Array {
  const initial = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const constants = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ])
  const bitLength = BigInt(message.byteLength) * 8n
  const paddedLength = Math.ceil((message.byteLength + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn), false)
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn), false)
  const words = new Uint32Array(64)
  const rotateRight = (value: number, count: number): number => (value >>> count) | (value << (32 - count))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15]!
      const b = words[i - 2]!
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3)
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10)
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0
    }
    let [a,b,c,d,e,f,g,h] = initial
    for (let i = 0; i < 64; i++) {
      const s1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25)
      const choose = (e! & f!) ^ (~e! & g!)
      const temp1 = (h! + s1 + choose + constants[i]! + words[i]!) >>> 0
      const s0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22)
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const temp2 = (s0 + majority) >>> 0
      h = g; g = f; f = e; e = (d! + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    initial[0] = (initial[0]! + a!) >>> 0
    initial[1] = (initial[1]! + b!) >>> 0
    initial[2] = (initial[2]! + c!) >>> 0
    initial[3] = (initial[3]! + d!) >>> 0
    initial[4] = (initial[4]! + e!) >>> 0
    initial[5] = (initial[5]! + f!) >>> 0
    initial[6] = (initial[6]! + g!) >>> 0
    initial[7] = (initial[7]! + h!) >>> 0
  }
  const output = new Uint8Array(32)
  const outputView = new DataView(output.buffer)
  for (let i = 0; i < 8; i++) outputView.setUint32(i * 4, initial[i]!, false)
  return output
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new IllustratorError('AI_ABORTED', 'parse', 'The Illustrator operation was aborted.')
  }
}

export class WorkBudget {
  private readonly started = performance.now()
  private readonly counters = new Map<string, number>()
  readonly deadline: number
  constructor(
    readonly signal: AbortSignal | undefined,
    timeoutMs: number,
  ) {
    this.deadline = this.started + Math.max(1, timeoutMs)
  }
  checkpoint(stage: 'container' | 'decode' | 'lex' | 'parse' | 'lower' | 'render' | 'resource' = 'parse'): void {
    if (this.signal?.aborted === true) throw new IllustratorError('AI_ABORTED', stage, 'The Illustrator operation was aborted.')
    if (performance.now() > this.deadline) throw new IllustratorError('AI_TIMEOUT', stage, 'The Illustrator operation exceeded its time budget.')
  }
  consume(name: string, amount: number, limit: number, stage: 'container' | 'decode' | 'lex' | 'parse' | 'lower' | 'render' | 'resource'): number {
    if (!Number.isFinite(amount) || amount < 0) throw new IllustratorError('AI_BUDGET_INVALID', stage, `Invalid ${name} budget amount.`)
    const value = (this.counters.get(name) ?? 0) + amount
    if (value > limit) throw new IllustratorError(`AI_LIMIT_${name.toUpperCase()}`, stage, `${name} exceeds the configured limit of ${limit}.`)
    this.counters.set(name, value)
    if ((value & 0x3ff) === 0) this.checkpoint(stage)
    return value
  }
}

export class SourceLocator {
  private readonly lineStarts: number[] = [0]
  constructor(readonly source: string) {
    for (let i = 0; i < source.length; i++) {
      const code = source.charCodeAt(i)
      if (code === 13) {
        if (source.charCodeAt(i + 1) === 10) i++
        this.lineStarts.push(i + 1)
      } else if (code === 10) this.lineStarts.push(i + 1)
    }
  }
  position(offset: number): SourcePosition {
    const clamped = Math.max(0, Math.min(this.source.length, offset))
    let low = 0
    let high = this.lineStarts.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (this.lineStarts[middle]! <= clamped) low = middle
      else high = middle
    }
    return { offset: clamped, line: low + 1, column: clamped - this.lineStarts[low]! + 1 }
  }
  span(start: number, end: number): SourceSpan { return { start: this.position(start), end: this.position(end) } }
}

export const IDENTITY_MATRIX: Matrix = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })

export function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  }
}

export function transformPoint(matrix: Matrix, point: Point): Point {
  return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f }
}

export function unionBounds(left: Bounds | undefined, right: Bounds | undefined): Bounds | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return { left: Math.min(left.left, right.left), bottom: Math.min(left.bottom, right.bottom), right: Math.max(left.right, right.right), top: Math.max(left.top, right.top) }
}

export function boundsFromPoints(points: readonly Point[]): Bounds | undefined {
  if (points.length === 0) return undefined
  let left = points[0]!.x; let right = left; let bottom = points[0]!.y; let top = bottom
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!
    left = Math.min(left, point.x); right = Math.max(right, point.x)
    bottom = Math.min(bottom, point.y); top = Math.max(top, point.y)
  }
  return { left, bottom, right, top }
}

export function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

export function safeCssColor(value: string | undefined, fallback = 'transparent'): string {
  if (value === undefined) return fallback
  return /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,%\s+-]+\)|hsla?\([\d.,%\s+-]+\)|[a-z]+)$/iu.test(value) ? value : fallback
}

export function stableId(prefix: string, index: number): string { return `${prefix}-${index.toString(36)}` }
export function clamp(value: number, minimum = 0, maximum = 1): number { return Math.max(minimum, Math.min(maximum, value)) }
export function finiteNumber(value: unknown, fallback = 0): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
