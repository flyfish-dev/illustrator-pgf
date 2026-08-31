import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPdfPredictor,
  decodeAscii85,
  decodeAsciiHex,
  decodePdfFilters,
  decodeRunLength,
} from '../src/codecs.js'
import { nodeCodecProvider } from '../src/node-codecs.js'
import { inspectIllustrator } from '../src/node.js'
import { latin1Encode } from '../src/util.js'

test('ASCIIHex decoder handles whitespace, odd nibbles and terminator', () => {
  assert.deepEqual([...decodeAsciiHex(latin1Encode('61 62 6>'), 10)], [0x61, 0x62, 0x60])
})

test('ASCII85 decoder handles z shorthand and Adobe delimiters', () => {
  const decoded = decodeAscii85(latin1Encode('<~z87cURD]j7BEbo80~>'), 64)
  assert.deepEqual([...decoded.slice(0, 4)], [0, 0, 0, 0])
  assert.ok(decoded.byteLength > 4)
})

test('RunLength decoder expands literal and repeated runs with a bound', () => {
  const encoded = Uint8Array.of(2, 65, 66, 67, 254, 90, 128)
  assert.equal(new TextDecoder().decode(decodeRunLength(encoded, 16)), 'ABCZZZ')
  assert.throws(() => decodeRunLength(encoded, 5), /limit|exceed/iu)
})

test('PNG predictor filters are reversed deterministically', () => {
  const encoded = Uint8Array.of(1, 10, 10, 10, 2, 5, 5, 5)
  const decoded = applyPdfPredictor(encoded, { predictor: 15, colors: 1, bitsPerComponent: 8, columns: 3 }, 16)
  assert.deepEqual([...decoded], [10, 20, 30, 15, 25, 35])
})

test('PDF filter chains use a strict whitelist', async () => {
  await assert.rejects(() => decodePdfFilters(Uint8Array.of(1), [{ name: 'LZWDecode' }], nodeCodecProvider, 100), /unsupported/iu)
})

test('filter output limits are checked during decompression', async () => {
  const compressed = (await import('node:zlib')).deflateSync(new Uint8Array(1024))
  await assert.rejects(() => decodePdfFilters(compressed, [{ name: 'FlateDecode' }], nodeCodecProvider, 32), /limit|length|output|larger/iu)
})

test('container inspection is total over deterministic mutation inputs', async () => {
  let seed = 0x12345678
  for (let caseIndex = 0; caseIndex < 64; caseIndex++) {
    const length = 1 + (caseIndex * 17) % 257
    const bytes = new Uint8Array(length)
    for (let index = 0; index < length; index++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      bytes[index] = seed & 0xff
    }
    const result = await inspectIllustrator(bytes, { timeoutMs: 100 })
    assert.ok(['direct-postscript','pdf-private','pdf-surface-only','unknown'].includes(result.kind))
    assert.ok(Array.isArray(result.diagnostics))
  }
})
