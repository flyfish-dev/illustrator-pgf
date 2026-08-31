import type {
  DecodeOptions,
  IllustratorContainerInspection,
  IllustratorDecodedSource,
  IllustratorDiagnostic,
  IllustratorInput,
  IllustratorPrivateBlockInfo,
  IllustratorVersionFingerprint,
  InspectOptions,
} from './types.js'
import type { IllustratorCodecProvider } from './codecs.js'
import { browserCodecProvider, createBrowserCodecProvider } from './codecs.js'
import { IllustratorError, asDiagnostic, diagnostic } from './errors.js'
import { resolveLimits } from './limits.js'
import {
  PdfDocument,
  pdfArray,
  pdfDictionary,
  pdfGet,
  pdfName,
  pdfNumber,
  pdfReference,
  pdfString,
  type PdfDictionary,
  type PdfIndirectObject,
  type PdfReference,
  type PdfValue,
} from './pdf.js'
import { WorkBudget, concatBytes, inputToBytes, latin1Decode, sha256 } from './util.js'

export interface ContainerRuntimeOptions {
  codecProvider?: IllustratorCodecProvider
  zstdDecoder?: (input: Uint8Array, maxOutputBytes: number, signal?: AbortSignal) => Promise<Uint8Array>
}

interface DescriptorCandidate {
  id: string
  dictionary: PdfDictionary
  object?: PdfIndirectObject
  reachable: boolean
}

interface PdfAnalysis {
  pdf: PdfDocument
  inspection: IllustratorContainerInspection
  descriptor?: DescriptorCandidate
  packed?: Uint8Array
  blocks: IllustratorPrivateBlockInfo[]
  diagnostics: IllustratorDiagnostic[]
}

interface ParsedMarker { compression: 'none' | 'deflate' | 'zstd'; payloadOffset: number; marker?: string }

function runtimeCodecs(runtime?: ContainerRuntimeOptions): IllustratorCodecProvider {
  if (runtime?.codecProvider !== undefined) return runtime.codecProvider
  return createBrowserCodecProvider(runtime?.zstdDecoder)
}

function extractNumericValues(source: string, names: readonly string[]): number[] {
  const values: number[] = []
  for (const name of names) {
    const expressions = [
      new RegExp(String.raw`/${name}\s+([0-9]+(?:\.[0-9]+)?)`, 'giu'),
      new RegExp(String.raw`%+${name}\s*:\s*([0-9]+(?:\.[0-9]+)?)`, 'giu'),
      new RegExp(String.raw`\b${name}\s*=\s*([0-9]+(?:\.[0-9]+)?)`, 'giu'),
    ]
    for (const expression of expressions) for (const match of source.matchAll(expression)) values.push(Number(match[1]))
  }
  return values.filter(Number.isFinite)
}

function uniqueNumber(values: readonly number[], field: string, contradictions: string[]): number | undefined {
  const unique = [...new Set(values)]
  if (unique.length > 1) contradictions.push(`${field} has conflicting values: ${unique.join(', ')}.`)
  return unique[0]
}

function sourceFingerprint(
  source: string,
  sourceKind: IllustratorVersionFingerprint['sourceKind'],
  pdfVersion?: string,
  mime?: string,
  creator?: string,
): IllustratorVersionFingerprint {
  const contradictions: string[] = []
  const markers = [...new Set([...source.matchAll(/%(AI\d+_[A-Za-z0-9_]+)/gu)].map((match) => `%${match[1]}`))]
  const containerVersion = uniqueNumber(extractNumericValues(source, ['ContainerVersion']), 'ContainerVersion', contradictions)
  const creatorVersion = uniqueNumber(extractNumericValues(source, ['CreatorVersion']), 'CreatorVersion', contradictions)
  const roundtripVersion = uniqueNumber(extractNumericValues(source, ['RoundtripVersion']), 'RoundtripVersion', contradictions)
  const ai8 = /%%AI8_CreatorVersion\s*:\s*([^\r\n]+)/iu.exec(source)?.[1]?.trim()
  const ai5Raw = /%%AI5_FileFormat\s*:\s*([0-9]+(?:\.[0-9]+)?)/iu.exec(source)?.[1]
  const namespace = /(?:xmlns:illustrator|xmlns:ai)\s*=\s*["']([^"']+)["']/iu.exec(source)?.[1]
  return {
    sourceKind,
    ...(pdfVersion === undefined ? {} : { pdfVersion }),
    ...(containerVersion === undefined ? {} : { containerVersion }),
    ...(creatorVersion === undefined ? {} : { creatorVersion }),
    ...(roundtripVersion === undefined ? {} : { roundtripVersion }),
    ...(ai8 === undefined ? {} : { ai8CreatorVersion: ai8 }),
    ...(ai5Raw === undefined ? {} : { ai5FileFormat: Number(ai5Raw) }),
    featureMarkers: markers,
    ...(mime === undefined ? {} : { mime }),
    ...(creator === undefined ? {} : { creator }),
    ...(namespace === undefined ? {} : { illustratorNamespace: namespace }),
    contradictions,
  }
}

function isIllustratorDirectSource(text: string): boolean {
  return /^%!PS-Adobe(?:-|\s)/u.test(text) && /%%Creator\s*:\s*.*Adobe\s+Illustrator/iu.test(text)
}

function markerLineEnd(bytes: Uint8Array, start: number): number {
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) return i + 1
    if (bytes[i] === 0x0d) return bytes[i + 1] === 0x0a ? i + 2 : i + 1
  }
  return -1
}

function parseCompressionMarker(bytes: Uint8Array): ParsedMarker {
  const prefix = latin1Decode(bytes.subarray(0, Math.min(bytes.length, 256)))
  if (/^%!PS-Adobe(?:-|\s)/u.test(prefix)) return { compression: 'none', payloadOffset: 0 }
  for (const [expression, compression] of [
    [/^%AI(?:12|13|14|15|16|17|18|19|20|21|22|23)_CompressedData\b/u, 'deflate'],
    [/^%AI24_ZStandard_Data\b/u, 'zstd'],
  ] as const) {
    const match = expression.exec(prefix)
    if (match !== null) {
      const end = markerLineEnd(bytes, match.index + match[0].length)
      if (end < 0) throw new IllustratorError('AI_PRIVATE_MARKER_TRUNCATED', 'decode', `${match[0]} marker has no line ending.`)
      return { compression, payloadOffset: end, marker: match[0] }
    }
  }
  throw new IllustratorError('AI_PRIVATE_MARKER_UNKNOWN', 'decode', 'Illustrator private source has no recognized PostScript, deflate, or zstd marker.')
}

function validateDecodedSource(bytes: Uint8Array, strictTermination: boolean): IllustratorDiagnostic[] {
  const diagnostics: IllustratorDiagnostic[] = []
  const source = latin1Decode(bytes)
  if (!/^%!PS-Adobe(?:-|\s)/u.test(source)) throw new IllustratorError('AI_SOURCE_HEADER_INVALID', 'decode', 'Decoded Illustrator source does not begin with a PostScript header.')
  if (!/%%Creator\s*:\s*.*Adobe\s+Illustrator/iu.test(source)) throw new IllustratorError('AI_SOURCE_CREATOR_INVALID', 'decode', 'Decoded source is not identified as Adobe Illustrator source.')
  const eof = source.lastIndexOf('%%EOF')
  if (eof < 0) {
    if (strictTermination) throw new IllustratorError('AI_SOURCE_EOF_MISSING', 'decode', 'Decoded Illustrator source has no %%EOF terminator.')
    diagnostics.push(diagnostic('AI_SOURCE_EOF_MISSING', 'warning', 'decode', 'Decoded Illustrator source has no %%EOF terminator.'))
  } else {
    const trailing = source.slice(eof + 5)
    if (!/^[\s\0]*$/u.test(trailing)) diagnostics.push(diagnostic('AI_SOURCE_TRAILING_DATA', 'warning', 'decode', `Decoded Illustrator source contains ${trailing.length} non-whitespace characters after %%EOF.`))
  }
  return diagnostics
}

async function creatorFromPdf(pdf: PdfDocument): Promise<string | undefined> {
  const info = pdf.getTrailerValue('Info')
  const dictionary = await pdf.resolveDictionary(info)
  return pdfString(pdfGet(dictionary, 'Creator')) ?? pdfString(pdfGet(dictionary, 'Producer'))
}

async function pdfSurfaceState(pdf: PdfDocument, rawSource: string): Promise<IllustratorContainerInspection['pdfSurface']> {
  if (/saved without PDF Content|without PDF compatible content|PDF Content is not available/iu.test(rawSource)) return 'warning-placeholder'
  const root = await pdf.getRoot()
  const rootDictionary = pdfDictionary(root.value)
  if (rootDictionary === undefined) return 'unknown'
  const pages = await pdf.resolveDictionary(pdfGet(rootDictionary, 'Pages'))
  if (pages === undefined) return 'absent'
  const count = pdfNumber(pdfGet(pages, 'Count'))
  const kids = pdfArray(pdfGet(pages, 'Kids'))
  return (count !== undefined && count > 0) || (kids !== undefined && kids.length > 0) ? 'usable' : 'absent'
}

function privateDataEntries(dictionary: PdfDictionary): { part: number; value: PdfValue; key: string }[] {
  const entries: { part: number; value: PdfValue; key: string }[] = []
  for (const [key, value] of dictionary.entries) {
    const match = /^(?:AI|AIPDF)PrivateData(\d+)$/u.exec(key)
    if (match !== null) entries.push({ part: Number(match[1]), value, key })
  }
  return entries
}

async function collectDescriptorCandidates(pdf: PdfDocument): Promise<{ all: DescriptorCandidate[]; reachable: DescriptorCandidate[] }> {
  const allById = new Map<string, DescriptorCandidate>()
  for (const object of await pdf.allObjects()) {
    const dictionary = pdfDictionary(object.value)
    if (dictionary !== undefined && privateDataEntries(dictionary).length > 0) {
      const id = `obj:${object.objectNumber}:${object.generation}`
      allById.set(id, { id, dictionary, object, reachable: false })
    }
  }
  let directCounter = 0
  const reachableById = new Map<string, DescriptorCandidate>()
  const dictionaryCandidate = async (value: PdfValue | undefined, label: string): Promise<{ id: string; dictionary: PdfDictionary; object?: PdfIndirectObject } | undefined> => {
    if (value === undefined) return undefined
    const reference = pdfReference(value)
    if (reference !== undefined) {
      const object = await pdf.getObject(reference)
      const dictionary = pdfDictionary(object.value)
      return dictionary === undefined ? undefined : { id: `obj:${object.objectNumber}:${object.generation}`, dictionary, object }
    }
    const dictionary = pdfDictionary(value)
    return dictionary === undefined ? undefined : { id: `direct:${label}:${directCounter++}`, dictionary }
  }
  const inspectOwner = async (owner: PdfDictionary, label: string): Promise<void> => {
    const piece = await dictionaryCandidate(pdfGet(owner, 'PieceInfo'), `${label}:piece`)
    if (piece === undefined) return
    const illustrator = await dictionaryCandidate(pdfGet(piece.dictionary, 'Illustrator'), `${label}:illustrator`)
    if (illustrator === undefined) return
    const privateDescriptor = await dictionaryCandidate(pdfGet(illustrator.dictionary, 'Private'), `${label}:private`)
    if (privateDescriptor === undefined || privateDataEntries(privateDescriptor.dictionary).length === 0) return
    const existing = allById.get(privateDescriptor.id)
    const candidate: DescriptorCandidate = existing === undefined
      ? { id: privateDescriptor.id, dictionary: privateDescriptor.dictionary, ...(privateDescriptor.object === undefined ? {} : { object: privateDescriptor.object }), reachable: true }
      : { ...existing, reachable: true }
    allById.set(candidate.id, candidate)
    reachableById.set(candidate.id, candidate)
  }
  const root = await pdf.getRoot()
  const rootDictionary = pdfDictionary(root.value)
  if (rootDictionary !== undefined) {
    await inspectOwner(rootDictionary, 'catalog')
    const pagesValue = pdfGet(rootDictionary, 'Pages')
    const initial = pdfReference(pagesValue)
    const pending: PdfReference[] = initial === undefined ? [] : [initial]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const reference = pending.pop()!
      const key = `${reference.objectNumber}:${reference.generation}`
      if (visited.has(key)) throw new IllustratorError('AI_PDF_PAGE_TREE_CYCLE', 'container', `PDF page tree contains a cycle at ${key}.`)
      if (visited.size >= pdf.limits.maxPdfObjects) throw new IllustratorError('AI_PDF_PAGE_TREE_LIMIT', 'container', 'PDF page tree exceeds the object limit.')
      visited.add(key)
      const object = await pdf.getObject(reference)
      const dictionary = pdfDictionary(object.value)
      if (dictionary === undefined) throw new IllustratorError('AI_PDF_PAGE_TREE_INVALID', 'container', `PDF page tree object ${key} is not a dictionary.`)
      await inspectOwner(dictionary, `page:${key}`)
      for (const child of pdfArray(pdfGet(dictionary, 'Kids')) ?? []) {
        const childReference = pdfReference(child)
        if (childReference === undefined) throw new IllustratorError('AI_PDF_PAGE_TREE_INVALID', 'container', `PDF page tree object ${key} contains a direct or invalid /Kids entry.`)
        pending.push(childReference)
      }
    }
  }
  return { all: [...allById.values()], reachable: [...reachableById.values()] }
}

async function chooseDescriptor(pdf: PdfDocument, illustratorEvidence: boolean, diagnostics: IllustratorDiagnostic[]): Promise<DescriptorCandidate | undefined> {
  const candidates = await collectDescriptorCandidates(pdf)
  if (candidates.reachable.length > 1) throw new IllustratorError('AI_PRIVATE_DESCRIPTOR_AMBIGUOUS', 'container', 'Multiple Catalog-reachable Illustrator private-source descriptors were found.')
  if (candidates.reachable.length === 1) {
    const selected = candidates.reachable[0]!
    const unrelated = candidates.all.filter((candidate) => candidate.id !== selected.id)
    if (unrelated.length > 0) throw new IllustratorError('AI_PRIVATE_DESCRIPTOR_AMBIGUOUS', 'container', 'PDF contains additional unreferenced Illustrator private-source descriptors.')
    return selected
  }
  if (candidates.all.length > 1) throw new IllustratorError('AI_PRIVATE_DESCRIPTOR_AMBIGUOUS', 'container', 'PDF contains multiple ambiguous Illustrator private-source descriptors.')
  if (candidates.all.length === 1) {
    if (!illustratorEvidence) throw new IllustratorError('AI_PRIVATE_EVIDENCE_MISSING', 'container', 'An unreferenced AIPrivateData dictionary is present without independent Illustrator evidence.')
    diagnostics.push(diagnostic('AI_PRIVATE_DESCRIPTOR_UNREACHABLE', 'warning', 'container', 'The only Illustrator private-source descriptor is not reachable through Catalog/PieceInfo; it is accepted with reduced trust.', { recovery: 'Re-save the file from Illustrator with editing capabilities preserved.' }))
    return candidates.all[0]
  }
  return undefined
}

async function extractPackedSource(
  pdf: PdfDocument,
  descriptor: DescriptorCandidate,
  limits: ReturnType<typeof resolveLimits>,
  signal: AbortSignal | undefined,
): Promise<{ packed: Uint8Array; blocks: IllustratorPrivateBlockInfo[] }> {
  const entries = privateDataEntries(descriptor.dictionary).sort((left, right) => left.part - right.part)
  if (entries.length === 0) throw new IllustratorError('AI_PRIVATE_BLOCKS_MISSING', 'container', 'Illustrator private-source descriptor contains no data blocks.')
  if (entries.length > limits.maxPrivateBlocks) throw new IllustratorError('AI_PRIVATE_BLOCK_LIMIT', 'container', `Illustrator private source exceeds ${limits.maxPrivateBlocks} blocks.`)
  const declaredRaw = pdfGet(descriptor.dictionary, 'NumBlock')
  const declaredResolved = declaredRaw === undefined ? undefined : await pdf.resolve(declaredRaw)
  const declared = pdfNumber(declaredResolved)
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared !== entries.length)) throw new IllustratorError('AI_PRIVATE_BLOCK_COUNT_MISMATCH', 'container', `/NumBlock declares ${declared}, but ${entries.length} blocks are present.`)
  const seen = new Set<number>()
  const chunks: Uint8Array[] = []
  const blocks: IllustratorPrivateBlockInfo[] = []
  let total = 0
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (seen.has(entry.part) || entry.part !== index + 1) throw new IllustratorError('AI_PRIVATE_BLOCK_SEQUENCE', 'container', 'Illustrator private-source block numbers must be unique and contiguous from 1.')
    seen.add(entry.part)
    const reference = pdfReference(entry.value)
    if (reference === undefined) throw new IllustratorError('AI_PRIVATE_BLOCK_REFERENCE', 'container', `/${entry.key} is not an indirect PDF stream reference.`)
    const object = await pdf.getObject(reference)
    if (object.stream === undefined) throw new IllustratorError('AI_PRIVATE_BLOCK_STREAM_MISSING', 'container', `/${entry.key} references PDF object ${reference.objectNumber}, which is not a stream.`)
    const decoded = await pdf.decodeStream(object, limits.maxDecodedBytes - total, signal)
    total += decoded.byteLength
    if (total > limits.maxDecodedBytes) throw new IllustratorError('AI_PRIVATE_PACKED_LIMIT', 'decode', `Packed Illustrator source exceeds ${limits.maxDecodedBytes} bytes.`)
    chunks.push(decoded)
    blocks.push({
      part: entry.part,
      objectNumber: object.objectNumber,
      generation: object.generation,
      encodedBytes: object.stream.encoded.byteLength,
      decodedBytes: decoded.byteLength,
      sha256: await sha256(decoded),
      filters: object.stream.filters.map((filter) => filter.name),
    })
  }
  return { packed: concatBytes(chunks, limits.maxDecodedBytes), blocks }
}

async function analyzePdf(bytes: Uint8Array, options: InspectOptions, codecs: IllustratorCodecProvider): Promise<PdfAnalysis> {
  const limits = resolveLimits(options.limits)
  const diagnostics: IllustratorDiagnostic[] = []
  const pdf = await PdfDocument.open(bytes, { limits, codecs, signal: options.signal, timeoutMs: options.timeoutMs })
  diagnostics.push(...pdf.diagnostics)
  const rawSource = latin1Decode(bytes)
  const creator = await creatorFromPdf(pdf)
  const preliminaryEvidence = /Adobe\s+Illustrator|xmlns:(?:illustrator|ai)\s*=|\/AI(?:PDF)?PrivateData\d+/iu.test(rawSource) || /Illustrator/iu.test(creator ?? '')
  const descriptor = await chooseDescriptor(pdf, preliminaryEvidence, diagnostics)
  const illustratorEvidence = preliminaryEvidence || descriptor !== undefined
  const pdfSurface = await pdfSurfaceState(pdf, rawSource)
  let packed: Uint8Array | undefined
  let blocks: IllustratorPrivateBlockInfo[] = []
  let compression: 'none' | 'deflate' | 'zstd' | undefined
  if (descriptor !== undefined) {
    const extracted = await extractPackedSource(pdf, descriptor, limits, options.signal)
    packed = extracted.packed
    blocks = extracted.blocks
    compression = parseCompressionMarker(packed).compression
  }
  const kind = descriptor !== undefined ? 'pdf-private' : illustratorEvidence ? 'pdf-surface-only' : 'unknown'
  const fingerprint = sourceFingerprint(rawSource, kind, pdf.version, options.mime, creator)
  for (const contradiction of fingerprint.contradictions) diagnostics.push(diagnostic('AI_VERSION_CONTRADICTION', 'warning', 'container', contradiction))
  const inspection: IllustratorContainerInspection = {
    kind,
    illustratorEvidence,
    pdfSurface,
    privateSource: descriptor === undefined ? 'missing' : 'present',
    ...(compression === undefined ? {} : { compression }),
    ...(fingerprint.containerVersion === undefined ? {} : { containerVersion: fingerprint.containerVersion }),
    ...(fingerprint.creatorVersion === undefined ? {} : { creatorVersion: fingerprint.creatorVersion }),
    ...(fingerprint.roundtripVersion === undefined ? {} : { roundtripVersion: fingerprint.roundtripVersion }),
    privateBlocks: blocks.length,
    fingerprint,
    diagnostics,
  }
  return { pdf, inspection, ...(descriptor === undefined ? {} : { descriptor }), ...(packed === undefined ? {} : { packed }), blocks, diagnostics }
}

function emptyFingerprint(kind: IllustratorVersionFingerprint['sourceKind'], source: string, mime?: string): IllustratorVersionFingerprint {
  return sourceFingerprint(source, kind, undefined, mime)
}

export async function inspectIllustratorContainer(
  input: IllustratorInput,
  options: InspectOptions = {},
  runtime: ContainerRuntimeOptions = {},
): Promise<IllustratorContainerInspection> {
  let bytes: Uint8Array = new Uint8Array()
  try {
    bytes = await inputToBytes(input)
    const limits = resolveLimits(options.limits)
    if (bytes.byteLength > limits.maxFileBytes) throw new IllustratorError('AI_FILE_LIMIT', 'container', `Input exceeds the ${limits.maxFileBytes}-byte file limit.`)
    const source = latin1Decode(bytes)
    if (/^%!PS-Adobe(?:-|\s)/u.test(source)) {
      const illustratorEvidence = isIllustratorDirectSource(source)
      const kind = illustratorEvidence ? 'direct-postscript' : 'unknown'
      const fingerprint = sourceFingerprint(source, kind, undefined, options.mime, /%%Creator\s*:\s*([^\r\n]+)/iu.exec(source)?.[1]?.trim())
      fingerprint.sourceSha256 = await sha256(bytes)
      const diagnostics = illustratorEvidence ? [] : [diagnostic('AI_DIRECT_CREATOR_MISMATCH', 'error', 'container', 'PostScript input was not authored by Adobe Illustrator.')]
      return {
        kind,
        illustratorEvidence,
        pdfSurface: 'absent',
        privateSource: illustratorEvidence ? 'present' : 'missing',
        ...(illustratorEvidence ? { compression: 'none' as const } : {}),
        ...(fingerprint.containerVersion === undefined ? {} : { containerVersion: fingerprint.containerVersion }),
        ...(fingerprint.creatorVersion === undefined ? {} : { creatorVersion: fingerprint.creatorVersion }),
        ...(fingerprint.roundtripVersion === undefined ? {} : { roundtripVersion: fingerprint.roundtripVersion }),
        privateBlocks: 0,
        fingerprint,
        diagnostics,
      }
    }
    if (/^%PDF-/u.test(source.slice(0, 1024)) || source.slice(0, 1024).includes('%PDF-')) {
      const analysis = await analyzePdf(bytes, options, runtimeCodecs(runtime))
      analysis.inspection.fingerprint.sourceSha256 = await sha256(bytes)
      return analysis.inspection
    }
    const fingerprint = emptyFingerprint('unknown', source, options.mime)
    fingerprint.sourceSha256 = await sha256(bytes)
    return {
      kind: 'unknown', illustratorEvidence: false, pdfSurface: 'absent', privateSource: 'missing',
      privateBlocks: 0, fingerprint,
      diagnostics: [diagnostic('AI_CONTAINER_UNKNOWN', 'error', 'container', 'Input is neither Illustrator PostScript nor a valid PDF container.')],
    }
  } catch (error) {
    const source = latin1Decode(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)))
    const isPdf = source.includes('%PDF-')
    const illustratorEvidence = /Adobe\s+Illustrator|\/AI(?:PDF)?PrivateData\d+|xmlns:(?:illustrator|ai)/iu.test(source)
    const kind: IllustratorContainerInspection['kind'] = isPdf && illustratorEvidence ? 'pdf-private' : 'unknown'
    return {
      kind,
      illustratorEvidence,
      pdfSurface: isPdf ? 'unknown' : 'absent',
      privateSource: illustratorEvidence ? 'corrupt' : 'missing',
      privateBlocks: 0,
      fingerprint: emptyFingerprint(kind, source, options.mime),
      diagnostics: [asDiagnostic(error, 'container')],
    }
  }
}

export const inspectIllustrator = inspectIllustratorContainer

export async function decodeIllustratorPrivateSource(
  input: IllustratorInput,
  options: DecodeOptions = {},
  runtime: ContainerRuntimeOptions = {},
): Promise<IllustratorDecodedSource> {
  const bytes = await inputToBytes(input)
  const limits = resolveLimits(options.limits)
  if (bytes.byteLength > limits.maxFileBytes) throw new IllustratorError('AI_FILE_LIMIT', 'container', `Input exceeds the ${limits.maxFileBytes}-byte file limit.`)
  const timeout = Math.min(options.timeoutMs ?? limits.maxWorkerTimeMs, limits.maxWorkerTimeMs)
  const budget = new WorkBudget(options.signal, timeout)
  const raw = latin1Decode(bytes)
  if (/^%!PS-Adobe(?:-|\s)/u.test(raw)) {
    if (!isIllustratorDirectSource(raw)) throw new IllustratorError('AI_DIRECT_CREATOR_MISMATCH', 'container', 'PostScript input was not authored by Adobe Illustrator.')
    if (bytes.byteLength > limits.maxDecodedBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `Illustrator source exceeds ${limits.maxDecodedBytes} bytes.`)
    const diagnostics = validateDecodedSource(bytes, options.strictSourceTermination ?? true)
    const fingerprint = sourceFingerprint(raw, 'direct-postscript', undefined, options.mime, /%%Creator\s*:\s*([^\r\n]+)/iu.exec(raw)?.[1]?.trim())
    fingerprint.sourceSha256 = await sha256(bytes)
    return { bytes, text: raw, compression: 'none', fingerprint, blocks: [], diagnostics }
  }
  const codecs = runtimeCodecs(runtime)
  const analysis = await analyzePdf(bytes, options, codecs)
  if (analysis.inspection.kind === 'unknown') throw new IllustratorError('AI_NOT_ILLUSTRATOR', 'container', 'PDF has no validated Illustrator evidence or private source.')
  if (analysis.descriptor === undefined || analysis.packed === undefined) throw new IllustratorError('AI_PRIVATE_SOURCE_MISSING', 'container', 'Illustrator PDF contains no recoverable native private source.')
  budget.checkpoint('decode')
  const marker = parseCompressionMarker(analysis.packed)
  const payload = analysis.packed.subarray(marker.payloadOffset)
  let decoded: Uint8Array
  if (marker.compression === 'none') decoded = payload
  else if (marker.compression === 'deflate') decoded = await codecs.inflate(payload, limits.maxDecodedBytes, options.signal)
  else {
    if (codecs.zstd === undefined) throw new IllustratorError('AI_ZSTD_UNAVAILABLE', 'decode', 'This Illustrator file uses zstd private-source compression; configure a local zstd decoder/WASM asset.')
    decoded = await codecs.zstd(payload, limits.maxDecodedBytes, options.signal)
  }
  if (decoded.byteLength > limits.maxDecodedBytes) throw new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `Decoded Illustrator source exceeds ${limits.maxDecodedBytes} bytes.`)
  const source = latin1Decode(decoded)
  const validation = validateDecodedSource(decoded, options.strictSourceTermination ?? true)
  const nativeFingerprint = sourceFingerprint(source, 'pdf-private', analysis.pdf.version, options.mime, analysis.inspection.fingerprint.creator)
  const fingerprint: IllustratorVersionFingerprint = {
    ...analysis.inspection.fingerprint,
    ...nativeFingerprint,
    sourceKind: 'pdf-private',
    featureMarkers: [...new Set([...analysis.inspection.fingerprint.featureMarkers, ...nativeFingerprint.featureMarkers])],
    contradictions: [...new Set([...analysis.inspection.fingerprint.contradictions, ...nativeFingerprint.contradictions])],
    sourceSha256: await sha256(decoded),
  }
  const diagnostics = [...analysis.diagnostics, ...validation]
  for (const contradiction of nativeFingerprint.contradictions) diagnostics.push(diagnostic('AI_VERSION_CONTRADICTION', 'warning', 'container', contradiction))
  return { bytes: decoded, text: source, compression: marker.compression, fingerprint, blocks: analysis.blocks, diagnostics }
}
