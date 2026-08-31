import {
  asNativeRecord,
  nativeBoundsFrom,
  nativeNumber,
  walkNativeScene,
} from './native-common.js'
import type { NativeFidelity } from './native-fidelity.js'
import type { NativeBounds } from './native-geometry.js'

export interface NativeTextRunModel {
  text: string
  fontPostScriptName?: string
  fontSize?: number
  tracking?: number
  horizontalScale?: number
  baselineShift?: number
  fill?: unknown
  stroke?: unknown
  raw: unknown
}

export interface NativeTextFrameModel {
  id: string
  kind: 'point' | 'area' | 'path' | 'unknown'
  storyId: string
  threadPrevious?: string
  threadNext?: string
  matrix?: readonly number[]
  bounds?: NativeBounds
  pathNodeId?: string
  runs: readonly NativeTextRunModel[]
  fidelity: NativeFidelity
}

export interface NativeTextStoryModel {
  id: string
  frameIds: readonly string[]
  text: string
}

export interface NativeTextModel {
  stories: readonly NativeTextStoryModel[]
  frames: readonly NativeTextFrameModel[]
  requiredFonts: readonly string[]
  diagnostics: readonly string[]
}

function textKind(node: Record<string, unknown>): NativeTextFrameModel['kind'] {
  const raw = typeof node.textKind === 'string'
    ? node.textKind
    : typeof node.kind === 'string'
      ? node.kind
      : 'unknown'
  if (raw === 'point' || raw === 'area' || raw === 'path') return raw
  return 'unknown'
}

function textRun(raw: unknown, requiredFonts: Set<string>): NativeTextRunModel {
  const record = asNativeRecord(raw)
  const text = typeof record?.text === 'string' ? record.text : ''
  const fontPostScriptName = typeof record?.fontPostScriptName === 'string'
    ? record.fontPostScriptName
    : typeof record?.fontFamily === 'string'
      ? record.fontFamily
      : undefined
  if (fontPostScriptName !== undefined) requiredFonts.add(fontPostScriptName)
  const fontSize = nativeNumber(record?.fontSize)
  const tracking = nativeNumber(record?.tracking)
  const horizontalScale = nativeNumber(record?.horizontalScale)
  const baselineShift = nativeNumber(record?.baselineShift)
  return {
    text,
    ...(fontPostScriptName === undefined ? {} : { fontPostScriptName }),
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(tracking === undefined ? {} : { tracking }),
    ...(horizontalScale === undefined ? {} : { horizontalScale }),
    ...(baselineShift === undefined ? {} : { baselineShift }),
    ...(record?.fill === undefined ? {} : { fill: record.fill }),
    ...(record?.stroke === undefined ? {} : { stroke: record.stroke }),
    raw,
  }
}

export function buildNativeTextModel(scene: unknown): NativeTextModel {
  const frames: NativeTextFrameModel[] = []
  const requiredFonts = new Set<string>()
  const diagnostics: string[] = []
  walkNativeScene(scene, (node) => {
    if (node.type !== 'Text') return
    const id = typeof node.id === 'string' ? node.id : `text:${frames.length}`
    const storyId = typeof node.storyId === 'string'
      ? node.storyId
      : `story:${id}`
    const kind = textKind(node)
    const rawRuns = Array.isArray(node.runs) ? node.runs : []
    const runs = rawRuns.map((raw) => textRun(raw, requiredFonts))
    const matrix = Array.isArray(node.matrix)
      ? node.matrix.filter((entry): entry is number =>
          typeof entry === 'number' && Number.isFinite(entry),
        )
      : undefined
    const bounds = nativeBoundsFrom(node.bounds)
    if (kind !== 'point') {
      diagnostics.push(
        `Text frame ${id} preserves ${kind} text structure but needs layout Oracle evidence.`,
      )
    }
    frames.push({
      id,
      kind,
      storyId,
      ...(typeof node.threadPrevious === 'string'
        ? { threadPrevious: node.threadPrevious }
        : {}),
      ...(typeof node.threadNext === 'string'
        ? { threadNext: node.threadNext }
        : {}),
      ...(matrix === undefined ? {} : { matrix }),
      ...(bounds === undefined ? {} : { bounds }),
      ...(typeof node.pathNodeId === 'string'
        ? { pathNodeId: node.pathNodeId }
        : {}),
      runs,
      fidelity: kind === 'point' ? 'partial' : 'structure-only',
    })
  })
  const storyFrames = new Map<string, NativeTextFrameModel[]>()
  for (const frame of frames) {
    const existing = storyFrames.get(frame.storyId)
    if (existing === undefined) storyFrames.set(frame.storyId, [frame])
    else existing.push(frame)
  }
  const stories = [...storyFrames.entries()].map(([id, values]) => ({
    id,
    frameIds: values.map((frame) => frame.id),
    text: values
      .flatMap((frame) => frame.runs)
      .map((run) => run.text)
      .join(''),
  }))
  return {
    stories,
    frames,
    requiredFonts: [...requiredFonts].sort(),
    diagnostics,
  }
}

export function estimateNativeTextBounds(
  run: NativeTextRunModel,
  origin: Readonly<{ x: number; y: number }>,
): NativeBounds {
  const size = Math.max(0, run.fontSize ?? 12)
  const scale = Math.max(0, run.horizontalScale ?? 100) / 100
  const tracking = run.tracking ?? 0
  const glyphAdvance = size * 0.6 * scale
  const width = Math.max(0, run.text.length * glyphAdvance + Math.max(0, run.text.length - 1) * tracking / 1000 * size)
  const ascent = size * 0.8
  const descent = size * 0.2
  const shift = run.baselineShift ?? 0
  return {
    left: origin.x,
    top: origin.y - ascent - shift,
    right: origin.x + width,
    bottom: origin.y + descent - shift,
  }
}
