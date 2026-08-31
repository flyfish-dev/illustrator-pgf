import {
  asNativeRecord,
  nativeFNV1a,
  nativeNumber,
  nativeString,
  stableNativeSerialize,
} from './native-common.js'
import { canvasCompositeOperationForBlendMode } from './native-transparency.js'

export type NativeRenderOperationV2 =
  | Readonly<{ kind: 'save'; nodeId?: string }>
  | Readonly<{ kind: 'restore'; nodeId?: string }>
  | Readonly<{
      kind: 'begin-group'
      nodeId?: string
      opacity: number
      blendMode: string
      isolated: boolean
      knockout: boolean
    }>
  | Readonly<{ kind: 'end-group'; nodeId?: string }>
  | Readonly<{
      kind: 'begin-clip'
      nodeId?: string
      geometry: unknown
      fillRule: CanvasFillRule
    }>
  | Readonly<{ kind: 'end-clip'; nodeId?: string }>
  | Readonly<{
      kind: 'path'
      nodeId?: string
      geometry: unknown
      appearance: unknown
    }>
  | Readonly<{
      kind: 'text'
      nodeId?: string
      runs: unknown
      matrix?: unknown
      bounds?: unknown
      appearance?: unknown
    }>
  | Readonly<{
      kind: 'image'
      nodeId?: string
      resourceId?: string
      bounds?: unknown
      matrix?: unknown
      appearance?: unknown
    }>
  | Readonly<{
      kind: 'unsupported'
      nodeId?: string
      feature: string
      raw?: unknown
    }>

export interface NativeRenderPlanV2 {
  version: 2
  operations: readonly NativeRenderOperationV2[]
  resources: readonly string[]
  deterministicHash: string
  diagnostics: readonly string[]
}

function sceneRoots(scene: unknown): readonly unknown[] {
  const root = asNativeRecord(scene)
  if (Array.isArray(root?.children)) return root.children
  if (Array.isArray(root?.nodes)) return root.nodes
  if (Array.isArray(root?.layers)) return root.layers
  return []
}

function operationNodeId(
  id: string | undefined,
): Readonly<{ nodeId?: string }> {
  return id === undefined ? {} : { nodeId: id }
}

function nodeId(node: Record<string, unknown>): string | undefined {
  return typeof node.id === 'string' ? node.id : undefined
}

function isPathNode(node: Record<string, unknown>): boolean {
  return node.type === 'Path' || node.type === 'CompoundPath'
}

function isClippingPath(node: Record<string, unknown>): boolean {
  return node.clippingPath === true
    || node.isClippingPath === true
    || node.clipRole === 'clip'
}

function fillRuleForGeometry(geometry: unknown): CanvasFillRule {
  const record = asNativeRecord(geometry)
  return record?.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
}

function groupAppearance(node: Record<string, unknown>): Readonly<{
  opacity: number
  blendMode: string
  isolated: boolean
  knockout: boolean
}> {
  const appearance = asNativeRecord(node.appearance)
  return {
    opacity: Math.max(0, Math.min(1,
      nativeNumber(appearance?.opacity) ?? nativeNumber(node.opacity) ?? 1,
    )),
    blendMode: nativeString(appearance?.blendMode)
      ?? nativeString(node.blendMode)
      ?? 'normal',
    isolated: appearance?.isolated === true || node.isolated === true,
    knockout: appearance?.knockout === true || node.knockout === true,
  }
}

export function buildNativeRenderPlanV2(
  scene: unknown,
): NativeRenderPlanV2 {
  const operations: NativeRenderOperationV2[] = []
  const resources = new Set<string>()
  const diagnostics: string[] = []
  const visiting = new Set<unknown>()

  const emitLeaf = (node: Record<string, unknown>): void => {
    const id = nodeId(node)
    if (isPathNode(node) && node.geometry !== undefined) {
      if (!isClippingPath(node)) {
        operations.push({
          kind: 'path',
          ...operationNodeId(id),
          geometry: node.geometry,
          appearance: node.appearance,
        })
      }
      return
    }
    if (node.type === 'Text') {
      operations.push({
        kind: 'text',
        ...operationNodeId(id),
        runs: node.runs,
        ...(node.matrix === undefined ? {} : { matrix: node.matrix }),
        ...(node.bounds === undefined ? {} : { bounds: node.bounds }),
        ...(node.appearance === undefined
          ? {}
          : { appearance: node.appearance }),
      })
      return
    }
    if (node.type === 'RasterImage' || node.type === 'PlacedArt') {
      const resourceId = typeof node.resourceId === 'string'
        ? node.resourceId
        : undefined
      if (resourceId !== undefined) resources.add(resourceId)
      operations.push({
        kind: 'image',
        ...operationNodeId(id),
        ...(resourceId === undefined ? {} : { resourceId }),
        ...(node.bounds === undefined ? {} : { bounds: node.bounds }),
        ...(node.matrix === undefined ? {} : { matrix: node.matrix }),
        ...(node.appearance === undefined
          ? {}
          : { appearance: node.appearance }),
      })
      return
    }
    if (node.type === 'UnknownNode') {
      const feature = typeof node.operator === 'string'
        ? `operator:${node.operator}`
        : 'unknown-visible-object'
      operations.push({
        kind: 'unsupported',
        ...operationNodeId(id),
        feature,
        raw: node,
      })
      diagnostics.push(
        `${feature} was retained but cannot be emitted as fabricated artwork.`,
      )
    }
  }

  const walk = (value: unknown): void => {
    const node = asNativeRecord(value)
    if (node === undefined) return
    if (visiting.has(value)) {
      diagnostics.push(
        `Scene cycle detected at ${nodeId(node) ?? '(unnamed node)'}.`,
      )
      return
    }
    visiting.add(value)
    const id = nodeId(node)
    const children = Array.isArray(node.children) ? node.children : []
    const isGroup = children.length > 0
      || node.type === 'Group'
      || node.type === 'Layer'
      || node.type === 'ClipGroup'
    if (!isGroup) {
      emitLeaf(node)
      visiting.delete(value)
      return
    }

    const group = groupAppearance(node)
    operations.push({ kind: 'save', ...operationNodeId(id) })
    operations.push({
      kind: 'begin-group',
      ...operationNodeId(id),
      ...group,
    })

    const clippingChildren = node.type === 'ClipGroup'
      ? children
          .map(asNativeRecord)
          .filter((child): child is Record<string, unknown> =>
            child !== undefined && isPathNode(child) && isClippingPath(child),
          )
      : []
    const clipping = clippingChildren[0]
    if (clipping !== undefined && clipping.geometry !== undefined) {
      operations.push({
        kind: 'begin-clip',
        ...operationNodeId(nodeId(clipping)),
        geometry: clipping.geometry,
        fillRule: fillRuleForGeometry(clipping.geometry),
      })
    }

    emitLeaf(node)
    for (const child of children) {
      const childRecord = asNativeRecord(child)
      if (childRecord !== undefined && clippingChildren.includes(childRecord)) {
        continue
      }
      walk(child)
    }

    if (clipping !== undefined) {
      operations.push({ kind: 'end-clip', ...operationNodeId(id) })
    }
    operations.push({ kind: 'end-group', ...operationNodeId(id) })
    operations.push({ kind: 'restore', ...operationNodeId(id) })
    visiting.delete(value)
  }

  for (const root of sceneRoots(scene)) walk(root)
  const sortedResources = [...resources].sort()
  const deterministic = stableNativeSerialize({
    operations,
    resources: sortedResources,
  })
  return {
    version: 2,
    operations,
    resources: sortedResources,
    deterministicHash: nativeFNV1a(deterministic),
    diagnostics,
  }
}

interface NativePathTarget {
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x: number,
    y: number,
  ): void
  closePath(): void
}

function pointFrom(
  value: unknown,
): Readonly<{ x: number; y: number }> | undefined {
  const record = asNativeRecord(value)
  const x = nativeNumber(record?.x)
  const y = nativeNumber(record?.y)
  return x === undefined || y === undefined ? undefined : { x, y }
}

function segmentEnd(
  segment: Record<string, unknown>,
): Readonly<{ x: number; y: number }> | undefined {
  return pointFrom(segment.end)
    ?? pointFrom(segment.to)
    ?? pointFrom(segment.point)
}

export function traceNativeGeometryV2(
  geometry: unknown,
  target: NativePathTarget,
): boolean {
  const record = asNativeRecord(geometry)
  if (!Array.isArray(record?.contours)) return false
  target.beginPath()
  let traced = false
  for (const rawContour of record.contours) {
    const contour = asNativeRecord(rawContour)
    if (contour === undefined) continue
    const segments = Array.isArray(contour.segments) ? contour.segments : []
    const firstSegment = asNativeRecord(segments[0])
    const start = pointFrom(contour.start)
      ?? pointFrom(contour.first)
      ?? pointFrom(firstSegment?.start)
    if (start === undefined) continue
    target.moveTo(start.x, start.y)
    traced = true
    let previous = start
    for (const rawSegment of segments) {
      const segment = asNativeRecord(rawSegment)
      if (segment === undefined) continue
      const end = segmentEnd(segment)
      if (end === undefined) continue
      const control1 = pointFrom(segment.control1)
        ?? pointFrom(segment.c1)
        ?? pointFrom(segment.outgoing)
      const control2 = pointFrom(segment.control2)
        ?? pointFrom(segment.c2)
        ?? pointFrom(segment.incoming)
      const type = nativeString(segment.type)
        ?? nativeString(segment.kind)
      if (
        type === 'cubic'
        || type === 'curve'
        || (control1 !== undefined && control2 !== undefined)
      ) {
        target.bezierCurveTo(
          control1?.x ?? previous.x,
          control1?.y ?? previous.y,
          control2?.x ?? end.x,
          control2?.y ?? end.y,
          end.x,
          end.y,
        )
      } else {
        target.lineTo(end.x, end.y)
      }
      previous = end
    }
    if (contour.closed === true) target.closePath()
  }
  return traced
}

function paintCss(value: unknown): string | undefined {
  const record = asNativeRecord(value)
  const kind = nativeString(record?.kind)
  if (kind === 'rgb') {
    const red = Math.round(
      Math.max(0, Math.min(1, nativeNumber(record?.red) ?? 0)) * 255,
    )
    const green = Math.round(
      Math.max(0, Math.min(1, nativeNumber(record?.green) ?? 0)) * 255,
    )
    const blue = Math.round(
      Math.max(0, Math.min(1, nativeNumber(record?.blue) ?? 0)) * 255,
    )
    const alpha = Math.max(0, Math.min(1,
      nativeNumber(record?.alpha) ?? 1,
    ))
    return `rgba(${red},${green},${blue},${alpha})`
  }
  if (kind === 'gray') {
    const gray = Math.round(
      Math.max(0, Math.min(1,
        nativeNumber(record?.gray) ?? nativeNumber(record?.value) ?? 0,
      )) * 255,
    )
    const alpha = Math.max(0, Math.min(1,
      nativeNumber(record?.alpha) ?? 1,
    ))
    return `rgba(${gray},${gray},${gray},${alpha})`
  }
  if (kind === 'cmyk') {
    const cyan = Math.max(0, Math.min(1,
      nativeNumber(record?.cyan) ?? 0,
    ))
    const magenta = Math.max(0, Math.min(1,
      nativeNumber(record?.magenta) ?? 0,
    ))
    const yellow = Math.max(0, Math.min(1,
      nativeNumber(record?.yellow) ?? 0,
    ))
    const black = Math.max(0, Math.min(1,
      nativeNumber(record?.black) ?? 0,
    ))
    const red = Math.round(255 * (1 - cyan) * (1 - black))
    const green = Math.round(255 * (1 - magenta) * (1 - black))
    const blue = Math.round(255 * (1 - yellow) * (1 - black))
    const alpha = Math.max(0, Math.min(1,
      nativeNumber(record?.alpha) ?? 1,
    ))
    return `rgba(${red},${green},${blue},${alpha})`
  }
  if (kind === 'spot') return paintCss(record?.alternate)
  return undefined
}

function firstPaint(
  appearance: unknown,
  field: 'fills' | 'strokes',
): Record<string, unknown> | undefined {
  const record = asNativeRecord(appearance)
  const value = record?.[field]
  const values = Array.isArray(value) ? value : []
  return asNativeRecord(values[0])
}

export interface ExecuteNativeRenderPlanV2Options {
  resourceImages?: ReadonlyMap<string, CanvasImageSource>
  signal?: AbortSignal
  maximumOperations?: number
}

export function executeNativeRenderPlanV2(
  plan: NativeRenderPlanV2,
  context: CanvasRenderingContext2D,
  options: ExecuteNativeRenderPlanV2Options = {},
): readonly string[] {
  const diagnostics: string[] = []
  const maximumOperations = options.maximumOperations ?? 1_000_000
  if (plan.operations.length > maximumOperations) {
    throw new RangeError(
      `Render plan exceeds the ${maximumOperations}-operation limit.`,
    )
  }
  for (const operation of plan.operations) {
    if (options.signal?.aborted === true) {
      throw new DOMException('Rendering aborted.', 'AbortError')
    }
    if (operation.kind === 'save') context.save()
    else if (operation.kind === 'restore') context.restore()
    else if (operation.kind === 'begin-group') {
      context.globalAlpha *= operation.opacity
      const composite = canvasCompositeOperationForBlendMode(
        operation.blendMode,
      )
      if (composite !== undefined) {
        context.globalCompositeOperation = composite
      } else {
        diagnostics.push(
          `Canvas does not map blend mode ${operation.blendMode}.`,
        )
      }
      if (operation.isolated || operation.knockout) {
        diagnostics.push(
          `Group ${operation.nodeId ?? ''} requires offscreen isolation or knockout compositing.`,
        )
      }
    } else if (operation.kind === 'begin-clip') {
      if (traceNativeGeometryV2(operation.geometry, context)) {
        context.clip(operation.fillRule)
      }
    } else if (operation.kind === 'path') {
      if (!traceNativeGeometryV2(operation.geometry, context)) continue
      const fill = firstPaint(operation.appearance, 'fills')
      const stroke = firstPaint(operation.appearance, 'strokes')
      const fillCss = paintCss(fill?.paint)
      const strokeCss = paintCss(stroke?.paint)
      if (fillCss !== undefined) {
        context.fillStyle = fillCss
        context.fill()
      }
      if (strokeCss !== undefined) {
        context.strokeStyle = strokeCss
        context.lineWidth = nativeNumber(stroke?.width) ?? 1
        context.stroke()
      }
    } else if (operation.kind === 'text') {
      const runs = Array.isArray(operation.runs) ? operation.runs : []
      const bounds = asNativeRecord(operation.bounds)
      let x = nativeNumber(bounds?.left) ?? 0
      const y = nativeNumber(bounds?.bottom) ?? 0
      for (const rawRun of runs) {
        const run = asNativeRecord(rawRun)
        const text = typeof run?.text === 'string' ? run.text : ''
        const size = nativeNumber(run?.fontSize) ?? 12
        const family = typeof run?.fontPostScriptName === 'string'
          ? run.fontPostScriptName
          : 'sans-serif'
        context.font = `${size}px ${JSON.stringify(family)}`
        const fill = paintCss(run?.fill)
        if (fill !== undefined) context.fillStyle = fill
        context.fillText(text, x, y)
        x += context.measureText(text).width
      }
    } else if (operation.kind === 'image') {
      const image = operation.resourceId === undefined
        ? undefined
        : options.resourceImages?.get(operation.resourceId)
      const bounds = asNativeRecord(operation.bounds)
      const left = nativeNumber(bounds?.left)
      const top = nativeNumber(bounds?.top)
      const right = nativeNumber(bounds?.right)
      const bottom = nativeNumber(bounds?.bottom)
      if (
        image !== undefined
        && left !== undefined
        && top !== undefined
        && right !== undefined
        && bottom !== undefined
      ) {
        context.drawImage(image, left, top, right - left, bottom - top)
      } else {
        diagnostics.push(
          `Image resource ${operation.resourceId ?? '(missing id)'} was not resolved; no placeholder artwork was drawn.`,
        )
      }
    } else if (operation.kind === 'unsupported') {
      diagnostics.push(
        `${operation.feature} is retained and intentionally omitted from fabricated output.`,
      )
    }
  }
  return diagnostics
}

function svgEscape(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character] ?? character)
}

function svgNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number(value.toFixed(6)).toString()
}

function nativeGeometrySvgPathV2(geometry: unknown): string | undefined {
  const commands: string[] = []
  const target: NativePathTarget = {
    beginPath: () => undefined,
    moveTo: (x, y) => commands.push(`M${svgNumber(x)} ${svgNumber(y)}`),
    lineTo: (x, y) => commands.push(`L${svgNumber(x)} ${svgNumber(y)}`),
    bezierCurveTo: (x1, y1, x2, y2, x, y) => commands.push(
      `C${svgNumber(x1)} ${svgNumber(y1)} ${svgNumber(x2)} ${svgNumber(y2)} ${svgNumber(x)} ${svgNumber(y)}`,
    ),
    closePath: () => commands.push('Z'),
  }
  return traceNativeGeometryV2(geometry, target)
    ? commands.join(' ')
    : undefined
}

const SAFE_SVG_BLEND_MODES = new Set([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
])

function safeSvgBlendMode(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[ _]/gu, '-')
  return SAFE_SVG_BLEND_MODES.has(normalized) ? normalized : 'normal'
}

export function renderNativePlanToSvgV2(
  plan: NativeRenderPlanV2,
  options: Readonly<{
    width?: number
    height?: number
    namespace?: string
  }> = {},
): string {
  const width = Math.max(1, Math.floor(options.width ?? 1024))
  const height = Math.max(1, Math.floor(options.height ?? 768))
  const namespace = (options.namespace ?? 'illustrator')
    .replace(/[^A-Za-z0-9_-]/gu, '_')
  const body: string[] = []
  const scopeStack: ('group' | 'clip')[] = []
  let clipIndex = 0
  for (const operation of plan.operations) {
    if (operation.kind === 'begin-group') {
      body.push(
        `<g id="${svgEscape(`${namespace}-${operation.nodeId ?? scopeStack.length}`)}" opacity="${svgNumber(operation.opacity)}" style="mix-blend-mode:${safeSvgBlendMode(operation.blendMode)}" data-isolated="${operation.isolated}" data-knockout="${operation.knockout}">`,
      )
      scopeStack.push('group')
    } else if (operation.kind === 'end-group') {
      while (scopeStack.at(-1) === 'clip') {
        body.push('</g>')
        scopeStack.pop()
      }
      if (scopeStack.at(-1) === 'group') {
        body.push('</g>')
        scopeStack.pop()
      }
    } else if (operation.kind === 'begin-clip') {
      const path = nativeGeometrySvgPathV2(operation.geometry)
      if (path !== undefined) {
        const id = `${namespace}-clip-${clipIndex++}`
        body.push(
          `<defs><clipPath id="${svgEscape(id)}"><path d="${svgEscape(path)}" clip-rule="${operation.fillRule}"/></clipPath></defs><g clip-path="url(#${svgEscape(id)})">`,
        )
        scopeStack.push('clip')
      }
    } else if (operation.kind === 'end-clip') {
      if (scopeStack.at(-1) === 'clip') {
        body.push('</g>')
        scopeStack.pop()
      }
    } else if (operation.kind === 'path') {
      const path = nativeGeometrySvgPathV2(operation.geometry)
      if (path === undefined) continue
      const fill = firstPaint(operation.appearance, 'fills')
      const stroke = firstPaint(operation.appearance, 'strokes')
      const fillCss = paintCss(fill?.paint) ?? 'none'
      const strokeCss = paintCss(stroke?.paint) ?? 'none'
      const widthValue = nativeNumber(stroke?.width) ?? 1
      body.push(
        `<path data-node="${svgEscape(operation.nodeId ?? '')}" d="${svgEscape(path)}" fill="${svgEscape(fillCss)}" stroke="${svgEscape(strokeCss)}" stroke-width="${svgNumber(widthValue)}"/>`,
      )
    } else if (operation.kind === 'text') {
      const runs = Array.isArray(operation.runs) ? operation.runs : []
      const bounds = asNativeRecord(operation.bounds)
      const x = nativeNumber(bounds?.left) ?? 0
      const y = nativeNumber(bounds?.bottom) ?? 0
      const spans = runs.map((rawRun) => {
        const run = asNativeRecord(rawRun)
        const text = typeof run?.text === 'string' ? run.text : ''
        const size = nativeNumber(run?.fontSize) ?? 12
        const family = typeof run?.fontPostScriptName === 'string'
          ? run.fontPostScriptName
          : 'sans-serif'
        return `<tspan font-family="${svgEscape(family)}" font-size="${svgNumber(size)}">${svgEscape(text)}</tspan>`
      })
      body.push(
        `<text data-node="${svgEscape(operation.nodeId ?? '')}" x="${svgNumber(x)}" y="${svgNumber(y)}">${spans.join('')}</text>`,
      )
    } else if (operation.kind === 'image') {
      body.push(
        `<g data-node="${svgEscape(operation.nodeId ?? '')}" data-resource="${svgEscape(operation.resourceId ?? '')}" data-image-unresolved="true"/>`,
      )
    } else if (operation.kind === 'unsupported') {
      body.push(`<!-- unsupported:${svgEscape(operation.feature)} -->`)
    }
  }
  while (scopeStack.length > 0) {
    body.push('</g>')
    scopeStack.pop()
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-plan-hash="${plan.deterministicHash}">${body.join('')}</svg>`
}
