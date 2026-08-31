import type { IllustratorDiagnostic, IllustratorLimits } from './types.js'
import type { IllustratorCodecProvider, PdfFilterSpec, PdfPredictorParameters } from './codecs.js'
import { decodePdfFilters } from './codecs.js'
import { IllustratorError, diagnostic } from './errors.js'
import { WorkBudget, latin1Decode } from './util.js'

export interface PdfName { kind: 'name'; value: string }
export interface PdfString { kind: 'string'; bytes: Uint8Array; hex: boolean }
export interface PdfArray { kind: 'array'; values: PdfValue[] }
export interface PdfDictionary { kind: 'dictionary'; entries: Map<string, PdfValue> }
export interface PdfReference { kind: 'reference'; objectNumber: number; generation: number }
export type PdfValue = null | boolean | number | string | PdfName | PdfString | PdfArray | PdfDictionary | PdfReference
export interface PdfStream { dictionary: PdfDictionary; encoded: Uint8Array; filters: readonly PdfFilterSpec[] }
export interface PdfIndirectObject {
  objectNumber: number
  generation: number
  value: PdfValue
  stream?: PdfStream
  offset: number
  compressed: boolean
}

type XrefEntry =
  | { type: 0; generation: number; revision: number }
  | { type: 1; offset: number; generation: number; revision: number }
  | { type: 2; objectStream: number; index: number; generation: 0; revision: number }

const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const PDF_DELIMITERS = new Set([0x28,0x29,0x3c,0x3e,0x5b,0x5d,0x7b,0x7d,0x2f,0x25])

function isWhitespace(byte: number | undefined): boolean { return byte !== undefined && PDF_WHITESPACE.has(byte) }
function isDelimiter(byte: number | undefined): boolean { return byte === undefined || isWhitespace(byte) || PDF_DELIMITERS.has(byte) }
function isDigit(byte: number | undefined): boolean { return byte !== undefined && byte >= 0x30 && byte <= 0x39 }
function isHex(byte: number | undefined): boolean { return byte !== undefined && ((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)) }
function hexNibble(byte: number): number { return byte <= 57 ? byte - 48 : byte <= 70 ? byte - 55 : byte - 87 }

class PdfValueParser {
  offset: number
  constructor(
    readonly bytes: Uint8Array,
    offset: number,
    readonly maximumDepth: number,
    readonly budget: WorkBudget,
  ) { this.offset = offset }

  skipTrivia(): void {
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset]!
      if (isWhitespace(byte)) { this.offset++; continue }
      if (byte === 0x25) {
        this.offset++
        while (this.offset < this.bytes.length && this.bytes[this.offset] !== 0x0a && this.bytes[this.offset] !== 0x0d) this.offset++
        continue
      }
      break
    }
  }

  matchKeyword(keyword: string): boolean {
    this.skipTrivia()
    if (this.offset + keyword.length > this.bytes.length) return false
    for (let i = 0; i < keyword.length; i++) if (this.bytes[this.offset + i] !== keyword.charCodeAt(i)) return false
    if (!isDelimiter(this.bytes[this.offset - 1]) || !isDelimiter(this.bytes[this.offset + keyword.length])) return false
    this.offset += keyword.length
    return true
  }

  peekKeyword(keyword: string): boolean {
    const before = this.offset
    const result = this.matchKeyword(keyword)
    this.offset = before
    return result
  }

  parseValue(depth = 0): PdfValue {
    this.budget.checkpoint('container')
    if (depth > this.maximumDepth) throw new IllustratorError('AI_PDF_NESTING_LIMIT', 'container', `PDF value nesting exceeds ${this.maximumDepth}.`)
    this.skipTrivia()
    const byte = this.bytes[this.offset]
    if (byte === undefined) throw new IllustratorError('AI_PDF_VALUE_TRUNCATED', 'container', 'Unexpected end of PDF while reading a value.')
    if (byte === 0x2f) return this.parseName()
    if (byte === 0x28) return this.parseLiteralString()
    if (byte === 0x5b) return this.parseArray(depth + 1)
    if (byte === 0x3c) {
      if (this.bytes[this.offset + 1] === 0x3c) return this.parseDictionary(depth + 1)
      return this.parseHexString()
    }
    if (this.matchKeyword('true')) return true
    if (this.matchKeyword('false')) return false
    if (this.matchKeyword('null')) return null
    const first = this.parseNumberOrWord()
    if (typeof first === 'number' && Number.isInteger(first) && first >= 0) {
      const afterFirst = this.offset
      try {
        const second = this.parseNumberOrWord()
        if (typeof second === 'number' && Number.isInteger(second) && second >= 0) {
          if (this.matchKeyword('R')) return { kind: 'reference', objectNumber: first, generation: second }
        }
      } catch { /* restore below */ }
      this.offset = afterFirst
    }
    return first
  }

  parseName(): PdfName {
    this.offset++
    const values: number[] = []
    while (this.offset < this.bytes.length && !isDelimiter(this.bytes[this.offset])) {
      const byte = this.bytes[this.offset++]!
      if (byte === 0x23 && isHex(this.bytes[this.offset]) && isHex(this.bytes[this.offset + 1])) {
        values.push((hexNibble(this.bytes[this.offset]!) << 4) | hexNibble(this.bytes[this.offset + 1]!))
        this.offset += 2
      } else values.push(byte)
    }
    return { kind: 'name', value: latin1Decode(Uint8Array.from(values)) }
  }

  parseLiteralString(): PdfString {
    this.offset++
    let depth = 1
    const values: number[] = []
    while (this.offset < this.bytes.length && depth > 0) {
      let byte = this.bytes[this.offset++]!
      if (byte === 0x5c) {
        if (this.offset >= this.bytes.length) break
        byte = this.bytes[this.offset++]!
        if (byte === 0x6e) values.push(0x0a)
        else if (byte === 0x72) values.push(0x0d)
        else if (byte === 0x74) values.push(0x09)
        else if (byte === 0x62) values.push(0x08)
        else if (byte === 0x66) values.push(0x0c)
        else if (byte === 0x0d) { if (this.bytes[this.offset] === 0x0a) this.offset++ }
        else if (byte === 0x0a) { /* continuation */ }
        else if (byte >= 0x30 && byte <= 0x37) {
          let octal = byte - 0x30
          let count = 1
          while (count < 3 && this.bytes[this.offset] !== undefined && this.bytes[this.offset]! >= 0x30 && this.bytes[this.offset]! <= 0x37) {
            octal = octal * 8 + this.bytes[this.offset++]! - 0x30
            count++
          }
          values.push(octal & 0xff)
        } else values.push(byte)
      } else if (byte === 0x28) { depth++; values.push(byte) }
      else if (byte === 0x29) { depth--; if (depth > 0) values.push(byte) }
      else values.push(byte)
    }
    if (depth !== 0) throw new IllustratorError('AI_PDF_STRING_TRUNCATED', 'container', 'PDF literal string is not closed.')
    return { kind: 'string', bytes: Uint8Array.from(values), hex: false }
  }

  parseHexString(): PdfString {
    this.offset++
    const nibbles: number[] = []
    let closed = false
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset++]!
      if (byte === 0x3e) { closed = true; break }
      if (isWhitespace(byte)) continue
      if (!isHex(byte)) throw new IllustratorError('AI_PDF_HEX_INVALID', 'container', 'PDF hex string contains an invalid character.')
      nibbles.push(hexNibble(byte))
    }
    if (!closed) throw new IllustratorError('AI_PDF_STRING_TRUNCATED', 'container', 'PDF hex string is not closed.')
    if (nibbles.length % 2 !== 0) nibbles.push(0)
    const values = new Uint8Array(nibbles.length / 2)
    for (let i = 0; i < nibbles.length; i += 2) values[i / 2] = (nibbles[i]! << 4) | nibbles[i + 1]!
    return { kind: 'string', bytes: values, hex: true }
  }

  parseArray(depth: number): PdfArray {
    this.offset++
    const values: PdfValue[] = []
    while (true) {
      this.skipTrivia()
      if (this.offset >= this.bytes.length) throw new IllustratorError('AI_PDF_ARRAY_TRUNCATED', 'container', 'PDF array is not closed.')
      if (this.bytes[this.offset] === 0x5d) { this.offset++; break }
      values.push(this.parseValue(depth))
    }
    return { kind: 'array', values }
  }

  parseDictionary(depth: number): PdfDictionary {
    this.offset += 2
    const entries = new Map<string, PdfValue>()
    while (true) {
      this.skipTrivia()
      if (this.offset + 1 < this.bytes.length && this.bytes[this.offset] === 0x3e && this.bytes[this.offset + 1] === 0x3e) { this.offset += 2; break }
      if (this.offset >= this.bytes.length) throw new IllustratorError('AI_PDF_DICTIONARY_TRUNCATED', 'container', 'PDF dictionary is not closed.')
      const key = this.parseName()
      if (entries.has(key.value)) throw new IllustratorError('AI_PDF_DUPLICATE_KEY', 'container', `PDF dictionary contains duplicate /${key.value}.`)
      entries.set(key.value, this.parseValue(depth))
    }
    return { kind: 'dictionary', entries }
  }

  parseNumberOrWord(): number | string {
    this.skipTrivia()
    const start = this.offset
    while (this.offset < this.bytes.length && !isDelimiter(this.bytes[this.offset])) this.offset++
    if (this.offset === start) throw new IllustratorError('AI_PDF_TOKEN_INVALID', 'container', `Invalid PDF token at byte ${start}.`)
    const token = latin1Decode(this.bytes.subarray(start, this.offset))
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(token)) {
      const number = Number(token)
      if (!Number.isFinite(number)) throw new IllustratorError('AI_PDF_NUMBER_INVALID', 'container', `Invalid PDF number ${token}.`)
      return number
    }
    return token
  }
}

function isDictionary(value: PdfValue | undefined): value is PdfDictionary { return typeof value === 'object' && value !== null && value.kind === 'dictionary' }
function isArray(value: PdfValue | undefined): value is PdfArray { return typeof value === 'object' && value !== null && value.kind === 'array' }
function isName(value: PdfValue | undefined): value is PdfName { return typeof value === 'object' && value !== null && value.kind === 'name' }
function isReference(value: PdfValue | undefined): value is PdfReference { return typeof value === 'object' && value !== null && value.kind === 'reference' }
export function pdfName(value: PdfValue | undefined): string | undefined { return isName(value) ? value.value : undefined }
export function pdfNumber(value: PdfValue | undefined): number | undefined { return typeof value === 'number' ? value : undefined }
export function pdfString(value: PdfValue | undefined): string | undefined {
  if (typeof value === 'string') return value
  return typeof value === 'object' && value !== null && value.kind === 'string' ? latin1Decode(value.bytes) : undefined
}
export function pdfArray(value: PdfValue | undefined): readonly PdfValue[] | undefined { return isArray(value) ? value.values : undefined }
export function pdfDictionary(value: PdfValue | undefined): PdfDictionary | undefined { return isDictionary(value) ? value : undefined }
export function pdfReference(value: PdfValue | undefined): PdfReference | undefined { return isReference(value) ? value : undefined }
export function pdfGet(dictionary: PdfDictionary | undefined, key: string): PdfValue | undefined { return dictionary?.entries.get(key) }

function readUnsigned(bytes: Uint8Array, offset: number, width: number): number {
  let value = 0
  for (let i = 0; i < width; i++) {
    value = value * 256 + bytes[offset + i]!
    if (!Number.isSafeInteger(value)) throw new IllustratorError('AI_PDF_XREF_OVERFLOW', 'container', 'PDF xref field exceeds the safe integer range.')
  }
  return value
}

function findKeywordBytes(bytes: Uint8Array, keyword: string, start: number, end = bytes.length): number {
  outer: for (let offset = Math.max(0, start); offset + keyword.length <= end; offset++) {
    if (!isDelimiter(bytes[offset - 1])) continue
    for (let i = 0; i < keyword.length; i++) if (bytes[offset + i] !== keyword.charCodeAt(i)) continue outer
    if (isDelimiter(bytes[offset + keyword.length])) return offset
  }
  return -1
}

function findLastKeywordBytes(bytes: Uint8Array, keyword: string): number {
  outer: for (let offset = bytes.length - keyword.length; offset >= 0; offset--) {
    if (!isDelimiter(bytes[offset - 1])) continue
    for (let i = 0; i < keyword.length; i++) if (bytes[offset + i] !== keyword.charCodeAt(i)) continue outer
    if (isDelimiter(bytes[offset + keyword.length])) return offset
  }
  return -1
}

function streamStartAfterKeyword(bytes: Uint8Array, offset: number): number {
  let cursor = offset
  if (bytes[cursor] === 0x0d) { cursor++; if (bytes[cursor] === 0x0a) cursor++ }
  else if (bytes[cursor] === 0x0a) cursor++
  else throw new IllustratorError('AI_PDF_STREAM_EOL', 'container', 'PDF stream keyword must be followed by CR, LF, or CRLF.')
  return cursor
}

export interface OpenPdfOptions {
  limits: IllustratorLimits
  codecs: IllustratorCodecProvider
  signal?: AbortSignal
  timeoutMs?: number
}

export class PdfDocument {
  readonly diagnostics: IllustratorDiagnostic[] = []
  readonly version: string
  readonly headerOffset: number
  private readonly xref = new Map<number, XrefEntry>()
  private readonly xrefOffsets = new Set<number>()
  private readonly objectCache = new Map<string, Promise<PdfIndirectObject>>()
  private readonly objectStreamCache = new Map<number, Promise<Map<number, PdfIndirectObject>>>()
  private readonly trailers: PdfDictionary[] = []
  private revision = 0

  private constructor(
    readonly bytes: Uint8Array,
    readonly limits: IllustratorLimits,
    readonly codecs: IllustratorCodecProvider,
    readonly budget: WorkBudget,
    headerOffset: number,
    version: string,
  ) {
    this.headerOffset = headerOffset
    this.version = version
  }

  static async open(bytes: Uint8Array, options: OpenPdfOptions): Promise<PdfDocument> {
    if (bytes.byteLength > options.limits.maxFileBytes) throw new IllustratorError('AI_FILE_LIMIT', 'container', `PDF exceeds the ${options.limits.maxFileBytes}-byte file limit.`)
    let headerOffset = -1
    const headerSearchEnd = Math.min(bytes.length, 1024)
    for (let i = 0; i + 8 <= headerSearchEnd; i++) {
      if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) { headerOffset = i; break }
    }
    if (headerOffset < 0) throw new IllustratorError('AI_PDF_HEADER_MISSING', 'container', 'Input does not contain a valid PDF header in the first 1024 bytes.')
    const version = latin1Decode(bytes.subarray(headerOffset + 5, Math.min(headerOffset + 8, bytes.length))).match(/^\d\.\d/u)?.[0]
    if (version === undefined) throw new IllustratorError('AI_PDF_VERSION_INVALID', 'container', 'PDF header has an invalid version.')
    const timeout = Math.min(options.timeoutMs ?? options.limits.maxWorkerTimeMs, options.limits.maxWorkerTimeMs)
    const document = new PdfDocument(bytes, options.limits, options.codecs, new WorkBudget(options.signal, timeout), headerOffset, version)
    const startxref = findLastKeywordBytes(bytes, 'startxref')
    if (startxref < 0) throw new IllustratorError('AI_PDF_STARTXREF_MISSING', 'container', 'PDF startxref marker is missing.')
    const parser = new PdfValueParser(bytes, startxref + 'startxref'.length, options.limits.maxNesting, document.budget)
    const xrefOffset = parser.parseNumberOrWord()
    if (typeof xrefOffset !== 'number' || !Number.isSafeInteger(xrefOffset) || xrefOffset < 0 || xrefOffset >= bytes.length) {
      throw new IllustratorError('AI_PDF_STARTXREF_INVALID', 'container', 'PDF startxref offset is invalid.')
    }
    await document.loadXref(xrefOffset, 0)
    if (document.xref.size > options.limits.maxPdfObjects) throw new IllustratorError('AI_PDF_OBJECT_LIMIT', 'container', `PDF xref exceeds ${options.limits.maxPdfObjects} objects.`)
    if (document.trailers.some((trailer) => trailer.entries.has('Encrypt'))) {
      throw new IllustratorError('AI_PDF_ENCRYPTED', 'container', 'Encrypted PDF private source cannot be read safely.')
    }
    if (document.getRootReference() === undefined) throw new IllustratorError('AI_PDF_ROOT_MISSING', 'container', 'PDF trailer chain does not contain a Catalog /Root reference.')
    return document
  }

  get objectCount(): number { return [...this.xref.values()].filter((entry) => entry.type !== 0).length }

  getRootReference(): PdfReference | undefined {
    for (const trailer of this.trailers) {
      const root = pdfReference(trailer.entries.get('Root'))
      if (root !== undefined) return root
    }
    return undefined
  }

  getTrailerValue(key: string): PdfValue | undefined {
    for (const trailer of this.trailers) if (trailer.entries.has(key)) return trailer.entries.get(key)
    return undefined
  }

  async getRoot(): Promise<PdfIndirectObject> {
    const reference = this.getRootReference()
    if (reference === undefined) throw new IllustratorError('AI_PDF_ROOT_MISSING', 'container', 'PDF Catalog reference is missing.')
    return this.getObject(reference)
  }

  async getObject(reference: PdfReference, resolutionStack: readonly string[] = []): Promise<PdfIndirectObject> {
    this.budget.checkpoint('container')
    const key = `${reference.objectNumber}:${reference.generation}`
    if (resolutionStack.includes(key)) throw new IllustratorError('AI_PDF_REFERENCE_CYCLE', 'container', `PDF reference cycle detected at ${key}.`)
    const entry = this.xref.get(reference.objectNumber)
    if (entry === undefined || entry.type === 0) throw new IllustratorError('AI_PDF_OBJECT_MISSING', 'container', `PDF object ${key} is missing.`)
    if (entry.generation !== reference.generation) throw new IllustratorError('AI_PDF_GENERATION_MISMATCH', 'container', `PDF object ${reference.objectNumber} has generation ${entry.generation}, not ${reference.generation}.`)
    let cached = this.objectCache.get(key)
    if (cached === undefined) {
      cached = entry.type === 1
        ? this.parseIndirectObjectAt(entry.offset, reference.objectNumber, reference.generation, [...resolutionStack, key])
        : this.getCompressedObject(entry.objectStream, entry.index, reference.objectNumber, [...resolutionStack, key])
      this.objectCache.set(key, cached)
    }
    return cached
  }

  async resolve(value: PdfValue, resolutionStack: readonly string[] = []): Promise<PdfValue> {
    if (!isReference(value)) return value
    const object = await this.getObject(value, resolutionStack)
    return this.resolve(object.value, [...resolutionStack, `${value.objectNumber}:${value.generation}`])
  }

  async resolveDictionary(value: PdfValue | undefined, resolutionStack: readonly string[] = []): Promise<PdfDictionary | undefined> {
    if (value === undefined) return undefined
    const resolved = await this.resolve(value, resolutionStack)
    return pdfDictionary(resolved)
  }

  async allObjects(): Promise<readonly PdfIndirectObject[]> {
    const output: PdfIndirectObject[] = []
    const entries = [...this.xref.entries()].filter(([, entry]) => entry.type !== 0).sort(([a], [b]) => a - b)
    for (const [objectNumber, entry] of entries) {
      this.budget.checkpoint('container')
      output.push(await this.getObject({ kind: 'reference', objectNumber, generation: entry.generation }))
    }
    return output
  }

  async decodeStream(object: PdfIndirectObject, maximum = this.limits.maxDecodedBytes, signal?: AbortSignal): Promise<Uint8Array> {
    if (object.stream === undefined) throw new IllustratorError('AI_PDF_STREAM_MISSING', 'decode', `PDF object ${object.objectNumber} is not a stream.`)
    return decodePdfFilters(object.stream.encoded, object.stream.filters, this.codecs, Math.min(maximum, this.limits.maxDecodedBytes), signal)
  }

  private mergeEntry(objectNumber: number, entry: XrefEntry, local: Set<number>): void {
    if (!Number.isSafeInteger(objectNumber) || objectNumber < 0) throw new IllustratorError('AI_PDF_XREF_INVALID', 'container', 'PDF xref contains an invalid object number.')
    if (local.has(objectNumber)) throw new IllustratorError('AI_PDF_XREF_DUPLICATE', 'container', `PDF xref revision defines object ${objectNumber} more than once.`)
    local.add(objectNumber)
    this.budget.consume('pdfObjects', 1, this.limits.maxPdfObjects, 'container')
    const existing = this.xref.get(objectNumber)
    if (existing === undefined) this.xref.set(objectNumber, entry)
    else if (existing.revision === entry.revision && JSON.stringify(existing) !== JSON.stringify(entry)) {
      this.diagnostics.push(diagnostic('AI_PDF_XREF_HYBRID_CONFLICT', 'warning', 'container', `Hybrid xref entries disagree for object ${objectNumber}; the primary xref entry was retained.`))
    }
  }

  private async loadXref(offset: number, revision: number): Promise<void> {
    this.budget.checkpoint('container')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.bytes.length) throw new IllustratorError('AI_PDF_XREF_OFFSET_INVALID', 'container', `PDF xref offset ${offset} is outside the file.`)
    if (this.xrefOffsets.has(offset)) throw new IllustratorError('AI_PDF_XREF_CYCLE', 'container', `PDF incremental xref chain loops at offset ${offset}.`)
    this.xrefOffsets.add(offset)
    this.revision = Math.max(this.revision, revision)
    const parser = new PdfValueParser(this.bytes, offset, this.limits.maxNesting, this.budget)
    if (parser.matchKeyword('xref')) await this.loadClassicXref(parser, offset, revision)
    else await this.loadXrefStream(offset, revision)
  }

  private async loadClassicXref(parser: PdfValueParser, currentOffset: number, revision: number): Promise<void> {
    const local = new Set<number>()
    while (true) {
      parser.skipTrivia()
      if (parser.peekKeyword('trailer')) break
      const first = parser.parseNumberOrWord()
      const count = parser.parseNumberOrWord()
      if (typeof first !== 'number' || typeof count !== 'number' || !Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 0) {
        throw new IllustratorError('AI_PDF_XREF_INVALID', 'container', 'Classic PDF xref subsection header is invalid.')
      }
      if (count > this.limits.maxPdfObjects) throw new IllustratorError('AI_PDF_OBJECT_LIMIT', 'container', `PDF xref subsection exceeds ${this.limits.maxPdfObjects} entries.`)
      for (let index = 0; index < count; index++) {
        const objectOffset = parser.parseNumberOrWord()
        const generation = parser.parseNumberOrWord()
        const state = parser.parseNumberOrWord()
        if (typeof objectOffset !== 'number' || typeof generation !== 'number' || typeof state !== 'string' || !Number.isSafeInteger(objectOffset) || !Number.isSafeInteger(generation)) {
          throw new IllustratorError('AI_PDF_XREF_INVALID', 'container', `Classic PDF xref entry ${first + index} is invalid.`)
        }
        if (state === 'n') this.mergeEntry(first + index, { type: 1, offset: objectOffset, generation, revision }, local)
        else if (state === 'f') this.mergeEntry(first + index, { type: 0, generation, revision }, local)
        else throw new IllustratorError('AI_PDF_XREF_INVALID', 'container', `Classic PDF xref entry ${first + index} has state ${state}.`)
      }
    }
    if (!parser.matchKeyword('trailer')) throw new IllustratorError('AI_PDF_TRAILER_MISSING', 'container', 'Classic PDF xref has no trailer dictionary.')
    const trailer = parser.parseValue()
    if (!isDictionary(trailer)) throw new IllustratorError('AI_PDF_TRAILER_INVALID', 'container', 'Classic PDF trailer is not a dictionary.')
    await this.processTrailer(trailer, currentOffset, revision)
  }

  private async loadXrefStream(offset: number, revision: number): Promise<void> {
    const object = this.parseIndirectObjectRaw(offset)
    if (!isDictionary(object.value) || object.stream === undefined) throw new IllustratorError('AI_PDF_XREF_STREAM_INVALID', 'container', `Object at xref offset ${offset} is not an xref stream.`)
    const type = pdfName(object.value.entries.get('Type'))
    if (type !== undefined && type !== 'XRef') throw new IllustratorError('AI_PDF_XREF_STREAM_INVALID', 'container', `Object at xref offset ${offset} has /Type /${type}, not /XRef.`)
    const widths = pdfArray(object.value.entries.get('W'))?.map(pdfNumber)
    if (widths === undefined || widths.length !== 3 || widths.some((value) => value === undefined || !Number.isSafeInteger(value) || value < 0 || value > 8)) {
      throw new IllustratorError('AI_PDF_XREF_STREAM_INVALID', 'container', 'PDF xref stream /W must contain three widths between 0 and 8.')
    }
    const decoded = await decodePdfFilters(object.stream.encoded, object.stream.filters, this.codecs, this.limits.maxDecodedBytes, this.budget.signal)
    const size = pdfNumber(object.value.entries.get('Size'))
    if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > this.limits.maxPdfObjects + 1) throw new IllustratorError('AI_PDF_XREF_STREAM_INVALID', 'container', 'PDF xref stream /Size is invalid.')
    const indexValues = pdfArray(object.value.entries.get('Index'))?.map(pdfNumber) ?? [0, size]
    if (indexValues.length % 2 !== 0 || indexValues.some((value) => value === undefined || !Number.isSafeInteger(value) || value < 0)) {
      throw new IllustratorError('AI_PDF_XREF_STREAM_INVALID', 'container', 'PDF xref stream /Index is invalid.')
    }
    const entryWidth = widths[0]! + widths[1]! + widths[2]!
    if (entryWidth <= 0) throw new IllustratorError('AI_PDF_XREF_STREAM_INVALID', 'container', 'PDF xref stream entry width is zero.')
    let dataOffset = 0
    const local = new Set<number>()
    for (let range = 0; range < indexValues.length; range += 2) {
      const first = indexValues[range]!
      const count = indexValues[range + 1]!
      if (first + count > this.limits.maxPdfObjects + 1) throw new IllustratorError('AI_PDF_OBJECT_LIMIT', 'container', 'PDF xref stream object range exceeds the object limit.')
      for (let index = 0; index < count; index++) {
        if (dataOffset + entryWidth > decoded.length) throw new IllustratorError('AI_PDF_XREF_STREAM_TRUNCATED', 'container', 'PDF xref stream data is truncated.')
        const field0 = widths[0] === 0 ? 1 : readUnsigned(decoded, dataOffset, widths[0]!)
        const field1 = readUnsigned(decoded, dataOffset + widths[0]!, widths[1]!)
        const field2 = readUnsigned(decoded, dataOffset + widths[0]! + widths[1]!, widths[2]!)
        const objectNumber = first + index
        if (field0 === 0) this.mergeEntry(objectNumber, { type: 0, generation: field2, revision }, local)
        else if (field0 === 1) this.mergeEntry(objectNumber, { type: 1, offset: field1, generation: field2, revision }, local)
        else if (field0 === 2) this.mergeEntry(objectNumber, { type: 2, objectStream: field1, index: field2, generation: 0, revision }, local)
        else this.diagnostics.push(diagnostic('AI_PDF_XREF_ENTRY_UNKNOWN', 'warning', 'container', `Ignored xref stream entry type ${field0} for object ${objectNumber}.`))
        dataOffset += entryWidth
      }
    }
    if (dataOffset !== decoded.length) this.diagnostics.push(diagnostic('AI_PDF_XREF_TRAILING_DATA', 'warning', 'container', `PDF xref stream contains ${decoded.length - dataOffset} trailing bytes.`))
    if (!this.xref.has(object.objectNumber)) this.xref.set(object.objectNumber, { type: 1, offset, generation: object.generation, revision })
    await this.processTrailer(object.value, offset, revision)
  }

  private async processTrailer(trailer: PdfDictionary, currentOffset: number, revision: number): Promise<void> {
    this.trailers.push(trailer)
    if (trailer.entries.has('Encrypt')) throw new IllustratorError('AI_PDF_ENCRYPTED', 'container', 'Encrypted PDF private source cannot be read safely.')
    const xrefStreamOffset = pdfNumber(trailer.entries.get('XRefStm'))
    if (xrefStreamOffset !== undefined && xrefStreamOffset !== currentOffset) await this.loadXref(xrefStreamOffset, revision)
    const previous = pdfNumber(trailer.entries.get('Prev'))
    if (previous !== undefined) await this.loadXref(previous, revision + 1)
  }

  private parseIndirectObjectRaw(offset: number): PdfIndirectObject {
    const parser = new PdfValueParser(this.bytes, offset, this.limits.maxNesting, this.budget)
    const objectNumber = parser.parseNumberOrWord()
    const generation = parser.parseNumberOrWord()
    if (typeof objectNumber !== 'number' || typeof generation !== 'number' || !Number.isSafeInteger(objectNumber) || !Number.isSafeInteger(generation) || !parser.matchKeyword('obj')) {
      throw new IllustratorError('AI_PDF_OBJECT_HEADER_INVALID', 'container', `PDF indirect object header at offset ${offset} is invalid.`)
    }
    const value = parser.parseValue()
    parser.skipTrivia()
    let stream: PdfStream | undefined
    if (isDictionary(value) && parser.matchKeyword('stream')) {
      const start = streamStartAfterKeyword(this.bytes, parser.offset)
      const directLength = pdfNumber(value.entries.get('Length'))
      let end: number
      if (directLength !== undefined && Number.isSafeInteger(directLength) && directLength >= 0) end = start + directLength
      else {
        end = findKeywordBytes(this.bytes, 'endstream', start)
        if (end < 0) throw new IllustratorError('AI_PDF_STREAM_TRUNCATED', 'container', `PDF stream object ${objectNumber} is not terminated.`)
        while (end > start && (this.bytes[end - 1] === 0x0a || this.bytes[end - 1] === 0x0d)) end--
      }
      if (end < start || end > this.bytes.length || end - start > this.limits.maxFileBytes) throw new IllustratorError('AI_PDF_STREAM_LENGTH_INVALID', 'container', `PDF stream object ${objectNumber} has an invalid length.`)
      stream = { dictionary: value, encoded: this.bytes.slice(start, end), filters: filtersFromDictionary(value) }
    }
    return { objectNumber, generation, value, ...(stream === undefined ? {} : { stream }), offset, compressed: false }
  }

  private async parseIndirectObjectAt(offset: number, expectedObject: number, expectedGeneration: number, resolutionStack: readonly string[]): Promise<PdfIndirectObject> {
    const parser = new PdfValueParser(this.bytes, offset, this.limits.maxNesting, this.budget)
    const objectNumber = parser.parseNumberOrWord()
    const generation = parser.parseNumberOrWord()
    if (objectNumber !== expectedObject || generation !== expectedGeneration || !parser.matchKeyword('obj')) {
      throw new IllustratorError('AI_PDF_OBJECT_OFFSET_MISMATCH', 'container', `xref points to ${expectedObject} ${expectedGeneration}, but offset ${offset} contains ${String(objectNumber)} ${String(generation)}.`)
    }
    const value = parser.parseValue()
    parser.skipTrivia()
    let stream: PdfStream | undefined
    if (isDictionary(value) && parser.matchKeyword('stream')) {
      const start = streamStartAfterKeyword(this.bytes, parser.offset)
      const lengthValue = value.entries.get('Length')
      let length: number | undefined
      if (typeof lengthValue === 'number') length = lengthValue
      else if (isReference(lengthValue)) {
        const lengthObject = await this.getObject(lengthValue, resolutionStack)
        if (typeof lengthObject.value === 'number') length = lengthObject.value
      }
      if (length === undefined || !Number.isSafeInteger(length) || length < 0) throw new IllustratorError('AI_PDF_STREAM_LENGTH_INVALID', 'container', `PDF stream ${objectNumber} has no valid direct or indirect /Length.`)
      if (length > this.limits.maxFileBytes || start + length > this.bytes.length) throw new IllustratorError('AI_PDF_STREAM_LENGTH_INVALID', 'container', `PDF stream ${objectNumber} exceeds the file boundary or configured limit.`)
      const end = start + length
      const endParser = new PdfValueParser(this.bytes, end, this.limits.maxNesting, this.budget)
      if (!endParser.matchKeyword('endstream')) throw new IllustratorError('AI_PDF_STREAM_LENGTH_MISMATCH', 'container', `PDF stream ${objectNumber} /Length does not end at endstream.`)
      if (!endParser.matchKeyword('endobj')) throw new IllustratorError('AI_PDF_OBJECT_TRUNCATED', 'container', `PDF stream object ${objectNumber} is not followed by endobj.`)
      stream = { dictionary: value, encoded: this.bytes.slice(start, end), filters: filtersFromDictionary(value) }
    } else if (!parser.matchKeyword('endobj')) {
      throw new IllustratorError('AI_PDF_OBJECT_TRUNCATED', 'container', `PDF object ${objectNumber} is not followed by endobj.`)
    }
    return { objectNumber, generation, value, ...(stream === undefined ? {} : { stream }), offset, compressed: false }
  }

  private async getCompressedObject(objectStreamNumber: number, index: number, expectedObject: number, resolutionStack: readonly string[]): Promise<PdfIndirectObject> {
    let cached = this.objectStreamCache.get(objectStreamNumber)
    if (cached === undefined) {
      cached = this.parseObjectStream(objectStreamNumber, resolutionStack)
      this.objectStreamCache.set(objectStreamNumber, cached)
    }
    const objects = await cached
    const object = objects.get(expectedObject)
    if (object === undefined) throw new IllustratorError('AI_PDF_OBJECT_STREAM_MISSING', 'container', `Object stream ${objectStreamNumber} does not contain object ${expectedObject}.`)
    const ordered = [...objects.values()]
    if (ordered[index]?.objectNumber !== expectedObject) throw new IllustratorError('AI_PDF_OBJECT_STREAM_INDEX', 'container', `xref index ${index} for object ${expectedObject} does not match object stream ${objectStreamNumber}.`)
    return object
  }

  private async parseObjectStream(objectStreamNumber: number, resolutionStack: readonly string[]): Promise<Map<number, PdfIndirectObject>> {
    const entry = this.xref.get(objectStreamNumber)
    if (entry === undefined || entry.type !== 1) throw new IllustratorError('AI_PDF_OBJECT_STREAM_INVALID', 'container', `Object stream ${objectStreamNumber} is not an uncompressed indirect object.`)
    const object = await this.getObject({ kind: 'reference', objectNumber: objectStreamNumber, generation: entry.generation }, resolutionStack)
    if (object.stream === undefined || !isDictionary(object.value)) throw new IllustratorError('AI_PDF_OBJECT_STREAM_INVALID', 'container', `Object ${objectStreamNumber} is not a stream.`)
    const type = pdfName(object.value.entries.get('Type'))
    if (type !== undefined && type !== 'ObjStm') throw new IllustratorError('AI_PDF_OBJECT_STREAM_INVALID', 'container', `Object ${objectStreamNumber} has /Type /${type}, not /ObjStm.`)
    const count = pdfNumber(object.value.entries.get('N'))
    const first = pdfNumber(object.value.entries.get('First'))
    if (count === undefined || first === undefined || !Number.isSafeInteger(count) || !Number.isSafeInteger(first) || count < 0 || count > this.limits.maxPdfObjects || first < 0) {
      throw new IllustratorError('AI_PDF_OBJECT_STREAM_INVALID', 'container', `Object stream ${objectStreamNumber} has invalid /N or /First.`)
    }
    const decoded = await this.decodeStream(object, this.limits.maxDecodedBytes, this.budget.signal)
    if (first > decoded.length) throw new IllustratorError('AI_PDF_OBJECT_STREAM_TRUNCATED', 'container', `Object stream ${objectStreamNumber} /First is outside decoded data.`)
    const header = new PdfValueParser(decoded, 0, this.limits.maxNesting, this.budget)
    const pairs: { objectNumber: number; relativeOffset: number }[] = []
    const seen = new Set<number>()
    for (let i = 0; i < count; i++) {
      const number = header.parseNumberOrWord()
      const relativeOffset = header.parseNumberOrWord()
      if (typeof number !== 'number' || typeof relativeOffset !== 'number' || !Number.isSafeInteger(number) || !Number.isSafeInteger(relativeOffset) || number < 0 || relativeOffset < 0) {
        throw new IllustratorError('AI_PDF_OBJECT_STREAM_INVALID', 'container', `Object stream ${objectStreamNumber} header pair ${i} is invalid.`)
      }
      if (seen.has(number)) throw new IllustratorError('AI_PDF_OBJECT_STREAM_DUPLICATE', 'container', `Object stream ${objectStreamNumber} repeats object ${number}.`)
      seen.add(number)
      pairs.push({ objectNumber: number, relativeOffset })
    }
    if (header.offset > first) throw new IllustratorError('AI_PDF_OBJECT_STREAM_INVALID', 'container', `Object stream ${objectStreamNumber} header overlaps object data.`)
    const output = new Map<number, PdfIndirectObject>()
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]!
      const start = first + pair.relativeOffset
      const end = i + 1 < pairs.length ? first + pairs[i + 1]!.relativeOffset : decoded.length
      if (start < first || end < start || end > decoded.length) throw new IllustratorError('AI_PDF_OBJECT_STREAM_INVALID', 'container', `Object ${pair.objectNumber} has an invalid offset in object stream ${objectStreamNumber}.`)
      const parser = new PdfValueParser(decoded, start, this.limits.maxNesting, this.budget)
      const value = parser.parseValue()
      parser.skipTrivia()
      if (parser.offset > end) throw new IllustratorError('AI_PDF_OBJECT_STREAM_OVERLAP', 'container', `Object ${pair.objectNumber} overlaps the next compressed object.`)
      output.set(pair.objectNumber, { objectNumber: pair.objectNumber, generation: 0, value, offset: start, compressed: true })
    }
    return output
  }
}

function predictorParameters(value: PdfValue | undefined): PdfPredictorParameters | undefined {
  if (value === null || value === undefined) return undefined
  if (!isDictionary(value)) throw new IllustratorError('AI_PDF_DECODEPARMS_INVALID', 'decode', 'PDF /DecodeParms entry is not a dictionary.')
  return {
    ...(pdfNumber(value.entries.get('Predictor')) === undefined ? {} : { predictor: pdfNumber(value.entries.get('Predictor')) }),
    ...(pdfNumber(value.entries.get('Colors')) === undefined ? {} : { colors: pdfNumber(value.entries.get('Colors')) }),
    ...(pdfNumber(value.entries.get('BitsPerComponent')) === undefined ? {} : { bitsPerComponent: pdfNumber(value.entries.get('BitsPerComponent')) }),
    ...(pdfNumber(value.entries.get('Columns')) === undefined ? {} : { columns: pdfNumber(value.entries.get('Columns')) }),
  }
}

function filtersFromDictionary(dictionary: PdfDictionary): readonly PdfFilterSpec[] {
  const filter = dictionary.entries.get('Filter')
  if (filter === undefined) return []
  const names = isName(filter) ? [filter.value] : isArray(filter) ? filter.values.map((value) => {
    const name = pdfName(value)
    if (name === undefined) throw new IllustratorError('AI_PDF_FILTER_INVALID', 'decode', 'PDF /Filter array contains a non-name value.')
    return name
  }) : (() => { throw new IllustratorError('AI_PDF_FILTER_INVALID', 'decode', 'PDF /Filter must be a name or an array of names.') })()
  const decodeParameters = dictionary.entries.get('DecodeParms') ?? dictionary.entries.get('DP')
  let parameters: (PdfPredictorParameters | undefined)[]
  if (decodeParameters === undefined || decodeParameters === null) parameters = names.map(() => undefined)
  else if (isArray(decodeParameters)) {
    if (decodeParameters.values.length !== names.length) throw new IllustratorError('AI_PDF_DECODEPARMS_INVALID', 'decode', 'PDF /DecodeParms array length does not match /Filter.')
    parameters = decodeParameters.values.map(predictorParameters)
  } else {
    if (names.length !== 1) throw new IllustratorError('AI_PDF_DECODEPARMS_INVALID', 'decode', 'A single /DecodeParms dictionary cannot describe multiple filters.')
    parameters = [predictorParameters(decodeParameters)]
  }
  return names.map((name, index) => ({ name, ...(parameters[index] === undefined ? {} : { parameters: parameters[index] }) }))
}

export async function walkPdfObjectGraph(
  document: PdfDocument,
  start: PdfValue,
  visitor: (object: PdfIndirectObject) => void | Promise<void>,
  maximumObjects = document.limits.maxPdfObjects,
): Promise<void> {
  const pending: PdfReference[] = []
  const enqueue = (value: PdfValue): void => {
    if (isReference(value)) pending.push(value)
    else if (isArray(value)) for (const child of value.values) enqueue(child)
    else if (isDictionary(value)) for (const child of value.entries.values()) enqueue(child)
  }
  enqueue(start)
  const visited = new Set<string>()
  while (pending.length > 0) {
    const reference = pending.pop()!
    const key = `${reference.objectNumber}:${reference.generation}`
    if (visited.has(key)) continue
    if (visited.size >= maximumObjects) throw new IllustratorError('AI_PDF_GRAPH_LIMIT', 'container', `PDF object graph exceeds ${maximumObjects} objects.`)
    visited.add(key)
    const object = await document.getObject(reference)
    await visitor(object)
    enqueue(object.value)
  }
}
