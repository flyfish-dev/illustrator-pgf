import {
  asNativeRecord,
  latin1SourceText,
  nativeBoolean,
  nativeBoundsFrom,
  nativeNumber,
  nativeString,
} from './native-common.js'
import type { NativeBounds } from './native-geometry.js'

export interface NativeArtboard extends NativeBounds {
  id: string
  name: string
  uuid?: string
  selected?: boolean
  locked?: boolean
  pixelAspectRatio?: number
  rulerOrigin?: Readonly<{ x: number; y: number }>
  bleed?: Readonly<{
    top: number
    right: number
    bottom: number
    left: number
  }>
  rawProperties: Readonly<Record<string, string | number | boolean>>
  source: 'scene' | 'private-source' | 'bounding-box'
}

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`

function decodePostScriptString(value: string): string {
  return value.replace(
    /\\(\r\n|\r|\n|[0-7]{1,3}|.)/gsu,
    (_match, escape: string) => {
      if (/^[0-7]+$/u.test(escape)) {
        return String.fromCharCode(Number.parseInt(escape, 8))
      }
      if (escape === 'n') return '\n'
      if (escape === 'r') return '\r'
      if (escape === 't') return '\t'
      if (escape === 'b') return '\b'
      if (escape === 'f') return '\f'
      if (escape === '\n' || escape === '\r' || escape === '\r\n') return ''
      return escape
    },
  )
}

function pointProperty(
  block: string,
  name: string,
): Readonly<{ x: number; y: number }> | undefined {
  const patterns = [
    new RegExp(
      `(${NUMBER})\\s+(${NUMBER})\\s+/RealPointRelToROrigin(?:\\s+%_?)?\\s*\\(${name}\\)`,
      'u',
    ),
    new RegExp(
      `(${NUMBER})\\s+(${NUMBER})\\s+/RealPoint(?:\\s+%_?)?\\s*\\(${name}\\)`,
      'u',
    ),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(block)
    if (match !== null) {
      return { x: Number(match[1]), y: Number(match[2]) }
    }
  }
  return undefined
}

function rawProperties(
  block: string,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  const numeric = new RegExp(
    `%_?\\s*(${NUMBER})\\s+/(Real|Int|Bool)\\s+\\(([^)]*)\\)`,
    'gu',
  )
  for (const match of block.matchAll(numeric)) {
    const key = match[3]
    if (key === undefined) continue
    const value = Number(match[1])
    result[key] = match[2] === 'Bool' ? value !== 0 : value
  }
  for (const match of block.matchAll(
    /%_?\s*\(((?:\\.|[^\\)])*)\)\s+\/(?:UnicodeString|String)\s+\(([^)]*)\)/gu,
  )) {
    if (match[2] !== undefined) {
      result[match[2]] = decodePostScriptString(match[1] ?? '')
    }
  }
  return result
}

function globalBleed(
  source: string,
): NativeArtboard['bleed'] | undefined {
  const side = (name: string): number | undefined => {
    const match = new RegExp(
      `(${NUMBER})\\s+/Real\\s+\\(Bleed${name}Value\\)`,
      'u',
    ).exec(source)
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
  const top = side('Top')
  const right = side('Right')
  const bottom = side('Bottom')
  const left = side('Left')
  if (
    top === undefined
    || right === undefined
    || bottom === undefined
    || left === undefined
  ) return undefined
  return { top, right, bottom, left }
}

function sourceArtboards(source: string): NativeArtboard[] {
  const result: NativeArtboard[] = []
  const bleed = globalBleed(source)
  let index = 0
  for (const match of source.matchAll(
    /^%AIArtboard:\s*([^|\r\n]+)\|\s*([+-]?[0-9.eE]+)\s+([+-]?[0-9.eE]+)\s+([+-]?[0-9.eE]+)\s+([+-]?[0-9.eE]+)/gmu,
  )) {
    const name = match[1]?.trim() || `Artboard ${index + 1}`
    result.push({
      id: `source-artboard-${index}`,
      name,
      left: Number(match[2]),
      top: Number(match[3]),
      right: Number(match[4]),
      bottom: Number(match[5]),
      ...(bleed === undefined ? {} : { bleed }),
      rawProperties: {},
      source: 'private-source',
    })
    index++
  }

  const dictionaryMarker = /%_?\/Dictionary\s*:/gu
  const starts = [...source.matchAll(dictionaryMarker)].map((match) => match.index)
  starts.push(source.length)
  for (let blockIndex = 0; blockIndex + 1 < starts.length; blockIndex++) {
    const start = starts[blockIndex]
    const end = starts[blockIndex + 1]
    if (start === undefined || end === undefined) continue
    const block = source.slice(start, end)
    const first = pointProperty(block, 'PositionPoint1')
    const second = pointProperty(block, 'PositionPoint2')
    if (first === undefined || second === undefined) continue
    const properties = rawProperties(block)
    const encodedName = /%_?\s*\(((?:\\.|[^\\)])*)\)\s+\/UnicodeString\s+\(Name\)/u.exec(block)?.[1]
    const name = encodedName === undefined
      ? typeof properties.Name === 'string'
        ? properties.Name
        : `Artboard ${result.length + 1}`
      : decodePostScriptString(encodedName)
    const rulerOrigin = pointProperty(block, 'RulerOrigin')
    const uuid = typeof properties.ArtboardUUID === 'string'
      ? properties.ArtboardUUID
      : undefined
    const duplicate = result.some((entry) =>
      (uuid !== undefined && entry.uuid === uuid)
      || (
        entry.name === name
        && entry.left === first.x
        && entry.top === first.y
        && entry.right === second.x
        && entry.bottom === second.y
      ),
    )
    if (duplicate) continue
    result.push({
      id: uuid ?? `source-artboard-${result.length}`,
      name,
      ...(uuid === undefined ? {} : { uuid }),
      left: first.x,
      top: first.y,
      right: second.x,
      bottom: second.y,
      ...(typeof properties.IsArtboardSelected === 'boolean'
        ? { selected: properties.IsArtboardSelected }
        : {}),
      ...(typeof properties.IsArtboardLocked === 'boolean'
        ? { locked: properties.IsArtboardLocked }
        : {}),
      ...(typeof properties.PAR === 'number'
        ? { pixelAspectRatio: properties.PAR }
        : {}),
      ...(rulerOrigin === undefined ? {} : { rulerOrigin }),
      ...(bleed === undefined ? {} : { bleed }),
      rawProperties: properties,
      source: 'private-source',
    })
  }
  return result
}

function sceneArtboards(scene: unknown): NativeArtboard[] {
  const record = asNativeRecord(scene)
  const values = Array.isArray(record?.artboards) ? record.artboards : []
  const result: NativeArtboard[] = []
  for (const raw of values) {
    const artboard = asNativeRecord(raw)
    const bounds = nativeBoundsFrom(artboard)
      ?? nativeBoundsFrom(artboard?.bounds)
    if (bounds === undefined) continue
    const index = result.length
    const name = nativeString(artboard?.name) ?? `Artboard ${index + 1}`
    const uuid = nativeString(artboard?.uuid)
    const rawBleed = asNativeRecord(artboard?.bleed)
    const bleedTop = nativeNumber(rawBleed?.top)
    const bleedRight = nativeNumber(rawBleed?.right)
    const bleedBottom = nativeNumber(rawBleed?.bottom)
    const bleedLeft = nativeNumber(rawBleed?.left)
    const bleed = bleedTop === undefined
      || bleedRight === undefined
      || bleedBottom === undefined
      || bleedLeft === undefined
      ? undefined
      : {
          top: bleedTop,
          right: bleedRight,
          bottom: bleedBottom,
          left: bleedLeft,
        }
    const ruler = asNativeRecord(artboard?.rulerOrigin)
    const rulerX = nativeNumber(ruler?.x)
    const rulerY = nativeNumber(ruler?.y)
    result.push({
      id: nativeString(artboard?.id) ?? uuid ?? `scene-artboard-${index}`,
      name,
      ...(uuid === undefined ? {} : { uuid }),
      ...bounds,
      ...(nativeBoolean(artboard?.selected) === undefined
        ? {}
        : { selected: nativeBoolean(artboard?.selected) }),
      ...(nativeBoolean(artboard?.locked) === undefined
        ? {}
        : { locked: nativeBoolean(artboard?.locked) }),
      ...(nativeNumber(artboard?.pixelAspectRatio) === undefined
        ? {}
        : { pixelAspectRatio: nativeNumber(artboard?.pixelAspectRatio) }),
      ...(rulerX === undefined || rulerY === undefined
        ? {}
        : { rulerOrigin: { x: rulerX, y: rulerY } }),
      ...(bleed === undefined ? {} : { bleed }),
      rawProperties: {},
      source: 'scene',
    })
  }
  return result
}

function boundingBoxArtboard(source: string): NativeArtboard | undefined {
  const match = new RegExp(
    `^%%(?:HiRes)?BoundingBox:\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})`,
    'imu',
  ).exec(source)
  if (match === null) return undefined
  return {
    id: 'bounding-box-artboard',
    name: 'Artboard 1',
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
    rawProperties: {},
    source: 'bounding-box',
  }
}

export function extractNativeArtboards(
  source: string | Uint8Array,
  scene?: unknown,
  maximumSourceBytes = 64 * 1024 * 1024,
): readonly NativeArtboard[] {
  const text = latin1SourceText(source, maximumSourceBytes)
  const fromScene = sceneArtboards(scene)
  const fromSource = sourceArtboards(text)
  const merged = [...fromScene]
  for (const candidate of fromSource) {
    const match = merged.find((existing) =>
      (candidate.uuid !== undefined && existing.uuid === candidate.uuid)
      || (
        existing.name === candidate.name
        && existing.left === candidate.left
        && existing.top === candidate.top
        && existing.right === candidate.right
        && existing.bottom === candidate.bottom
      ),
    )
    if (match === undefined) {
      merged.push(candidate)
      continue
    }
    Object.assign(match, {
      ...candidate,
      source: match.source === 'scene' ? 'scene' : candidate.source,
      rawProperties: {
        ...match.rawProperties,
        ...candidate.rawProperties,
      },
    })
  }
  if (merged.length > 0) return merged
  const fallback = boundingBoxArtboard(text)
  return fallback === undefined ? [] : [fallback]
}
