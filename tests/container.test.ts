import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectIllustrator, decodeIllustratorPrivateSource } from '../src/node.js'
import { bytesEqual, latin1Encode } from '../src/util.js'
import { IllustratorError } from '../src/errors.js'
import {
  DIRECT_SOURCE_BYTES,
  makeClassicAiPdf,
  makeIncrementalAiPdf,
  makeXrefStreamAiPdf,
} from './fixtures.js'

test('direct Illustrator PostScript is recognized and decoded unchanged', async () => {
  const inspection = await inspectIllustrator(DIRECT_SOURCE_BYTES)
  assert.equal(inspection.kind, 'direct-postscript')
  assert.equal(inspection.privateSource, 'present')
  assert.equal(inspection.compression, 'none')
  const decoded = await decodeIllustratorPrivateSource(DIRECT_SOURCE_BYTES)
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
  assert.equal(decoded.fingerprint.sourceKind, 'direct-postscript')
})

test('renamed non-Illustrator PostScript is rejected', async () => {
  const bytes = latin1Encode('%!PS-Adobe-3.0\n%%Creator: Other Tool\n%%EOF\n')
  const inspection = await inspectIllustrator(bytes)
  assert.equal(inspection.kind, 'unknown')
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'AI_DIRECT_CREATOR_MISMATCH'))
  await assert.rejects(() => decodeIllustratorPrivateSource(bytes), (error: unknown) => error instanceof IllustratorError && error.code === 'AI_DIRECT_CREATOR_MISMATCH')
})

test('classic xref PDF extracts Catalog-reachable private source', async () => {
  const input = makeClassicAiPdf()
  const inspection = await inspectIllustrator(input)
  assert.equal(inspection.kind, 'pdf-private')
  assert.equal(inspection.pdfSurface, 'usable')
  assert.equal(inspection.privateBlocks, 1)
  const decoded = await decodeIllustratorPrivateSource(input)
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
  assert.equal(decoded.blocks[0]?.part, 1)
})

test('Illustrator deflate private-source marker is bounded and decoded', async () => {
  const decoded = await decodeIllustratorPrivateSource(makeClassicAiPdf({ privateCompression: 'deflate' }))
  assert.equal(decoded.compression, 'deflate')
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
})

test('real Illustrator deflate marker may be immediately followed by the zlib header', async () => {
  const input = makeClassicAiPdf({
    privateCompression: 'deflate',
    privateMarkerSeparator: 'adjacent',
  })
  const inspection = await inspectIllustrator(input)
  assert.equal(inspection.privateSource, 'present')
  assert.equal(inspection.compression, 'deflate')
  const decoded = await decodeIllustratorPrivateSource(input)
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
})

test('native payload may start at a later private block after an alternate preview prefix', async () => {
  const input = makeClassicAiPdf({
    privateCompression: 'deflate',
    privateMarkerSeparator: 'adjacent',
    privatePrefixBlock: latin1Encode('%%BoundingBox: 0 0 200 100\r%%BeginData: 0 Hex Bytes\r%%EndData\r'),
  })
  const inspection = await inspectIllustrator(input)
  assert.equal(inspection.privateSource, 'present')
  assert.equal(inspection.privateBlocks, 2)
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'AI_PRIVATE_PREFIX_BLOCKS_SKIPPED'))
  const decoded = await decodeIllustratorPrivateSource(input)
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
})

test('real Illustrator zstd marker may be immediately followed by the frame magic', async () => {
  const input = makeClassicAiPdf({
    privateCompression: 'zstd',
    privateMarkerSeparator: 'adjacent',
  })
  const inspection = await inspectIllustrator(input)
  assert.equal(inspection.privateSource, 'present')
  assert.equal(inspection.compression, 'zstd')
  const decoded = await decodeIllustratorPrivateSource(input)
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
})

test('Illustrator zstd private-source marker is decoded by the Node codec provider', async () => {
  const decoded = await decodeIllustratorPrivateSource(makeClassicAiPdf({ privateCompression: 'zstd' }))
  assert.equal(decoded.compression, 'zstd')
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
})

test('PDF-level FlateDecode and indirect stream Length share the same object model', async () => {
  const decoded = await decodeIllustratorPrivateSource(makeClassicAiPdf({ pdfFilter: 'flate', indirectLength: true }))
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
  assert.deepEqual(decoded.blocks[0]?.filters, ['FlateDecode'])
})

test('xref stream containers are supported', async () => {
  const input = makeXrefStreamAiPdf(false)
  const decoded = await decodeIllustratorPrivateSource(input)
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
})

test('object streams are supported without treating compressed objects as raw scans', async () => {
  const input = makeXrefStreamAiPdf(true)
  const decoded = await decodeIllustratorPrivateSource(input)
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
})

test('legal incremental xref updates retain access to older objects', async () => {
  const decoded = await decodeIllustratorPrivateSource(makeIncrementalAiPdf())
  assert.ok(bytesEqual(decoded.bytes, DIRECT_SOURCE_BYTES))
})

test('ordinary PDF with an .ai-like name is not classified as native Illustrator', async () => {
  const inspection = await inspectIllustrator(makeClassicAiPdf({ includePrivate: false, creator: 'Generic PDF Writer' }))
  assert.equal(inspection.kind, 'unknown')
  assert.equal(inspection.privateSource, 'missing')
  assert.equal(inspection.illustratorEvidence, false)
})

test('NumBlock mismatch is reported as a stable corruption code', async () => {
  const inspection = await inspectIllustrator(makeClassicAiPdf({ numBlock: 2 }))
  assert.equal(inspection.privateSource, 'corrupt')
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'AI_PRIVATE_BLOCK_COUNT_MISMATCH'))
})

test('generation mismatch is rejected instead of resolving another object generation', async () => {
  const inspection = await inspectIllustrator(makeClassicAiPdf({ blockGeneration: 1 }))
  assert.equal(inspection.privateSource, 'corrupt')
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'AI_PDF_GENERATION_MISMATCH'))
})

test('non-contiguous private block numbering is rejected', async () => {
  const inspection = await inspectIllustrator(makeClassicAiPdf({ blockPart: 2 }))
  assert.equal(inspection.privateSource, 'corrupt')
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'AI_PRIVATE_BLOCK_SEQUENCE'))
})

test('unsupported PDF stream filters fail closed', async () => {
  const inspection = await inspectIllustrator(makeClassicAiPdf({ pdfFilter: 'unsupported' }))
  assert.equal(inspection.privateSource, 'corrupt')
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'AI_PDF_FILTER_UNSUPPORTED'))
})

test('encrypted PDF private data is rejected', async () => {
  const inspection = await inspectIllustrator(makeClassicAiPdf({ encrypted: true }))
  assert.equal(inspection.privateSource, 'corrupt')
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'AI_PDF_ENCRYPTED'))
})

test('page-tree cycles are rejected deterministically', async () => {
  const inspection = await inspectIllustrator(makeClassicAiPdf({ pageTreeCycle: true }))
  assert.equal(inspection.privateSource, 'corrupt')
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'AI_PDF_PAGE_TREE_CYCLE'))
})

test('strict source termination can be relaxed only explicitly', async () => {
  const source = latin1Encode('%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator 8.0\n')
  await assert.rejects(() => decodeIllustratorPrivateSource(source), (error: unknown) => error instanceof IllustratorError && error.code === 'AI_SOURCE_EOF_MISSING')
  const decoded = await decodeIllustratorPrivateSource(source, { strictSourceTermination: false })
  assert.ok(decoded.diagnostics.some((diagnostic) => diagnostic.code === 'AI_SOURCE_EOF_MISSING'))
})

test('file and decompression budgets terminate before unbounded allocation', async () => {
  const input = makeClassicAiPdf({ privateCompression: 'deflate' })
  await assert.rejects(() => decodeIllustratorPrivateSource(input, { limits: { maxDecodedBytes: 128 } }), /limit|exceed|output/iu)
  const inspection = await inspectIllustrator(input, { limits: { maxFileBytes: 64 } })
  assert.ok(inspection.diagnostics.some((diagnostic) => diagnostic.code === 'AI_FILE_LIMIT'))
})
