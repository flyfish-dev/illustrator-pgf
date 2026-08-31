import type { IllustratorDiagnostic, IllustratorToken, IllustratorTokenKind, LexOptions } from './types.js'
import { decodeAscii85 } from './codecs.js'
import { IllustratorError, diagnostic } from './errors.js'
import { resolveLimits } from './limits.js'
import { SourceLocator, WorkBudget, hexToBytes, latin1Decode, latin1Encode } from './util.js'

export interface IllustratorLexResult {
  source: string
  tokens: readonly IllustratorToken[]
  diagnostics: readonly IllustratorDiagnostic[]
}

function sourceText(input: string | Uint8Array): string {
  if (typeof input !== 'string') return latin1Decode(input)
  latin1Encode(input)
  return input
}

function isWhitespace(code: number): boolean { return code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32 }
function isDelimiter(code: number | undefined): boolean {
  return code === undefined || isWhitespace(code) || code === 0x28 || code === 0x29 || code === 0x3c || code === 0x3e || code === 0x5b || code === 0x5d || code === 0x7b || code === 0x7d || code === 0x2f || code === 0x25
}
function decodeName(raw: string): string {
  const bytes: number[] = []
  for (let i = 1; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 0x23 && /^[0-9a-f]{2}$/iu.test(raw.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(raw.slice(i + 1, i + 3), 16)); i += 2
    } else bytes.push(raw.charCodeAt(i) & 0xff)
  }
  return latin1Decode(Uint8Array.from(bytes))
}

function decodePostScriptString(raw: string): string {
  const bytes: number[] = []
  for (let i = 1; i < raw.length - 1; i++) {
    let code = raw.charCodeAt(i)
    if (code !== 0x5c) { bytes.push(code & 0xff); continue }
    if (++i >= raw.length - 1) break
    code = raw.charCodeAt(i)
    if (code === 0x6e) bytes.push(0x0a)
    else if (code === 0x72) bytes.push(0x0d)
    else if (code === 0x74) bytes.push(0x09)
    else if (code === 0x62) bytes.push(0x08)
    else if (code === 0x66) bytes.push(0x0c)
    else if (code === 0x0a) { /* line continuation */ }
    else if (code === 0x0d) { if (raw.charCodeAt(i + 1) === 0x0a) i++ }
    else if (code >= 0x30 && code <= 0x37) {
      let value = code - 0x30
      let count = 1
      while (count < 3 && i + 1 < raw.length - 1) {
        const next = raw.charCodeAt(i + 1)
        if (next < 0x30 || next > 0x37) break
        value = value * 8 + next - 0x30; i++; count++
      }
      bytes.push(value & 0xff)
    } else bytes.push(code & 0xff)
  }
  return latin1Decode(Uint8Array.from(bytes))
}

function classifyWord(raw: string): { kind: IllustratorTokenKind; value?: number | string | boolean | null } {
  if (/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(raw)) return { kind: 'number', value: Number(raw) }
  if (raw === 'true') return { kind: 'boolean', value: true }
  if (raw === 'false') return { kind: 'boolean', value: false }
  if (raw === 'null') return { kind: 'null', value: null }
  return { kind: 'word', value: raw }
}

function findEndDataMarker(source: string, start: number, maximumBytes: number, markerText = '%%EndData'): number {
  const maximum = Math.min(source.length, start + maximumBytes + 1)
  let offset = start
  while (offset < maximum) {
    const marker = source.indexOf(markerText, offset)
    if (marker < 0 || marker >= maximum) return -1
    const next = source.charCodeAt(marker + markerText.length)
    const lineEnd = next === 0x0a || next === 0x0d || Number.isNaN(next)
    if (lineEnd) return marker
    offset = marker + 1
  }
  return -1
}

export function lexIllustratorSource(input: string | Uint8Array, options: LexOptions = {}): IllustratorLexResult {
  const source = sourceText(input)
  const limits = resolveLimits(options.limits)
  if (source.length > limits.maxDecodedBytes) throw new IllustratorError('AI_SOURCE_LIMIT', 'lex', `Illustrator source exceeds ${limits.maxDecodedBytes} bytes.`)
  const budget = new WorkBudget(options.signal, Math.min(options.timeoutMs ?? limits.maxWorkerTimeMs, limits.maxWorkerTimeMs))
  const locator = new SourceLocator(source)
  const tokens: IllustratorToken[] = []
  const diagnostics: IllustratorDiagnostic[] = []
  const push = (kind: IllustratorTokenKind, start: number, end: number, value?: IllustratorToken['value']): void => {
    budget.consume('tokens', 1, limits.maxTokens, 'lex')
    tokens.push({ kind, raw: source.slice(start, end), span: locator.span(start, end), ...(value === undefined ? {} : { value }) })
  }
  let offset = 0
  let pendingBinaryBytes = 0
  while (offset < source.length) {
    budget.checkpoint('lex')
    if (pendingBinaryBytes > 0) {
      const end = Math.min(source.length, offset + pendingBinaryBytes)
      if (end - offset !== pendingBinaryBytes) diagnostics.push(diagnostic('AI_BINARY_TRUNCATED', 'error', 'lex', `Declared binary resource has ${pendingBinaryBytes} bytes, but only ${end - offset} remain.`, { sourceSpan: locator.span(offset, end) }))
      push('binary', offset, end, latin1Encode(source.slice(offset, end)))
      offset = end
      pendingBinaryBytes = 0
      continue
    }
    const code = source.charCodeAt(offset)
    if (isWhitespace(code)) {
      const start = offset++
      while (offset < source.length && isWhitespace(source.charCodeAt(offset))) offset++
      push('whitespace', start, offset)
      continue
    }
    if (code === 0x25) {
      const start = offset++
      while (offset < source.length && source.charCodeAt(offset) !== 0x0a && source.charCodeAt(offset) !== 0x0d) offset++
      const raw = source.slice(start, offset)
      const pseudo = /^%_(?!%)/u.test(raw) || /^%AI\d*_/u.test(raw)
      push(pseudo ? 'pseudo-comment' : 'comment', start, offset, raw.slice(1))
      const beginBinary = /^%%BeginBinary\s*:\s*(\d+)/iu.exec(raw)
      const beginData = /^(%_)?%%BeginData\s*:\s*(\d+)(?:\s+.*)?$/iu.exec(raw)
      const binary = beginBinary ?? beginData
      if (binary !== null) {
        const count = Number(beginData?.[2] ?? binary[1])
        if (!Number.isSafeInteger(count) || count < 0 || count > limits.maxStringBytes) throw new IllustratorError('AI_BINARY_LIMIT', 'lex', `Binary resource declaration exceeds ${limits.maxStringBytes} bytes.`)
        // The required line ending remains a lossless whitespace token before the binary token.
        let lineEnd = offset
        if (source.charCodeAt(lineEnd) === 0x0d) { lineEnd++; if (source.charCodeAt(lineEnd) === 0x0a) lineEnd++ }
        else if (source.charCodeAt(lineEnd) === 0x0a) lineEnd++
        if (lineEnd > offset) { push('whitespace', offset, lineEnd); offset = lineEnd }
        if (beginData !== null) {
          const endMarker = findEndDataMarker(source, offset, limits.maxStringBytes, beginData[1] === '%_' ? '%_%%EndData' : '%%EndData')
          if (endMarker < 0) {
            const end = Math.min(source.length, offset + limits.maxStringBytes)
            diagnostics.push(diagnostic('AI_BINARY_ENDDATA_MISSING', 'error', 'lex', '%%BeginData has no %%EndData terminator within the binary resource limit.', { sourceSpan: locator.span(start, end) }))
            push('binary', offset, end, latin1Encode(source.slice(offset, end)))
            offset = end
          } else {
            push('binary', offset, endMarker, latin1Encode(source.slice(offset, endMarker)))
            offset = endMarker
          }
        } else {
          pendingBinaryBytes = count
        }
      }
      continue
    }
    if (code === 0x28) {
      const start = offset++
      let depth = 1
      while (offset < source.length && depth > 0) {
        const current = source.charCodeAt(offset++)
        if (current === 0x5c) {
          if (offset < source.length) {
            if (source.charCodeAt(offset) === 0x0d && source.charCodeAt(offset + 1) === 0x0a) offset += 2
            else offset++
          }
        } else if (current === 0x28) depth++
        else if (current === 0x29) depth--
        if (offset - start > limits.maxStringBytes) throw new IllustratorError('AI_STRING_LIMIT', 'lex', `PostScript string exceeds ${limits.maxStringBytes} bytes.`)
      }
      if (depth !== 0) diagnostics.push(diagnostic('AI_STRING_UNCLOSED', 'error', 'lex', 'PostScript string is not closed.', { sourceSpan: locator.span(start, offset) }))
      const raw = source.slice(start, offset)
      push('string', start, offset, depth === 0 ? decodePostScriptString(raw) : raw.slice(1))
      continue
    }
    if (code === 0x3c) {
      if (source.charCodeAt(offset + 1) === 0x3c) { push('dict-start', offset, offset + 2); offset += 2; continue }
      if (source.charCodeAt(offset + 1) === 0x7e) {
        const start = offset
        const endMarker = source.indexOf('~>', offset + 2)
        offset = endMarker < 0 ? source.length : endMarker + 2
        if (endMarker < 0) diagnostics.push(diagnostic('AI_ASCII85_UNCLOSED', 'error', 'lex', 'ASCII85 data is not terminated.', { sourceSpan: locator.span(start, offset) }))
        const raw = source.slice(start, offset)
        let value: Uint8Array = new Uint8Array()
        try { value = decodeAscii85(latin1Encode(raw), limits.maxStringBytes) }
        catch (error) { diagnostics.push(diagnostic('AI_ASCII85_INVALID', 'error', 'lex', error instanceof Error ? error.message : String(error), { sourceSpan: locator.span(start, offset) })) }
        push('ascii85', start, offset, value)
        continue
      }
      const start = offset++
      while (offset < source.length && source.charCodeAt(offset) !== 0x3e) {
        if (offset - start > limits.maxStringBytes * 2 + 2) throw new IllustratorError('AI_STRING_LIMIT', 'lex', `Hex string exceeds ${limits.maxStringBytes} decoded bytes.`)
        offset++
      }
      const closed = offset < source.length
      if (closed) offset++
      else diagnostics.push(diagnostic('AI_HEX_UNCLOSED', 'error', 'lex', 'Hex string is not terminated.', { sourceSpan: locator.span(start, offset) }))
      const raw = source.slice(start, offset)
      let value: Uint8Array = new Uint8Array()
      try { value = hexToBytes(raw.slice(1, closed ? -1 : undefined)) }
      catch (error) { diagnostics.push(diagnostic('AI_HEX_INVALID', 'error', 'lex', error instanceof Error ? error.message : String(error), { sourceSpan: locator.span(start, offset) })) }
      push('hex-string', start, offset, value)
      continue
    }
    if (code === 0x3e && source.charCodeAt(offset + 1) === 0x3e) { push('dict-end', offset, offset + 2); offset += 2; continue }
    const delimiterKind: Record<number, IllustratorTokenKind> = { 0x5b: 'array-start', 0x5d: 'array-end', 0x7b: 'procedure-start', 0x7d: 'procedure-end' }
    if (delimiterKind[code] !== undefined) { push(delimiterKind[code]!, offset, offset + 1); offset++; continue }
    if (code === 0x2f) {
      const start = offset++
      while (offset < source.length && !isDelimiter(source.charCodeAt(offset))) offset++
      const raw = source.slice(start, offset)
      push('literal-name', start, offset, decodeName(raw))
      continue
    }
    const start = offset
    while (offset < source.length && !isDelimiter(source.charCodeAt(offset))) offset++
    if (offset === start) { push('unknown', offset, offset + 1, source[offset]); offset++; continue }
    const raw = source.slice(start, offset)
    const classified = classifyWord(raw)
    push(classified.kind, start, offset, classified.value)
  }
  const reconstructed = tokens.map((token) => token.raw).join('')
  if (reconstructed !== source) throw new IllustratorError('AI_LEXER_LOSS', 'lex', 'Internal lexer invariant failed: token raw values do not reconstruct the source exactly.')
  return { source, tokens, diagnostics }
}
