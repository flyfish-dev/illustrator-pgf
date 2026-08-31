import type {
  IllustratorAstDictionaryEntry,
  IllustratorAstOperatorStatement,
  IllustratorAstStatement,
  IllustratorAstValue,
  IllustratorDiagnostic,
  IllustratorLosslessAst,
  IllustratorToken,
  ParseOptions,
  SourceSpan,
} from './types.js'
import { IllustratorError, diagnostic } from './errors.js'
import { lexIllustratorSource } from './lexer.js'
import { resolveLimits } from './limits.js'
import { WorkBudget, latin1Encode } from './util.js'

interface ParsedValue { value: IllustratorAstValue; next: number }

function spanFor(tokens: readonly IllustratorToken[], start: number, endExclusive: number): SourceSpan {
  if (start >= tokens.length) {
    const final = tokens.at(-1)?.span.end ?? { offset: 0, line: 1, column: 1 }
    return { start: final, end: final }
  }
  return { start: tokens[start]!.span.start, end: tokens[Math.max(start, endExclusive - 1)]!.span.end }
}

function isTrivia(token: IllustratorToken | undefined): boolean {
  return token?.kind === 'whitespace' || token?.kind === 'comment' || token?.kind === 'pseudo-comment'
}

class AstParser {
  readonly diagnostics: IllustratorDiagnostic[]
  readonly statements: IllustratorAstStatement[] = []
  private statementCount = 0
  constructor(
    readonly source: string,
    readonly tokens: readonly IllustratorToken[],
    diagnostics: readonly IllustratorDiagnostic[],
    readonly limits: ReturnType<typeof resolveLimits>,
    readonly budget: WorkBudget,
  ) { this.diagnostics = [...diagnostics] }

  parse(): IllustratorLosslessAst {
    let index = 0
    let pending: IllustratorAstValue[] = []
    let pendingStart = -1
    let illustratorGradientData = false
    while (index < this.tokens.length) {
      this.budget.checkpoint('parse')
      const token = this.tokens[index]!
      if (token.kind === 'whitespace') { index++; continue }
      if (token.kind === 'comment' || token.kind === 'pseudo-comment') {
        this.addStatement({ kind: 'comment', pseudo: token.kind === 'pseudo-comment', text: String(token.value ?? token.raw.slice(1)), span: token.span, tokenRange: [index, index + 1], raw: token.raw })
        index++
        continue
      }
      if (token.kind === 'binary') {
        if (pending.length > 0) this.flushTrailing(pending, pendingStart, index)
        const value = token.value instanceof Uint8Array ? token.value : latin1Encode(token.raw)
        this.addStatement({ kind: 'resource', resourceKind: 'binary', value, span: token.span, tokenRange: [index, index + 1], raw: token.raw })
        pending = []; pendingStart = -1; index++
        continue
      }
      if (token.kind === 'word') {
        const operator = String(token.value ?? token.raw)
        const start = pendingStart >= 0 ? pendingStart : index
        const statement: IllustratorAstOperatorStatement = {
          kind: 'operator', operator, operands: pending, span: spanFor(this.tokens, start, index + 1), tokenRange: [start, index + 1], raw: this.raw(start, index + 1),
        }
        this.addStatement(statement)
        if (operator === 'Bd') illustratorGradientData = true
        else if (operator === 'BD') illustratorGradientData = false
        pending = []; pendingStart = -1; index++
        continue
      }
      // Illustrator gradient resources use PostScript's executable `[` mark
      // without a matching `]`; the terminating BD operator consumes all marks.
      // Outside a Bd/BD resource block, `[` keeps its ordinary array meaning.
      if (token.kind === 'array-start' && illustratorGradientData) {
        if (pendingStart < 0) pendingStart = index
        pending.push({ kind: 'name', value: '[', literal: false, span: token.span, tokenIndex: index })
        index++
        continue
      }
      const parsed = this.parseValue(index, 0)
      if (pendingStart < 0) pendingStart = index
      pending.push(parsed.value)
      index = parsed.next
    }
    if (pending.length > 0) this.flushTrailing(pending, pendingStart, this.tokens.length)
    const ast: IllustratorLosslessAst = {
      format: 'adobe-illustrator.lossless-ast', schemaVersion: 1, encoding: 'latin1', sourceByteLength: this.source.length,
      tokens: this.tokens, statements: this.statements, diagnostics: this.diagnostics,
    }
    if (reconstructIllustratorSourceText(ast) !== this.source) throw new IllustratorError('AI_AST_LOSS', 'parse', 'Internal AST invariant failed: tokens do not reconstruct the original source.')
    return ast
  }

  private addStatement(statement: IllustratorAstStatement): void {
    this.statementCount++
    if (this.statementCount > this.limits.maxStatements) throw new IllustratorError('AI_STATEMENT_LIMIT', 'parse', `Illustrator source exceeds ${this.limits.maxStatements} statements.`)
    this.statements.push(statement)
  }

  private flushTrailing(values: IllustratorAstValue[], start: number, end: number): void {
    this.addStatement({ kind: 'trailing-values', values: [...values], span: spanFor(this.tokens, start, end), tokenRange: [start, end], raw: this.raw(start, end) })
    this.diagnostics.push(diagnostic('AI_TRAILING_OPERANDS', 'warning', 'parse', `Preserved ${values.length} operand(s) without a following operator.`, { sourceSpan: spanFor(this.tokens, start, end) }))
  }

  private raw(start: number, end: number): string { return this.tokens.slice(start, end).map((token) => token.raw).join('') }

  private skipTrivia(index: number): number { while (index < this.tokens.length && isTrivia(this.tokens[index])) index++; return index }

  private parseValue(index: number, depth: number): ParsedValue {
    if (depth > this.limits.maxNesting) throw new IllustratorError('AI_AST_NESTING_LIMIT', 'parse', `AST nesting exceeds ${this.limits.maxNesting}.`)
    index = this.skipTrivia(index)
    const token = this.tokens[index]
    if (token === undefined) {
      const span = spanFor(this.tokens, this.tokens.length, this.tokens.length)
      return { value: { kind: 'unknown', raw: '', span, tokenIndex: this.tokens.length }, next: this.tokens.length }
    }
    const primitive = (): IllustratorAstValue | undefined => {
      switch (token.kind) {
        case 'number': return { kind: 'number', value: Number(token.value), span: token.span, tokenIndex: index }
        case 'boolean': return { kind: 'boolean', value: Boolean(token.value), span: token.span, tokenIndex: index }
        case 'null': return { kind: 'null', value: null, span: token.span, tokenIndex: index }
        case 'literal-name': return { kind: 'name', value: String(token.value ?? token.raw.slice(1)), literal: true, span: token.span, tokenIndex: index }
        case 'word': return { kind: 'name', value: String(token.value ?? token.raw), literal: false, span: token.span, tokenIndex: index }
        case 'string': {
          const value = String(token.value ?? '')
          return { kind: 'string', value, rawBytes: latin1Encode(value), span: token.span, tokenIndex: index }
        }
        case 'hex-string': case 'ascii85': case 'binary': return { kind: token.kind, value: token.value instanceof Uint8Array ? token.value : latin1Encode(token.raw), span: token.span, tokenIndex: index }
        case 'unknown': return { kind: 'unknown', raw: token.raw, span: token.span, tokenIndex: index }
        default: return undefined
      }
    }
    const value = primitive()
    if (value !== undefined) return { value, next: index + 1 }
    if (token.kind === 'array-start' || token.kind === 'procedure-start') {
      const closing = token.kind === 'array-start' ? 'array-end' : 'procedure-end'
      const values: IllustratorAstValue[] = []
      let cursor = index + 1
      while (true) {
        cursor = this.skipTrivia(cursor)
        if (cursor >= this.tokens.length) {
          const span = spanFor(this.tokens, index, this.tokens.length)
          this.diagnostics.push(diagnostic('AI_COMPOSITE_UNCLOSED', 'error', 'parse', `${token.kind === 'array-start' ? 'Array' : 'Procedure'} is not closed.`, { sourceSpan: span }))
          return { value: { kind: token.kind === 'array-start' ? 'array' : 'procedure', values, span, tokenRange: [index, this.tokens.length] }, next: this.tokens.length }
        }
        if (this.tokens[cursor]!.kind === closing) {
          const end = cursor + 1
          return { value: { kind: token.kind === 'array-start' ? 'array' : 'procedure', values, span: spanFor(this.tokens, index, end), tokenRange: [index, end] }, next: end }
        }
        if (['array-end', 'procedure-end', 'dict-end'].includes(this.tokens[cursor]!.kind)) {
          this.diagnostics.push(diagnostic('AI_COMPOSITE_MISMATCH', 'error', 'parse', `Unexpected ${this.tokens[cursor]!.kind} while parsing ${token.kind}.`, { sourceSpan: this.tokens[cursor]!.span }))
          values.push({ kind: 'unknown', raw: this.tokens[cursor]!.raw, span: this.tokens[cursor]!.span, tokenIndex: cursor }); cursor++
          continue
        }
        const child = this.parseValue(cursor, depth + 1)
        values.push(child.value); cursor = child.next
      }
    }
    if (token.kind === 'dict-start') {
      const values: IllustratorAstValue[] = []
      let cursor = index + 1
      while (true) {
        cursor = this.skipTrivia(cursor)
        if (cursor >= this.tokens.length) {
          const span = spanFor(this.tokens, index, this.tokens.length)
          this.diagnostics.push(diagnostic('AI_DICTIONARY_UNCLOSED', 'error', 'parse', 'Dictionary is not closed.', { sourceSpan: span }))
          return { value: this.dictionaryValue(values, index, this.tokens.length, span), next: this.tokens.length }
        }
        if (this.tokens[cursor]!.kind === 'dict-end') {
          const end = cursor + 1
          return { value: this.dictionaryValue(values, index, end, spanFor(this.tokens, index, end)), next: end }
        }
        const child = this.parseValue(cursor, depth + 1)
        values.push(child.value); cursor = child.next
      }
    }
    this.diagnostics.push(diagnostic('AI_DELIMITER_UNEXPECTED', 'error', 'parse', `Unexpected ${token.kind} was preserved as unknown.`, { sourceSpan: token.span }))
    return { value: { kind: 'unknown', raw: token.raw, span: token.span, tokenIndex: index }, next: index + 1 }
  }

  private dictionaryValue(values: IllustratorAstValue[], start: number, end: number, span: SourceSpan): IllustratorAstValue {
    const entries: IllustratorAstDictionaryEntry[] = []
    for (let i = 0; i < values.length; i += 2) {
      const key = values[i]!
      const value = values[i + 1]
      if (value === undefined) {
        this.diagnostics.push(diagnostic('AI_DICTIONARY_ODD_VALUES', 'error', 'parse', 'Dictionary has a key without a value; the missing value is represented as unknown.', { sourceSpan: key.span }))
        entries.push({ key, value: { kind: 'unknown', raw: '', span: key.span, tokenIndex: end - 1 } })
      } else entries.push({ key, value })
    }
    return { kind: 'dictionary', entries, span, tokenRange: [start, end] }
  }
}

export function parseIllustratorSource(input: string | Uint8Array, options: ParseOptions = {}): IllustratorLosslessAst {
  const lexed = lexIllustratorSource(input, options)
  const limits = resolveLimits(options.limits)
  const budget = new WorkBudget(options.signal, Math.min(options.timeoutMs ?? limits.maxWorkerTimeMs, limits.maxWorkerTimeMs))
  return new AstParser(lexed.source, lexed.tokens, lexed.diagnostics, limits, budget).parse()
}

export function reconstructIllustratorSourceText(ast: IllustratorLosslessAst): string { return ast.tokens.map((token) => token.raw).join('') }
export function reconstructIllustratorSource(ast: IllustratorLosslessAst): Uint8Array {
  const text = reconstructIllustratorSourceText(ast)
  const bytes = latin1Encode(text)
  if (bytes.byteLength !== ast.sourceByteLength) throw new IllustratorError('AI_AST_LENGTH_MISMATCH', 'parse', `Reconstructed source has ${bytes.byteLength} bytes, expected ${ast.sourceByteLength}.`)
  return bytes
}
