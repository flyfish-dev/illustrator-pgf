import { latin1SourceText, nativeFNV1a } from './native-common.js'

export interface NativeSecurityLimits {
  maximumSourceBytes: number
  maximumStatements: number
  maximumNesting: number
  maximumDeclaredBinaryBytes: number
  maximumExternalReferences: number
}

export const DEFAULT_NATIVE_SECURITY_LIMITS: NativeSecurityLimits = {
  maximumSourceBytes: 64 * 1024 * 1024,
  maximumStatements: 250_000,
  maximumNesting: 512,
  maximumDeclaredBinaryBytes: 64 * 1024 * 1024,
  maximumExternalReferences: 1_000,
}

export interface NativeSecurityReport {
  safeToParse: boolean
  sourceBytes: number
  estimatedStatements: number
  maximumObservedNesting: number
  declaredBinaryBytes: number
  activeContentIndicators: readonly string[]
  externalReferences: readonly string[]
  diagnostics: readonly string[]
}

const ACTIVE_POSTSCRIPT_OPERATORS: readonly [string, RegExp][] = [
  ['PostScript file operator', /(^|[\s{}[\]()])file(?=$|[\s{}[\]()])/mu],
  ['PostScript run operator', /(^|[\s{}[\]()])run(?=$|[\s{}[\]()])/mu],
  ['PostScript deletefile operator', /(^|[\s{}[\]()])deletefile(?=$|[\s{}[\]()])/mu],
  ['PostScript renamefile operator', /(^|[\s{}[\]()])renamefile(?=$|[\s{}[\]()])/mu],
  ['PostScript status operator', /(^|[\s{}[\]()])status(?=$|[\s{}[\]()])/mu],
  ['PostScript pipe path', /%pipe%/iu],
  ['PostScript shell path', /(?:^|[\s(])(?:sh|cmd|powershell)(?:[\s)])/iu],
]

function estimateStatements(source: string): number {
  let statements = 0
  let hasContent = false
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index)
    if (code === 0x0d) {
      if (source.charCodeAt(index + 1) === 0x0a) index++
      statements++
      hasContent = false
    } else if (code === 0x0a) {
      statements++
      hasContent = false
    } else {
      hasContent = true
    }
  }
  return statements + (hasContent ? 1 : 0)
}

function maximumNesting(source: string): number {
  let current = 0
  let maximum = 0
  let inString = false
  let escaped = false
  let inComment = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (inComment) {
      if (character === '\r' || character === '\n') inComment = false
      continue
    }
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') escaped = true
      else if (character === ')') inString = false
      continue
    }
    if (character === '%') {
      inComment = true
      continue
    }
    if (character === '(') {
      inString = true
      continue
    }
    if (
      character === '['
      || character === '{'
      || source.startsWith('<<', index)
    ) {
      current++
      maximum = Math.max(maximum, current)
      if (source.startsWith('<<', index)) index++
    } else if (
      character === ']'
      || character === '}'
      || source.startsWith('>>', index)
    ) {
      current = Math.max(0, current - 1)
      if (source.startsWith('>>', index)) index++
    }
  }
  return maximum
}

function declaredBinaryBytes(source: string): number {
  let total = 0
  for (const match of source.matchAll(
    /^%%Begin(?:Binary|Data)\s*:\s*(\d+)/gimu,
  )) {
    const value = Number(match[1])
    if (Number.isSafeInteger(value) && value >= 0) total += value
  }
  return total
}

export function scanNativeSourceSecurity(
  source: string | Uint8Array,
  limits: Readonly<Partial<NativeSecurityLimits>> = {},
): NativeSecurityReport {
  const resolved = { ...DEFAULT_NATIVE_SECURITY_LIMITS, ...limits }
  const sourceBytes = typeof source === 'string'
    ? source.length
    : source.byteLength
  const text = latin1SourceText(
    source,
    Math.min(sourceBytes, resolved.maximumSourceBytes + 1),
  )
  const estimated = estimateStatements(text)
  const nesting = maximumNesting(text)
  const binary = declaredBinaryBytes(text)
  const activeContentIndicators = ACTIVE_POSTSCRIPT_OPERATORS
    .filter(([, expression]) => expression.test(text))
    .map(([name]) => name)
  const externalReferences = [...text.matchAll(
    /(?:https?|file):\/\/[^\s()<>{}\[\]]+/giu,
  )].map((match) => match[0])
  const diagnostics: string[] = []
  if (sourceBytes > resolved.maximumSourceBytes) {
    diagnostics.push(
      `Source exceeds the ${resolved.maximumSourceBytes}-byte security limit.`,
    )
  }
  if (estimated > resolved.maximumStatements) {
    diagnostics.push(
      `Source exceeds the ${resolved.maximumStatements}-statement security limit.`,
    )
  }
  if (nesting > resolved.maximumNesting) {
    diagnostics.push(
      `Source exceeds the ${resolved.maximumNesting}-level nesting security limit.`,
    )
  }
  if (binary > resolved.maximumDeclaredBinaryBytes) {
    diagnostics.push(
      `Declared binary resources exceed the ${resolved.maximumDeclaredBinaryBytes}-byte security limit.`,
    )
  }
  if (externalReferences.length > resolved.maximumExternalReferences) {
    diagnostics.push(
      `Source exceeds the ${resolved.maximumExternalReferences}-reference external resource limit.`,
    )
  }
  if (activeContentIndicators.length > 0) {
    diagnostics.push(
      'Active PostScript operators are retained only as data and must never be executed.',
    )
  }
  if (externalReferences.length > 0) {
    diagnostics.push(
      'External references require an explicit resolver policy; implicit network access is forbidden.',
    )
  }
  return {
    safeToParse: diagnostics.every((message) =>
      !/exceeds the .*security limit/iu.test(message),
    ),
    sourceBytes,
    estimatedStatements: estimated,
    maximumObservedNesting: nesting,
    declaredBinaryBytes: binary,
    activeContentIndicators,
    externalReferences,
    diagnostics,
  }
}

export interface NativeMutationCase {
  id: string
  description: string
  bytes: Uint8Array
}

function sourceBytes(source: string | Uint8Array): Uint8Array {
  if (source instanceof Uint8Array) return source.slice()
  const result = new Uint8Array(source.length)
  for (let index = 0; index < source.length; index++) {
    result[index] = source.charCodeAt(index) & 0xff
  }
  return result
}

function concat(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength)
  result.set(left)
  result.set(right, left.byteLength)
  return result
}

export function createDeterministicNativeMutations(
  source: string | Uint8Array,
  maximumCases = 64,
): readonly NativeMutationCase[] {
  if (!Number.isSafeInteger(maximumCases) || maximumCases < 0) {
    throw new RangeError('maximumCases must be a non-negative safe integer.')
  }
  const input = sourceBytes(source)
  const cases: NativeMutationCase[] = []
  const push = (description: string, bytes: Uint8Array): void => {
    if (cases.length >= maximumCases) return
    cases.push({
      id: `mutation:${cases.length}:${nativeFNV1a(description)}`,
      description,
      bytes,
    })
  }
  push('empty input', new Uint8Array())
  push('one-byte truncation', input.subarray(0, Math.max(0, input.length - 1)))
  push('half truncation', input.subarray(0, Math.floor(input.length / 2)))
  push(
    'unterminated string prefix',
    concat(input, Uint8Array.of(0x0a, 0x28, 0x78)),
  )
  push(
    'unterminated array prefix',
    concat(input, Uint8Array.of(0x0a, 0x5b, 0x31)),
  )
  push(
    'oversized BeginData declaration',
    concat(input, sourceBytes('\n%%BeginData: 999999999 Binary\n')),
  )
  push(
    'active file operator',
    concat(input, sourceBytes('\n(secret) (r) file\n')),
  )
  push(
    'external URL reference',
    concat(input, sourceBytes('\n(https://example.invalid/resource)\n')),
  )
  const stride = Math.max(1, Math.floor(input.length / Math.max(1, maximumCases - cases.length)))
  for (let offset = 0; offset < input.length && cases.length < maximumCases; offset += stride) {
    const mutated = input.slice()
    mutated[offset] = (mutated[offset] ?? 0) ^ 0xff
    push(`bitwise byte mutation at ${offset}`, mutated)
  }
  return cases
}

export interface NativeMutationCampaignResult {
  total: number
  completed: number
  failures: readonly Readonly<{
    id: string
    message: string
  }>[]
}

export async function runNativeMutationCampaign(
  mutations: readonly NativeMutationCase[],
  exercise: (bytes: Uint8Array) => unknown | Promise<unknown>,
  options: Readonly<{
    signal?: AbortSignal
    timeoutMs?: number
  }> = {},
): Promise<NativeMutationCampaignResult> {
  const failures: { id: string; message: string }[] = []
  let completed = 0
  for (const mutation of mutations) {
    if (options.signal?.aborted === true) {
      throw new DOMException('Mutation campaign aborted.', 'AbortError')
    }
    try {
      if (options.timeoutMs === undefined) {
        await exercise(mutation.bytes)
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.resolve(exercise(mutation.bytes)),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new DOMException(
                  `Mutation ${mutation.id} timed out.`,
                  'TimeoutError',
                ))
              }, options.timeoutMs)
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/timeout/iu.test(message)) failures.push({ id: mutation.id, message })
    }
    completed++
  }
  return {
    total: mutations.length,
    completed,
    failures,
  }
}
