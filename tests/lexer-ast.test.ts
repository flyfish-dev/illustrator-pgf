import test from 'node:test'
import assert from 'node:assert/strict'
import { lexIllustratorSource } from '../src/lexer.js'
import { parseIllustratorSource, reconstructIllustratorSource, reconstructIllustratorSourceText } from '../src/ast.js'
import { bytesEqual, latin1Encode } from '../src/util.js'

test('lexer preserves CR, LF and CRLF byte-for-byte', () => {
  const source = '%!PS\r%%A\n%%B\r\n1 2 m\r\n'
  const result = lexIllustratorSource(source)
  assert.equal(result.tokens.map((token) => token.raw).join(''), source)
  assert.ok(result.tokens.some((token) => token.kind === 'whitespace' && token.raw === '\r\n'))
})

test('lexer decodes nested and escaped PostScript strings without losing raw source', () => {
  const source = '(outer \\(escaped\\) (inner) \\101\\n) Tj\n'
  const result = lexIllustratorSource(source)
  const token = result.tokens.find((candidate) => candidate.kind === 'string')
  assert.equal(token?.value, 'outer (escaped) (inner) A\n')
  assert.equal(result.tokens.map((candidate) => candidate.raw).join(''), source)
})

test('lexer supports escaped literal names, hex and ASCII85', () => {
  const source = '/A#20B <48656c6c6f> <~87cURD]j7BEbo80~> op\n'
  const result = lexIllustratorSource(source)
  assert.equal(result.tokens.find((token) => token.kind === 'literal-name')?.value, 'A B')
  assert.equal(new TextDecoder().decode(result.tokens.find((token) => token.kind === 'hex-string')?.value as Uint8Array), 'Hello')
  assert.ok((result.tokens.find((token) => token.kind === 'ascii85')?.value as Uint8Array).byteLength > 0)
})

test('lexer preserves declared binary sections', () => {
  const bytes = latin1Encode('%%BeginBinary: 4\r\n')
  const input = new Uint8Array(bytes.length + 5)
  input.set(bytes); input.set([0, 255, 1, 2, 10], bytes.length)
  const result = lexIllustratorSource(input)
  const binary = result.tokens.find((token) => token.kind === 'binary')
  assert.deepEqual([...(binary?.value as Uint8Array)], [0, 255, 1, 2])
  assert.ok(bytesEqual(latin1Encode(result.tokens.map((token) => token.raw).join('')), input))
})

test('Illustrator BeginData preserves encoded bytes through an EndData marker adjacent to binary data', () => {
  const header = latin1Encode('%%BeginData: 4\r')
  const payload = Uint8Array.from([0x58, 0x49, 0x0a, 0x3c, 0xff, 0x7d])
  const footer = latin1Encode('%%EndData\r%%EOF\r')
  const input = new Uint8Array(header.length + payload.length + footer.length)
  input.set(header)
  input.set(payload, header.length)
  input.set(footer, header.length + payload.length)
  const result = lexIllustratorSource(input)
  const binary = result.tokens.find((token) => token.kind === 'binary')
  assert.deepEqual([...(binary?.value as Uint8Array)], [...payload])
  assert.equal(result.diagnostics.length, 0)
  assert.ok(bytesEqual(latin1Encode(result.tokens.map((token) => token.raw).join('')), input))
})

test('Illustrator pseudo-commented BeginData preserves its opaque payload', () => {
  const source = '%_%%BeginData: 4\r\x00\xff[]%_%%EndData\r0 0 m\r'
  const result = lexIllustratorSource(latin1Encode(source))
  const binary = result.tokens.find((token) => token.kind === 'binary')
  assert.deepEqual([...(binary?.value as Uint8Array)], [0x00, 0xff, 0x5b, 0x5d])
  assert.ok(bytesEqual(latin1Encode(result.tokens.map((token) => token.raw).join('')), latin1Encode(source)))
})

test('lossless AST reconstructs source exactly and classifies unknown operators', () => {
  const source = '% comment\n[1 2 (x)] << /K true >> mystery\n'
  const ast = parseIllustratorSource(source)
  assert.equal(reconstructIllustratorSourceText(ast), source)
  assert.ok(bytesEqual(reconstructIllustratorSource(ast), latin1Encode(source)))
  assert.equal(ast.statements.find((statement) => statement.kind === 'operator')?.operator, 'mystery')
})

test('AST preserves trailing operands rather than dropping them', () => {
  const ast = parseIllustratorSource('1 2 (orphan)')
  assert.equal(ast.statements.at(-1)?.kind, 'trailing-values')
  assert.ok(ast.diagnostics.some((diagnostic) => diagnostic.code === 'AI_TRAILING_OPERANDS'))
})

test('Illustrator gradient data marks do not swallow the remaining document', () => {
  const source = '(Gradient) 0 2 Bd\r[\r<0001>\r4 %_Br\r[\r0 1 %_BS\rBD\r0 0 m\r'
  const ast = parseIllustratorSource(source)
  const operators = ast.statements
    .filter((statement) => statement.kind === 'operator')
    .map((statement) => statement.operator)
  assert.deepEqual(operators, ['Bd', 'BD', 'm'])
  assert.equal(ast.diagnostics.some((entry) => entry.code === 'AI_COMPOSITE_UNCLOSED'), false)
})

test('unclosed composites are preserved with deterministic diagnostics', () => {
  const ast = parseIllustratorSource('[1 2')
  assert.ok(ast.diagnostics.some((diagnostic) => diagnostic.code === 'AI_COMPOSITE_UNCLOSED'))
  assert.equal(reconstructIllustratorSourceText(ast), '[1 2')
})

test('token and nesting budgets stop hostile source deterministically', () => {
  assert.throws(() => lexIllustratorSource('1 2 3 4', { limits: { maxTokens: 3 } }), /maxTokens|tokens|exceeds/iu)
  assert.throws(() => parseIllustratorSource('[[[[1]]]] op', { limits: { maxNesting: 2 } }), /nesting/u)
})
