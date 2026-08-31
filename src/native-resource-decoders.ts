import {
  asNativeRecord,
  latin1SourceText,
  nativeAstStatements,
  nativeFNV1a,
  nativeNumber,
  nativeString,
  stableNativeSerialize,
} from './native-common.js'
import type { NativeFidelity } from './native-fidelity.js'
import type { NativeResourceGraph } from './native-resources.js'

export interface NativeGradientStop {
  offset: number
  midpoint?: number
  color: Readonly<{
    space: 'gray' | 'rgb' | 'cmyk' | 'spot' | 'unknown'
    components: readonly number[]
    name?: string
    tint?: number
  }>
}

export interface NativeGradientDefinition {
  id: string
  name: string
  gradientType: 'linear' | 'radial' | 'freeform' | 'unknown'
  matrix?: readonly number[]
  stops: readonly NativeGradientStop[]
  raw: string
  fidelity: NativeFidelity
}

export interface NativePatternDefinition {
  id: string
  name: string
  paintType?: number
  tilingType?: number
  bounds?: readonly number[]
  matrix?: readonly number[]
  raw: string
  fidelity: NativeFidelity
}

export interface NativeRasterDefinition {
  id: string
  width?: number
  height?: number
  bitsPerComponent?: number
  colorSpace?: string
  format: 'png' | 'jpeg' | 'tiff' | 'gif' | 'raw' | 'unknown'
  embeddedBytes?: Uint8Array
  externalReference?: string
  raw: string
  fidelity: NativeFidelity
}

export interface NativeColorResource {
  id: string
  kind: 'process' | 'spot' | 'icc-profile'
  name: string
  components?: readonly number[]
  alternate?: readonly number[]
  profileName?: string
  fidelity: NativeFidelity
}

export interface NativeDecodedResources {
  gradients: readonly NativeGradientDefinition[]
  patterns: readonly NativePatternDefinition[]
  rasters: readonly NativeRasterDefinition[]
  colors: readonly NativeColorResource[]
  diagnostics: readonly string[]
}

function statementOperator(statement: unknown): string | undefined {
  const record = asNativeRecord(statement)
  return typeof record?.operator === 'string' ? record.operator : undefined
}

function statementOperands(statement: unknown): readonly unknown[] {
  const record = asNativeRecord(statement)
  return Array.isArray(record?.operands) ? record.operands : []
}

function statementRaw(statement: unknown): string {
  const record = asNativeRecord(statement)
  return typeof record?.raw === 'string' ? record.raw : ''
}

function numericOperands(statement: unknown): number[] {
  return statementOperands(statement)
    .map(nativeNumber)
    .filter((value): value is number => value !== undefined)
}

function firstStringOperand(statement: unknown): string | undefined {
  return statementOperands(statement)
    .map(nativeString)
    .find((value) => value !== undefined)
}

function bytesFromValue(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  const record = asNativeRecord(value)
  if (record === undefined) return undefined
  if (record.value instanceof Uint8Array) return record.value
  if (record.bytes instanceof Uint8Array) return record.bytes
  if (Array.isArray(record.values)) {
    const chunks = record.values
      .map(bytesFromValue)
      .filter((entry): entry is Uint8Array => entry !== undefined)
    if (chunks.length === 0) return undefined
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
  return undefined
}

function statementBytes(statement: unknown): Uint8Array | undefined {
  const chunks = statementOperands(statement)
    .map(bytesFromValue)
    .filter((value): value is Uint8Array => value !== undefined)
  if (chunks.length === 0) return undefined
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function detectRasterFormat(bytes: Uint8Array | undefined): NativeRasterDefinition['format'] {
  if (bytes === undefined || bytes.byteLength === 0) return 'unknown'
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
  ) return 'png'
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'jpeg'
  }
  if (
    bytes.byteLength >= 4
    && (
      bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00
      || bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a
    )
  ) return 'tiff'
  if (
    bytes.byteLength >= 6
    && String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF89a'
  ) return 'gif'
  return 'raw'
}

function gradientStops(raw: string): NativeGradientStop[] {
  const result: NativeGradientStop[] = []
  for (const match of raw.matchAll(
    /([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+%_?BS\b/gu,
  )) {
    const first = Number(match[1])
    const second = Number(match[2])
    result.push({
      offset: Math.max(0, Math.min(1, first)),
      midpoint: Math.max(0, Math.min(1, second)),
      color: { space: 'unknown', components: [] },
    })
  }
  if (result.length === 0) {
    for (const match of raw.matchAll(
      /(?:\[|\s)([+-]?(?:\d+\.?\d*|\.\d+))\s+(?:\[|\s)([+-]?(?:\d+\.?\d*|\.\d+))\s+(?:\[|\s)([+-]?(?:\d+\.?\d*|\.\d+))\s+(?:\[|\s)([+-]?(?:\d+\.?\d*|\.\d+))\s+([+-]?(?:\d+\.?\d*|\.\d+))\s+%_?(?:Bs|BS)\b/gu,
    )) {
      result.push({
        offset: Math.max(0, Math.min(1, Number(match[5]))),
        color: {
          space: 'cmyk',
          components: [
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
            Number(match[4]),
          ],
        },
      })
    }
  }
  return result.sort((left, right) => left.offset - right.offset)
}

function resourceIdFor(
  kind: string,
  statementIndex: number,
  raw: string,
): string {
  return `${kind}:${nativeFNV1a(`${statementIndex}:${raw}`)}`
}

function decodeGradients(statements: readonly unknown[]): NativeGradientDefinition[] {
  const result: NativeGradientDefinition[] = []
  let start = -1
  let name = ''
  let beginNumbers: number[] = []
  for (let index = 0; index < statements.length; index++) {
    const operator = statementOperator(statements[index])
    if (operator === 'Bd' || operator === 'Bg') {
      start = index
      name = firstStringOperand(statements[index]) ?? `Gradient ${result.length + 1}`
      beginNumbers = numericOperands(statements[index])
      continue
    }
    if ((operator === 'BD' || operator === 'BB') && start >= 0) {
      const block = statements.slice(start, index + 1)
      const raw = block.map(statementRaw).join('')
      const typeCode = beginNumbers.at(-1)
      const gradientType = typeCode === 1
        ? 'radial'
        : typeCode === 0
          ? 'linear'
          : 'unknown'
      const matrix = beginNumbers.length >= 6
        ? beginNumbers.slice(0, 6)
        : undefined
      const stops = gradientStops(raw)
      result.push({
        id: resourceIdFor('gradient', start, raw),
        name,
        gradientType,
        ...(matrix === undefined ? {} : { matrix }),
        stops,
        raw,
        fidelity: stops.length >= 2 ? 'partial' : 'structure-only',
      })
      start = -1
      name = ''
      beginNumbers = []
    }
  }
  return result
}

function decodePatterns(statements: readonly unknown[]): NativePatternDefinition[] {
  const result: NativePatternDefinition[] = []
  let start = -1
  let name = ''
  let numbers: number[] = []
  for (let index = 0; index < statements.length; index++) {
    const operator = statementOperator(statements[index])
    if (operator === 'PB' || operator === 'AI9_BeginPattern') {
      start = index
      name = firstStringOperand(statements[index]) ?? `Pattern ${result.length + 1}`
      numbers = numericOperands(statements[index])
      continue
    }
    if ((operator === 'PE' || operator === 'AI9_EndPattern') && start >= 0) {
      const raw = statements.slice(start, index + 1).map(statementRaw).join('')
      result.push({
        id: resourceIdFor('pattern', start, raw),
        name,
        ...(numbers[0] === undefined ? {} : { paintType: numbers[0] }),
        ...(numbers[1] === undefined ? {} : { tilingType: numbers[1] }),
        ...(numbers.length < 6 ? {} : { bounds: numbers.slice(2, 6) }),
        ...(numbers.length < 12 ? {} : { matrix: numbers.slice(6, 12) }),
        raw,
        fidelity: 'structure-only',
      })
      start = -1
      name = ''
      numbers = []
    }
  }
  return result
}

function decodeRasters(statements: readonly unknown[]): NativeRasterDefinition[] {
  const result: NativeRasterDefinition[] = []
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index]
    const operator = statementOperator(statement)
    if (operator !== 'XI' && operator !== 'XG' && operator !== 'Xh' && operator !== 'BI') {
      continue
    }
    const numbers = numericOperands(statement)
    const strings = statementOperands(statement)
      .map(nativeString)
      .filter((value): value is string => value !== undefined)
    const bytes = statementBytes(statement)
    const raw = statementRaw(statement)
    const externalReference = strings.find((value) =>
      /^(?:https?|file):\/\//iu.test(value) || /[\\/]/u.test(value),
    )
    const embedded = bytes !== undefined && bytes.byteLength > 0
    result.push({
      id: resourceIdFor('raster', index, raw || stableNativeSerialize(statement)),
      ...(numbers[0] === undefined ? {} : { width: Math.max(0, numbers[0]) }),
      ...(numbers[1] === undefined ? {} : { height: Math.max(0, numbers[1]) }),
      ...(numbers[2] === undefined ? {} : { bitsPerComponent: numbers[2] }),
      ...(strings[0] === undefined ? {} : { colorSpace: strings[0] }),
      format: detectRasterFormat(bytes),
      ...(bytes === undefined ? {} : { embeddedBytes: bytes }),
      ...(externalReference === undefined ? {} : { externalReference }),
      raw,
      fidelity: embedded ? 'partial' : 'structure-only',
    })
  }
  return result
}

function decodeColors(
  source: string | Uint8Array,
  statements: readonly unknown[],
): NativeColorResource[] {
  const result: NativeColorResource[] = []
  const text = latin1SourceText(source, 16 * 1024 * 1024)
  for (const match of text.matchAll(
    /^%%DocumentCustomColors:\s*\(([^)]*)\)/gmu,
  )) {
    const name = match[1]?.trim()
    if (name === undefined || name === '') continue
    result.push({
      id: `spot:${nativeFNV1a(name)}`,
      kind: 'spot',
      name,
      fidelity: 'partial',
    })
  }
  for (const match of text.matchAll(
    /^%AI\d*_(?:ProfileName|ICCProfile):\s*(.+)$/gmu,
  )) {
    const profileName = match[1]?.trim()
    if (profileName === undefined || profileName === '') continue
    result.push({
      id: `icc:${nativeFNV1a(profileName)}`,
      kind: 'icc-profile',
      name: profileName,
      profileName,
      fidelity: 'structure-only',
    })
  }
  for (let index = 0; index < statements.length; index++) {
    const operator = statementOperator(statements[index])
    if (!['k', 'K', 'rg', 'RG', 'g', 'G', 'x', 'X', 'Xk', 'XK'].includes(operator ?? '')) {
      continue
    }
    const components = numericOperands(statements[index])
    const name = firstStringOperand(statements[index]) ?? operator ?? 'process'
    result.push({
      id: `color:${nativeFNV1a(`${index}:${statementRaw(statements[index])}`)}`,
      kind: operator === 'x' || operator === 'X' || operator === 'Xk' || operator === 'XK'
        ? 'spot'
        : 'process',
      name,
      components,
      fidelity: operator === 'x' || operator === 'X' || operator === 'Xk' || operator === 'XK'
        ? 'partial'
        : 'high',
    })
  }
  return result
}

export function decodeNativeResources(
  source: string | Uint8Array,
  ast: unknown,
  graph?: NativeResourceGraph,
): NativeDecodedResources {
  const statements = nativeAstStatements(ast)
  const gradients = decodeGradients(statements)
  const patterns = decodePatterns(statements)
  const rasters = decodeRasters(statements)
  const colors = decodeColors(source, statements)
  const diagnostics: string[] = []
  for (const gradient of gradients) {
    if (gradient.stops.length < 2) {
      diagnostics.push(
        `Gradient ${gradient.name} was retained but lacks two decoded stops.`,
      )
    }
  }
  for (const pattern of patterns) {
    diagnostics.push(
      `Pattern ${pattern.name} retains its native program; tiling render remains evidence-gated.`,
    )
  }
  for (const raster of rasters) {
    if (raster.embeddedBytes === undefined && raster.externalReference === undefined) {
      diagnostics.push(
        `Raster ${raster.id} has no decoded embedded payload or explicit external reference.`,
      )
    }
  }
  if (graph !== undefined) diagnostics.push(...graph.validate())
  return { gradients, patterns, rasters, colors, diagnostics }
}
