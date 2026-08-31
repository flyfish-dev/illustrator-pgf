import { IllustratorError } from './errors.js'
import { WorkBudget, concatBytes, throwIfAborted } from './util.js'

export interface IllustratorCodecProvider {
  inflate(input: Uint8Array, maxOutputBytes: number, signal?: AbortSignal): Promise<Uint8Array>
  inflateRaw(input: Uint8Array, maxOutputBytes: number, signal?: AbortSignal): Promise<Uint8Array>
  zstd?(input: Uint8Array, maxOutputBytes: number, signal?: AbortSignal): Promise<Uint8Array>
}

async function decompressionStreamDecode(
  format: 'deflate' | 'deflate-raw',
  input: Uint8Array,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal)
  if (typeof DecompressionStream === 'undefined') {
    throw new IllustratorError('AI_CODEC_UNAVAILABLE', 'decode', `${format} decompression is unavailable in this runtime.`)
  }
  let stream: DecompressionStream
  try {
    stream = new DecompressionStream(format)
  } catch (error) {
    throw new IllustratorError('AI_CODEC_UNAVAILABLE', 'decode', `${format} decompression is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const copy = input.slice()
  const response = new Response(new Blob([copy]).stream().pipeThrough(stream))
  const reader = response.body?.getReader()
  if (reader === undefined) throw new IllustratorError('AI_CODEC_FAILED', 'decode', 'Decompression stream produced no readable body.')
  const parts: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maxOutputBytes) {
        await reader.cancel('output-limit')
        throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `Decompressed data exceeds the ${maxOutputBytes}-byte limit.`)
      }
      parts.push(result.value)
    }
  } catch (error) {
    if (error instanceof IllustratorError) throw error
    throw new IllustratorError('AI_CODEC_FAILED', 'decode', `${format} decompression failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    reader.releaseLock()
  }
  return concatBytes(parts, maxOutputBytes)
}

export const browserCodecProvider: IllustratorCodecProvider = {
  inflate: (input, maximum, signal) => decompressionStreamDecode('deflate', input, maximum, signal),
  inflateRaw: (input, maximum, signal) => decompressionStreamDecode('deflate-raw', input, maximum, signal),
}

export function createBrowserCodecProvider(
  zstdDecoder?: (input: Uint8Array, maxOutputBytes: number, signal?: AbortSignal) => Promise<Uint8Array>,
): IllustratorCodecProvider {
  return { ...browserCodecProvider, ...(zstdDecoder === undefined ? {} : { zstd: zstdDecoder }) }
}

export function decodeAsciiHex(input: Uint8Array, maxOutputBytes: number): Uint8Array {
  const output = new Uint8Array(Math.min(maxOutputBytes, Math.ceil(input.byteLength / 2)))
  let high = -1
  let offset = 0
  for (const byte of input) {
    if (byte === 0x3e) break
    if (byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32) continue
    const nibble = byte >= 48 && byte <= 57 ? byte - 48 : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1
    if (nibble < 0) throw new IllustratorError('AI_ASCIIHEX_INVALID', 'decode', `Invalid ASCIIHex byte 0x${byte.toString(16)}.`)
    if (high < 0) high = nibble
    else {
      if (offset >= maxOutputBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `ASCIIHex output exceeds ${maxOutputBytes} bytes.`)
      output[offset++] = (high << 4) | nibble
      high = -1
    }
  }
  if (high >= 0) {
    if (offset >= maxOutputBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `ASCIIHex output exceeds ${maxOutputBytes} bytes.`)
    output[offset++] = high << 4
  }
  return output.slice(0, offset)
}

export function decodeAscii85(input: Uint8Array, maxOutputBytes: number): Uint8Array {
  const values: number[] = []
  let tuple: number[] = []
  let started = false
  let finished = false
  const emitTuple = (count = 5): void => {
    while (tuple.length < 5) tuple.push(84)
    let value = 0
    for (const digit of tuple) value = value * 85 + digit
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    const emit = count - 1
    if (values.length + emit > maxOutputBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `ASCII85 output exceeds ${maxOutputBytes} bytes.`)
    for (let i = 0; i < emit; i++) values.push(bytes[i]!)
    tuple = []
  }
  for (let i = 0; i < input.length; i++) {
    const byte = input[i]!
    if (!started && byte === 0x3c && input[i + 1] === 0x7e) { started = true; i++; continue }
    if (byte === 0x7e && input[i + 1] === 0x3e) {
      if (tuple.length === 1) throw new IllustratorError('AI_ASCII85_INVALID', 'decode', 'ASCII85 has a one-digit final tuple.')
      if (tuple.length > 1) emitTuple(tuple.length)
      finished = true
      break
    }
    if (byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32) continue
    started = true
    if (byte === 0x7a) {
      if (tuple.length !== 0) throw new IllustratorError('AI_ASCII85_INVALID', 'decode', 'ASCII85 z abbreviation appears inside a tuple.')
      if (values.length + 4 > maxOutputBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `ASCII85 output exceeds ${maxOutputBytes} bytes.`)
      values.push(0, 0, 0, 0)
      continue
    }
    if (byte < 33 || byte > 117) throw new IllustratorError('AI_ASCII85_INVALID', 'decode', `Invalid ASCII85 byte 0x${byte.toString(16)}.`)
    tuple.push(byte - 33)
    if (tuple.length === 5) emitTuple()
  }
  if (!finished && tuple.length > 0) {
    if (tuple.length === 1) throw new IllustratorError('AI_ASCII85_INVALID', 'decode', 'ASCII85 has a one-digit final tuple.')
    emitTuple(tuple.length)
  }
  return Uint8Array.from(values)
}

export function decodeRunLength(input: Uint8Array, maxOutputBytes: number): Uint8Array {
  const output: number[] = []
  let offset = 0
  while (offset < input.length) {
    const length = input[offset++]!
    if (length === 128) break
    if (length <= 127) {
      const count = length + 1
      if (offset + count > input.length) throw new IllustratorError('AI_RUNLENGTH_TRUNCATED', 'decode', 'RunLength literal segment is truncated.')
      if (output.length + count > maxOutputBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `RunLength output exceeds ${maxOutputBytes} bytes.`)
      for (let i = 0; i < count; i++) output.push(input[offset + i]!)
      offset += count
    } else {
      if (offset >= input.length) throw new IllustratorError('AI_RUNLENGTH_TRUNCATED', 'decode', 'RunLength repeated segment is truncated.')
      const count = 257 - length
      if (output.length + count > maxOutputBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `RunLength output exceeds ${maxOutputBytes} bytes.`)
      const value = input[offset++]!
      for (let i = 0; i < count; i++) output.push(value)
    }
  }
  return Uint8Array.from(output)
}

export interface PdfPredictorParameters {
  predictor?: number
  colors?: number
  bitsPerComponent?: number
  columns?: number
}

export function applyPdfPredictor(input: Uint8Array, parameters: PdfPredictorParameters, maxOutputBytes: number): Uint8Array {
  const predictor = parameters.predictor ?? 1
  if (predictor === 1) return input
  const colors = parameters.colors ?? 1
  const bits = parameters.bitsPerComponent ?? 8
  const columns = parameters.columns ?? 1
  if (![1, 2, 4, 8, 16].includes(bits) || colors < 1 || columns < 1) throw new IllustratorError('AI_PDF_PREDICTOR_INVALID', 'decode', 'Invalid PDF predictor parameters.')
  const bytesPerPixel = Math.max(1, Math.ceil(colors * bits / 8))
  const rowBytes = Math.ceil(colors * columns * bits / 8)
  if (predictor === 2) {
    if (input.length > maxOutputBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `Predictor output exceeds ${maxOutputBytes} bytes.`)
    const output = input.slice()
    for (let row = 0; row < output.length; row += rowBytes) {
      for (let i = bytesPerPixel; i < Math.min(rowBytes, output.length - row); i++) output[row + i] = (output[row + i]! + output[row + i - bytesPerPixel]!) & 0xff
    }
    return output
  }
  if (predictor < 10 || predictor > 15) throw new IllustratorError('AI_PDF_PREDICTOR_UNSUPPORTED', 'decode', `Unsupported PDF predictor ${predictor}.`)
  const encodedRow = rowBytes + 1
  if (input.length % encodedRow !== 0) throw new IllustratorError('AI_PDF_PREDICTOR_TRUNCATED', 'decode', 'PNG predictor data has a truncated row.')
  const rows = input.length / encodedRow
  const outputLength = rows * rowBytes
  if (outputLength > maxOutputBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `Predictor output exceeds ${maxOutputBytes} bytes.`)
  const output = new Uint8Array(outputLength)
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c
    const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let row = 0; row < rows; row++) {
    const filter = input[row * encodedRow]!
    const sourceOffset = row * encodedRow + 1
    const targetOffset = row * rowBytes
    for (let column = 0; column < rowBytes; column++) {
      const raw = input[sourceOffset + column]!
      const left = column >= bytesPerPixel ? output[targetOffset + column - bytesPerPixel]! : 0
      const up = row > 0 ? output[targetOffset + column - rowBytes]! : 0
      const upLeft = row > 0 && column >= bytesPerPixel ? output[targetOffset + column - rowBytes - bytesPerPixel]! : 0
      const value = filter === 0 ? raw
        : filter === 1 ? raw + left
        : filter === 2 ? raw + up
        : filter === 3 ? raw + Math.floor((left + up) / 2)
        : filter === 4 ? raw + paeth(left, up, upLeft)
        : Number.NaN
      if (!Number.isFinite(value)) throw new IllustratorError('AI_PDF_PREDICTOR_INVALID', 'decode', `Unknown PNG predictor row filter ${filter}.`)
      output[targetOffset + column] = value & 0xff
    }
  }
  return output
}

export interface PdfFilterSpec { name: string; parameters?: PdfPredictorParameters }

export async function decodePdfFilters(
  input: Uint8Array,
  filters: readonly PdfFilterSpec[],
  codecs: IllustratorCodecProvider,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const budget = new WorkBudget(signal, 30_000)
  let output = input
  for (const filter of filters) {
    budget.checkpoint('decode')
    const name = filter.name.replace(/^\//u, '')
    switch (name) {
      case 'ASCIIHexDecode': case 'AHx': output = decodeAsciiHex(output, maxOutputBytes); break
      case 'ASCII85Decode': case 'A85': output = decodeAscii85(output, maxOutputBytes); break
      case 'FlateDecode': case 'Fl': {
        output = await codecs.inflate(output, maxOutputBytes, signal)
        output = applyPdfPredictor(output, filter.parameters ?? {}, maxOutputBytes)
        break
      }
      case 'RunLengthDecode': case 'RL': output = decodeRunLength(output, maxOutputBytes); break
      default: throw new IllustratorError('AI_PDF_FILTER_UNSUPPORTED', 'decode', `Unsupported PDF stream filter /${name}.`)
    }
    if (output.byteLength > maxOutputBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `Decoded stream exceeds ${maxOutputBytes} bytes.`)
  }
  return output
}
