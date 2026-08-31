import { deflateSync, zstdCompressSync } from 'node:zlib'
import { concatBytes, latin1Decode, latin1Encode } from '../src/util.js'

export const DIRECT_SOURCE_TEXT = [
  '%!PS-Adobe-3.0',
  '%%Creator: Adobe Illustrator 28.0',
  '%%AI8_CreatorVersion: 28.0',
  '%%BoundingBox: 0 0 200 100',
  '%AIArtboard: Main|0 0 200 100',
  '1 0 0 1 0 0 cm',
  '0.1 0.2 0.3 0.05 k',
  '0 0 0 1 K',
  '2 w',
  '1 1 1 1 0 0 0 79 128 255 Lb',
  '(Artwork) Ln',
  '10 10 m',
  '190 10 l',
  '190 90 l',
  '10 90 l',
  'h',
  'B',
  'BT',
  '/Helvetica 12 Tf',
  '1 0 0 1 30 45 Tm',
  '(Hello \\(PGF\\)) Tj',
  'ET',
  'mysteryVisibleOperator',
  'LB',
  '%%EOF',
  '',
].join('\n')

export const DIRECT_SOURCE_BYTES = latin1Encode(DIRECT_SOURCE_TEXT)

class ByteWriter {
  readonly parts: Uint8Array[] = []
  length = 0
  write(value: string | Uint8Array): void {
    const bytes = typeof value === 'string' ? latin1Encode(value) : value
    this.parts.push(bytes); this.length += bytes.byteLength
  }
  bytes(): Uint8Array { return concatBytes(this.parts) }
}

export interface ClassicAiPdfOptions {
  privateCompression?: 'none' | 'deflate' | 'zstd'
  pdfFilter?: 'none' | 'flate' | 'unsupported'
  indirectLength?: boolean
  includePrivate?: boolean
  creator?: string
  numBlock?: number
  blockPart?: number
  blockGeneration?: number
  encrypted?: boolean
  pageTreeCycle?: boolean
  source?: Uint8Array
}

function packedSource(source: Uint8Array, compression: ClassicAiPdfOptions['privateCompression']): Uint8Array {
  if (compression === 'deflate') return concatBytes([latin1Encode('%AI12_CompressedData\n'), deflateSync(source)])
  if (compression === 'zstd') return concatBytes([latin1Encode('%AI24_ZStandard_Data\n'), zstdCompressSync(source)])
  return source
}

function writeStreamObject(writer: ByteWriter, offsets: Map<number, number>, number: number, data: Uint8Array, dictionary: string): void {
  offsets.set(number, writer.length)
  writer.write(`${number} 0 obj\n<< ${dictionary} >>\nstream\n`)
  writer.write(data)
  writer.write('\nendstream\nendobj\n')
}

export function makeClassicAiPdf(options: ClassicAiPdfOptions = {}): Uint8Array {
  const includePrivate = options.includePrivate ?? true
  const source = options.source ?? DIRECT_SOURCE_BYTES
  const packed = packedSource(source, options.privateCompression ?? 'none')
  const pdfFilter = options.pdfFilter ?? 'none'
  const encoded = pdfFilter === 'flate' ? deflateSync(packed) : packed
  const filter = pdfFilter === 'flate' ? '/Filter /FlateDecode' : pdfFilter === 'unsupported' ? '/Filter /LZWDecode' : ''
  const writer = new ByteWriter()
  const offsets = new Map<number, number>()
  writer.write('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n')

  offsets.set(1, writer.length)
  writer.write(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R${includePrivate ? ' /PieceInfo << /Illustrator << /Private 4 0 R >> >>' : ''} >>\nendobj\n`)
  offsets.set(2, writer.length)
  writer.write(`2 0 obj\n<< /Type /Pages /Count 1 /Kids [${options.pageTreeCycle === true ? '2 0 R' : '3 0 R'}] >>\nendobj\n`)
  offsets.set(3, writer.length)
  writer.write('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>\nendobj\n')
  if (includePrivate) {
    offsets.set(4, writer.length)
    writer.write(`4 0 obj\n<< /NumBlock ${options.numBlock ?? 1} /AIPrivateData${options.blockPart ?? 1} 5 ${options.blockGeneration ?? 0} R >>\nendobj\n`)
    const lengthValue = options.indirectLength === true ? '7 0 R' : String(encoded.byteLength)
    writeStreamObject(writer, offsets, 5, encoded, `/Length ${lengthValue} ${filter}`)
  }
  offsets.set(6, writer.length)
  writer.write(`6 0 obj\n<< /Creator (${options.creator ?? 'Adobe Illustrator 28.0'}) >>\nendobj\n`)
  if (includePrivate && options.indirectLength === true) {
    offsets.set(7, writer.length)
    writer.write(`7 0 obj\n${encoded.byteLength}\nendobj\n`)
  }
  if (options.encrypted === true) {
    offsets.set(8, writer.length)
    writer.write('8 0 obj\n<< /Filter /Standard >>\nendobj\n')
  }

  const maxObject = Math.max(...offsets.keys(), 0)
  const xrefOffset = writer.length
  writer.write(`xref\n0 ${maxObject + 1}\n`)
  for (let objectNumber = 0; objectNumber <= maxObject; objectNumber++) {
    if (objectNumber === 0 || !offsets.has(objectNumber)) writer.write('0000000000 65535 f \n')
    else writer.write(`${String(offsets.get(objectNumber)).padStart(10, '0')} 00000 n \n`)
  }
  writer.write(`trailer\n<< /Size ${maxObject + 1} /Root 1 0 R /Info 6 0 R${options.encrypted === true ? ' /Encrypt 8 0 R' : ''} >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  return writer.bytes()
}

function writeBigEndian(output: Uint8Array, offset: number, width: number, value: number): void {
  for (let index = width - 1; index >= 0; index--) { output[offset + index] = value & 0xff; value = Math.floor(value / 256) }
}

function xrefBytes(entries: readonly { type: number; field1: number; field2: number }[]): Uint8Array {
  const output = new Uint8Array(entries.length * 7)
  entries.forEach((entry, index) => {
    const offset = index * 7
    output[offset] = entry.type
    writeBigEndian(output, offset + 1, 4, entry.field1)
    writeBigEndian(output, offset + 5, 2, entry.field2)
  })
  return output
}

export function makeXrefStreamAiPdf(useObjectStream = false): Uint8Array {
  const writer = new ByteWriter()
  const offsets = new Map<number, number>()
  writer.write('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n')
  const object = (number: number, body: string): void => {
    offsets.set(number, writer.length)
    writer.write(`${number} 0 obj\n${body}\nendobj\n`)
  }
  object(1, '<< /Type /Catalog /Pages 2 0 R /PieceInfo << /Illustrator << /Private 4 0 R >> >> >>')
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>')
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>')
  if (!useObjectStream) object(4, '<< /NumBlock 1 /AIPrivateData1 5 0 R >>')
  writeStreamObject(writer, offsets, 5, DIRECT_SOURCE_BYTES, `/Length ${DIRECT_SOURCE_BYTES.byteLength}`)
  if (useObjectStream) {
    const header = '4 0 '
    const body = '<< /NumBlock 1 /AIPrivateData1 5 0 R >>'
    const content = latin1Encode(header + body)
    writeStreamObject(writer, offsets, 7, content, `/Type /ObjStm /N 1 /First ${header.length} /Length ${content.byteLength}`)
  }
  object(8, '<< /Creator (Adobe Illustrator 28.0) >>')

  const xrefObject = 6
  const xrefOffset = writer.length
  offsets.set(xrefObject, xrefOffset)
  const size = 9
  const entries = Array.from({ length: size }, (_, objectNumber) => {
    if (objectNumber === 0) return { type: 0, field1: 0, field2: 65535 }
    if (useObjectStream && objectNumber === 4) return { type: 2, field1: 7, field2: 0 }
    const offset = offsets.get(objectNumber)
    return offset === undefined ? { type: 0, field1: 0, field2: 0 } : { type: 1, field1: offset, field2: 0 }
  })
  const data = xrefBytes(entries)
  writeStreamObject(writer, new Map([[xrefObject, xrefOffset]]), xrefObject, data, `/Type /XRef /Size ${size} /Root 1 0 R /Info 8 0 R /W [1 4 2] /Index [0 ${size}] /Length ${data.byteLength}`)
  writer.write(`startxref\n${xrefOffset}\n%%EOF\n`)
  return writer.bytes()
}

export function makeIncrementalAiPdf(): Uint8Array {
  const base = makeClassicAiPdf()
  const source = latin1Decode(base)
  const previous = Number(/startxref\s+(\d+)\s+%%EOF\s*$/u.exec(source)?.[1])
  const writer = new ByteWriter()
  writer.write(base)
  const objectOffset = writer.length
  writer.write('9 0 obj\n<< /Producer (Incremental test) >>\nendobj\n')
  const xrefOffset = writer.length
  writer.write(`xref\n9 1\n${String(objectOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 10 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  return writer.bytes()
}
