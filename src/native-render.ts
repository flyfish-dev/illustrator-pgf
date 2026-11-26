import {
  asNativeRecord,
  nativeFNV1a,
  nativeNumber,
  nativeString,
  stableNativeSerialize,
} from './native-foundation.js'
import { canvasCompositeOperationForBlendMode } from './native-analysis.js'

export type NativeRenderOperation =
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
      text: string
      runs: readonly unknown[]
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

export interface NativeRenderPlan {
  version: 1
  operations: readonly NativeRenderOperation[]
  resources: readonly string[]
  deterministicHash: string
  diagnostics: readonly string[]
}

function sceneRoots(scene: unknown): readonly unknown[] {
  const root = asNativeRecord(scene)
  const explicitRoot = asNativeRecord(root?.root)
  if (explicitRoot !== undefined) return [explicitRoot]
  if (Array.isArray(root?.children)) return root.children
  if (Array.isArray(root?.nodes)) return root.nodes
  if (Array.isArray(root?.layers)) return root.layers
  return []
}

function nodeId(node: Record<string, unknown>): string | undefined {
  return typeof node.id === 'string' ? node.id : undefined
}

function withNodeId(
  id: string | undefined,
): Readonly<{ nodeId?: string }> {
  return id === undefined ? {} : { nodeId: id }
}

function nodeType(node: Record<string, unknown>): string {
  return typeof node.type === 'string'
    ? node.type
    : typeof node.kind === 'string'
      ? node.kind
      : 'UnknownNode'
}

function pathGeometry(node: Record<string, unknown>): unknown {
  if (node.geometry !== undefined) return node.geometry
  if (Array.isArray(node.contours)) {
    return {
      contours: node.contours,
      ...(node.fillRule === undefined ? {} : { fillRule: node.fillRule }),
    }
  }
  return undefined
}

function isPathNode(node: Record<string, unknown>): boolean {
  const type = nodeType(node)
  return type === 'Path'
    || type === 'path'
    || type === 'CompoundPath'
    || type === 'compound-path'
}

function isClippingPath(node: Record<string, unknown>): boolean {
  return node.clippingPath === true
    || node.isClippingPath === true
    || node.clipRole === 'clip'
}

function groupAppearance(node: Record<string, unknown>): Readonly<{
  opacity: number
  blendMode: string
  isolated: boolean
  knockout: boolean
}> {
  const appearance = asNativeRecord(node.appearance)
  return {
    opacity: Math.max(
      0,
      Math.min(
        1,
        nativeNumber(appearance?.opacity)
          ?? nativeNumber(node.opacity)
          ?? 1,
      ),
    ),
    blendMode: nativeString(appearance?.blendMode)
      ?? nativeString(node.blendMode)
      ?? 'normal',
    isolated: appearance?.isolated === true || node.isolated === true,
    knockout: appearance?.knockout === true || node.knockout === true,
  }
}

function textRuns(node: Record<string, unknown>): readonly unknown[] {
  if (Array.isArray(node.runs)) return node.runs
  if (typeof node.text === 'string') return [{ text: node.text }]
  const story = asNativeRecord(node.story)
  if (typeof story?.text === 'string') return [{ text: story.text }]
  return []
}

function textContent(runs: readonly unknown[]): string {
  return runs.map((raw) => {
    const run = asNativeRecord(raw)
    return typeof run?.text === 'string' ? run.text : ''
  }).join('')
}

export function buildNativeRenderPlan(scene: unknown): NativeRenderPlan {
  const operations: NativeRenderOperation[] = []
  const resources = new Set<string>()
  const diagnostics: string[] = []
  const visiting = new Set<unknown>()

  const emitLeaf = (node: Record<string, unknown>): void => {
    const id = nodeId(node)
    const type = nodeType(node)
    if (isPathNode(node)) {
      const geometry = pathGeometry(node)
      if (geometry !== undefined && !isClippingPath(node)) {
        operations.push({
          kind: 'path',
          ...withNodeId(id),
          geometry,
          appearance: node.appearance,
        })
      }
      return
    }
    if (type === 'Text' || type === 'text') {
      const runs = textRuns(node)
      operations.push({
        kind: 'text',
        ...withNodeId(id),
        text: textContent(runs),
        runs,
        ...(node.matrix === undefined ? {} : { matrix: node.matrix }),
        ...(node.bounds === undefined ? {} : { bounds: node.bounds }),
        ...(node.appearance === undefined
          ? {}
          : { appearance: node.appearance }),
      })
      return
    }
    if (
      type === 'RasterImage'
      || type === 'raster-image'
      || type === 'PlacedArt'
      || type === 'placed-art'
      || type === 'image'
    ) {
      const resourceId = typeof node.resourceId === 'string'
        ? node.resourceId
        : typeof node.imageId === 'string'
          ? node.imageId
          : undefined
      if (resourceId !== undefined) resources.add(resourceId)
      operations.push({
        kind: 'image',
        ...withNodeId(id),
        ...(resourceId === undefined ? {} : { resourceId }),
        ...(node.bounds === undefined ? {} : { bounds: node.bounds }),
        ...(node.matrix === undefined ? {} : { matrix: node.matrix }),
        ...(node.appearance === undefined
          ? {}
          : { appearance: node.appearance }),
      })
      return
    }
    if (type === 'UnknownNode' || type === 'unknown') {
      const feature = typeof node.operator === 'string'
        ? `operator:${node.operator}`
        : 'unknown-visible-object'
      operations.push({
        kind: 'unsupported',
        ...withNodeId(id),
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
    const type = nodeType(node)
    const children = Array.isArray(node.children) ? node.children : []
    const isGroup = children.length > 0
      || type === 'Group'
      || type === 'group'
      || type === 'Layer'
      || type === 'layer'
      || type === 'ClipGroup'
      || type === 'clip-group'
    if (!isGroup) {
      emitLeaf(node)
      visiting.delete(value)
      return
    }

    operations.push({ kind: 'save', ...withNodeId(id) })
    operations.push({
      kind: 'begin-group',
      ...withNodeId(id),
      ...groupAppearance(node),
    })

    const explicitClip = asNativeRecord(node.clippingPath)
    const clippingChildren = children
      .map(asNativeRecord)
      .filter((child): child is Record<string, unknown> =>
        child !== undefined && isPathNode(child) && isClippingPath(child),
      )
    const clipping = explicitClip ?? clippingChildren[0]
    const clippingGeometry = clipping === undefined
      ? undefined
      : pathGeometry(clipping)
    if (clippingGeometry !== undefined) {
      const geometryRecord = asNativeRecord(clippingGeometry)
      operations.push({
        kind: 'begin-clip',
        ...withNodeId(nodeId(clipping)),
        geometry: clippingGeometry,
        fillRule: geometryRecord?.fillRule === 'evenodd'
          ? 'evenodd'
          : 'nonzero',
      })
    }

    emitLeaf(node)
    for (const child of children) {
      const childRecord = asNativeRecord(child)
      if (
        childRecord !== undefined
        && clippingChildren.includes(childRecord)
      ) continue
      walk(child)
    }

    if (clippingGeometry !== undefined) {
      operations.push({ kind: 'end-clip', ...withNodeId(id) })
    }
    operations.push({ kind: 'end-group', ...withNodeId(id) })
    operations.push({ kind: 'restore', ...withNodeId(id) })
    visiting.delete(value)
  }

  for (const root of sceneRoots(scene)) walk(root)
  const sortedResources = [...resources].sort()
  const deterministic = stableNativeSerialize({
    operations,
    resources: sortedResources,
  })
  return {
    version: 1,
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

interface NativePointLike {
  x: number
  y: number
  incoming?: Readonly<{ x: number; y: number }>
  outgoing?: Readonly<{ x: number; y: number }>
}

function pointFrom(value: unknown): NativePointLike | undefined {
  const record = asNativeRecord(value)
  const x = nativeNumber(record?.x)
  const y = nativeNumber(record?.y)
  if (x === undefined || y === undefined) return undefined
  const incomingRecord = asNativeRecord(record?.incoming)
  const outgoingRecord = asNativeRecord(record?.outgoing)
  const incomingX = nativeNumber(incomingRecord?.x)
  const incomingY = nativeNumber(incomingRecord?.y)
  const outgoingX = nativeNumber(outgoingRecord?.x)
  const outgoingY = nativeNumber(outgoingRecord?.y)
  const incoming = incomingX === undefined || incomingY === undefined
    ? undefined
    : { x: incomingX, y: incomingY }
  const outgoing = outgoingX === undefined || outgoingY === undefined
    ? undefined
    : { x: outgoingX, y: outgoingY }
  return {
    x,
    y,
    ...(incoming === undefined ? {} : { incoming }),
    ...(outgoing === undefined ? {} : { outgoing }),
  }
}

function tracePointContour(
  contour: Record<string, unknown>,
  target: NativePathTarget,
): boolean {
  const values = Array.isArray(contour.points) ? contour.points : []
  const points = values
    .map(pointFrom)
    .filter((point): point is NativePointLike => point !== undefined)
  const first = points[0]
  if (first === undefined) return false
  target.moveTo(first.x, first.y)
  let previous = first
  for (let index = 1; index < points.length; index++) {
    const current = points[index]
    if (current === undefined) continue
    if (previous.outgoing !== undefined || current.incoming !== undefined) {
      target.bezierCurveTo(
        previous.outgoing?.x ?? previous.x,
        previous.outgoing?.y ?? previous.y,
        current.incoming?.x ?? current.x,
        current.incoming?.y ?? current.y,
        current.x,
        current.y,
      )
    } else {
      target.lineTo(current.x, current.y)
    }
    previous = current
  }
  if (contour.closed === true) {
    if (previous.outgoing !== undefined || first.incoming !== undefined) {
      target.bezierCurveTo(
        previous.outgoing?.x ?? previous.x,
        previous.outgoing?.y ?? previous.y,
        first.incoming?.x ?? first.x,
        first.incoming?.y ?? first.y,
        first.x,
        first.y,
      )
    }
    target.closePath()
  }
  return true
}

function segmentEnd(
  segment: Record<string, unknown>,
): NativePointLike | undefined {
  return pointFrom(segment.end)
    ?? pointFrom(segment.to)
    ?? pointFrom(segment.point)
}

function traceSegmentContour(
  contour: Record<string, unknown>,
  target: NativePathTarget,
): boolean {
  const segments = Array.isArray(contour.segments) ? contour.segments : []
  const firstSegment = asNativeRecord(segments[0])
  const start = pointFrom(contour.start)
    ?? pointFrom(contour.first)
    ?? pointFrom(firstSegment?.start)
  if (start === undefined) return false
  target.moveTo(start.x, start.y)
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
      || control1 !== undefined
      || control2 !== undefined
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
  return true
}

export function traceNativeGeometry(
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
    if (Array.isArray(contour.points)) {
      traced = tracePointContour(contour, target) || traced
    } else {
      traced = traceSegmentContour(contour, target) || traced
    }
  }
  return traced
}

function paintCss(value: unknown): string | undefined {
  const record = asNativeRecord(value)
  const kind = nativeString(record?.kind)
    ?? nativeString(record?.space)
  if (kind === 'solid') return paintCss(record?.color)
  if (kind === 'rgb') {
    const red = Math.round(
      Math.max(0, Math.min(1,
        nativeNumber(record?.red) ?? nativeNumber(record?.r) ?? 0,
      )) * 255,
    )
    const green = Math.round(
      Math.max(0, Math.min(1,
        nativeNumber(record?.green) ?? nativeNumber(record?.g) ?? 0,
      )) * 255,
    )
    const blue = Math.round(
      Math.max(0, Math.min(1,
        nativeNumber(record?.blue) ?? nativeNumber(record?.b) ?? 0,
      )) * 255,
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
      nativeNumber(record?.cyan) ?? nativeNumber(record?.c) ?? 0,
    ))
    const magenta = Math.max(0, Math.min(1,
      nativeNumber(record?.magenta) ?? nativeNumber(record?.m) ?? 0,
    ))
    const yellow = Math.max(0, Math.min(1,
      nativeNumber(record?.yellow) ?? nativeNumber(record?.y) ?? 0,
    ))
    const black = Math.max(0, Math.min(1,
      nativeNumber(record?.black) ?? nativeNumber(record?.k) ?? 0,
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
  if (record === undefined) return undefined
  const value = record[field]
  if (Array.isArray(value)) return asNativeRecord(value[0])
  if (field === 'fills') return asNativeRecord(record.fill)
  return asNativeRecord(record.stroke)
}

function paintResourceId(paint: Record<string, unknown> | undefined): string | undefined {
  const payload = asNativeRecord(paint?.paint) ?? paint
  return typeof payload?.resourceId === 'string'
    ? payload.resourceId
    : typeof payload?.gradientId === 'string'
      ? payload.gradientId
      : typeof payload?.patternId === 'string'
        ? payload.patternId
        : undefined
}

export interface ExecuteNativeRenderPlanOptions {
  resourceImages?: ReadonlyMap<string, CanvasImageSource>
  paintServers?: ReadonlyMap<string, string | CanvasGradient | CanvasPattern>
  signal?: AbortSignal
  maximumOperations?: number
}

export function executeNativeRenderPlan(
  plan: NativeRenderPlan,
  context: CanvasRenderingContext2D,
  options: ExecuteNativeRenderPlanOptions = {},
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
      if (traceNativeGeometry(operation.geometry, context)) {
        context.clip(operation.fillRule)
      }
    } else if (operation.kind === 'path') {
      if (!traceNativeGeometry(operation.geometry, context)) continue
      const fill = firstPaint(operation.appearance, 'fills')
      const stroke = firstPaint(operation.appearance, 'strokes')
      const fillResource = paintResourceId(fill)
      const strokeResource = paintResourceId(stroke)
      const fillStyle = fillResource === undefined
        ? paintCss(fill?.paint ?? fill)
        : options.paintServers?.get(fillResource)
      const strokeStyle = strokeResource === undefined
        ? paintCss(stroke?.paint ?? stroke)
        : options.paintServers?.get(strokeResource)
      if (fillStyle !== undefined) {
        context.fillStyle = fillStyle
        context.fill()
      }
      if (strokeStyle !== undefined) {
        context.strokeStyle = strokeStyle
        context.lineWidth = nativeNumber(stroke?.width) ?? 1
        context.stroke()
      }
      if (fillResource !== undefined && fillStyle === undefined) {
        diagnostics.push(
          `Fill resource ${fillResource} was not prepared; no placeholder fill was drawn.`,
        )
      }
      if (strokeResource !== undefined && strokeStyle === undefined) {
        diagnostics.push(
          `Stroke resource ${strokeResource} was not prepared; no placeholder stroke was drawn.`,
        )
      }
    } else if (operation.kind === 'text') {
      const bounds = asNativeRecord(operation.bounds)
      let x = nativeNumber(bounds?.left) ?? 0
      const y = nativeNumber(bounds?.bottom) ?? 0
      for (const rawRun of operation.runs) {
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

function geometrySvgPath(geometry: unknown): string | undefined {
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
  return traceNativeGeometry(geometry, target)
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
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[ _]/gu, '-')
  return SAFE_SVG_BLEND_MODES.has(normalized) ? normalized : 'normal'
}

function lastScope(
  scopes: readonly ('group' | 'clip')[],
): 'group' | 'clip' | undefined {
  return scopes[scopes.length - 1]
}

export interface RenderNativeSvgOptions {
  width?: number
  height?: number
  namespace?: string
  paintServerIds?: ReadonlySet<string>
  imageHref?: ReadonlyMap<string, string>
}

export function renderNativePlanToSvg(
  plan: NativeRenderPlan,
  options: RenderNativeSvgOptions = {},
): string {
  const width = Math.max(1, Math.floor(options.width ?? 1024))
  const height = Math.max(1, Math.floor(options.height ?? 768))
  const namespace = (options.namespace ?? 'illustrator')
    .replace(/[^A-Za-z0-9_-]/gu, '_')
  const body: string[] = []
  const scopes: ('group' | 'clip')[] = []
  let clipIndex = 0
  for (const operation of plan.operations) {
    if (operation.kind === 'begin-group') {
      body.push(
        `<g id="${svgEscape(`${namespace}-${operation.nodeId ?? scopes.length}`)}" opacity="${svgNumber(operation.opacity)}" style="mix-blend-mode:${safeSvgBlendMode(operation.blendMode)}" data-isolated="${operation.isolated}" data-knockout="${operation.knockout}">`,
      )
      scopes.push('group')
    } else if (operation.kind === 'end-group') {
      while (lastScope(scopes) === 'clip') {
        body.push('</g>')
        scopes.pop()
      }
      if (lastScope(scopes) === 'group') {
        body.push('</g>')
        scopes.pop()
      }
    } else if (operation.kind === 'begin-clip') {
      const path = geometrySvgPath(operation.geometry)
      if (path !== undefined) {
        const id = `${namespace}-clip-${clipIndex++}`
        body.push(
          `<defs><clipPath id="${svgEscape(id)}"><path d="${svgEscape(path)}" clip-rule="${operation.fillRule}"/></clipPath></defs><g clip-path="url(#${svgEscape(id)})">`,
        )
        scopes.push('clip')
      }
    } else if (operation.kind === 'end-clip') {
      if (lastScope(scopes) === 'clip') {
        body.push('</g>')
        scopes.pop()
      }
    } else if (operation.kind === 'path') {
      const path = geometrySvgPath(operation.geometry)
      if (path === undefined) continue
      const fill = firstPaint(operation.appearance, 'fills')
      const stroke = firstPaint(operation.appearance, 'strokes')
      const fillResource = paintResourceId(fill)
      const strokeResource = paintResourceId(stroke)
      const fillValue = fillResource !== undefined
        && options.paintServerIds?.has(fillResource) === true
        ? `url(#${namespace}-${fillResource.replace(/[^A-Za-z0-9_-]/gu, '_')})`
        : paintCss(fill?.paint ?? fill) ?? 'none'
      const strokeValue = strokeResource !== undefined
        && options.paintServerIds?.has(strokeResource) === true
        ? `url(#${namespace}-${strokeResource.replace(/[^A-Za-z0-9_-]/gu, '_')})`
        : paintCss(stroke?.paint ?? stroke) ?? 'none'
      const widthValue = nativeNumber(stroke?.width) ?? 1
      body.push(
        `<path data-node="${svgEscape(operation.nodeId ?? '')}" d="${svgEscape(path)}" fill="${svgEscape(fillValue)}" stroke="${svgEscape(strokeValue)}" stroke-width="${svgNumber(widthValue)}"/>`,
      )
    } else if (operation.kind === 'text') {
      const bounds = asNativeRecord(operation.bounds)
      const x = nativeNumber(bounds?.left) ?? 0
      const y = nativeNumber(bounds?.bottom) ?? 0
      const spans = operation.runs.map((rawRun) => {
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
      const href = operation.resourceId === undefined
        ? undefined
        : options.imageHref?.get(operation.resourceId)
      const bounds = asNativeRecord(operation.bounds)
      const left = nativeNumber(bounds?.left)
      const top = nativeNumber(bounds?.top)
      const right = nativeNumber(bounds?.right)
      const bottom = nativeNumber(bounds?.bottom)
      if (
        href !== undefined
        && /^(?:data:image\/|blob:)/iu.test(href)
        && left !== undefined
        && top !== undefined
        && right !== undefined
        && bottom !== undefined
      ) {
        body.push(
          `<image data-node="${svgEscape(operation.nodeId ?? '')}" href="${svgEscape(href)}" x="${svgNumber(left)}" y="${svgNumber(top)}" width="${svgNumber(right - left)}" height="${svgNumber(bottom - top)}"/>`,
        )
      } else {
        body.push(
          `<g data-node="${svgEscape(operation.nodeId ?? '')}" data-resource="${svgEscape(operation.resourceId ?? '')}" data-image-unresolved="true"/>`,
        )
      }
    } else if (operation.kind === 'unsupported') {
      body.push(`<!-- unsupported:${svgEscape(operation.feature)} -->`)
    }
  }
  while (scopes.length > 0) {
    body.push('</g>')
    scopes.pop()
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-plan-hash="${plan.deterministicHash}">${body.join('')}</svg>`
}
