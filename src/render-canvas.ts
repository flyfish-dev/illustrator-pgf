import type {
  IllustratorDiagnostic,
  IllustratorFidelity,
  IllustratorPaint,
  IllustratorPathNode,
  IllustratorSceneDocument,
  IllustratorSceneNode,
  RenderOptions,
  RenderResult,
} from './types.js'
import { diagnostic } from './errors.js'
import { resolveLimits } from './limits.js'
import { WorkBudget, clamp, safeCssColor } from './util.js'

type RenderContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type RenderCanvas = HTMLCanvasElement | OffscreenCanvas

function paintToCanvas(paint: IllustratorPaint, diagnostics: IllustratorDiagnostic[]): string | undefined {
  switch (paint.kind) {
    case 'none': return undefined
    case 'gray': { const value = Math.round(clamp(paint.gray) * 255); return `rgba(${value},${value},${value},${clamp(paint.alpha)})` }
    case 'rgb': return `rgba(${Math.round(clamp(paint.red) * 255)},${Math.round(clamp(paint.green) * 255)},${Math.round(clamp(paint.blue) * 255)},${clamp(paint.alpha)})`
    case 'cmyk': {
      diagnostics.push(diagnostic('AI_RENDER_CMYK_APPROXIMATION', 'warning', 'render', 'CMYK paint was approximated in sRGB for Canvas2D.', { feature: 'cmyk' }))
      return `rgba(${Math.round(255 * (1 - clamp(paint.cyan)) * (1 - clamp(paint.black)))},${Math.round(255 * (1 - clamp(paint.magenta)) * (1 - clamp(paint.black)))},${Math.round(255 * (1 - clamp(paint.yellow)) * (1 - clamp(paint.black)))},${clamp(paint.alpha)})`
    }
    case 'lab': {
      diagnostics.push(diagnostic('AI_RENDER_LAB_APPROXIMATION', 'warning', 'render', 'Lab paint was approximated as neutral gray for Canvas2D.', { feature: 'lab' }))
      const value = Math.round(clamp(paint.lightness / 100) * 255)
      return `rgba(${value},${value},${value},${clamp(paint.alpha)})`
    }
    case 'spot':
      diagnostics.push(diagnostic('AI_RENDER_SPOT_APPROXIMATION', 'warning', 'render', `Spot ink ${paint.name} was rendered through its alternate color.`, { feature: 'spot-color' }))
      return paintToCanvas(paint.alternate, diagnostics)
    default:
      diagnostics.push(diagnostic('AI_RENDER_PAINT_UNSUPPORTED', 'warning', 'render', `${paint.kind} paint has no resolved Canvas2D resource.`, { feature: paint.kind }))
      return undefined
  }
}

function drawPath(context: RenderContext, node: IllustratorPathNode): void {
  context.beginPath()
  for (const contour of node.geometry.contours) {
    context.moveTo(contour.start.x, contour.start.y)
    for (const segment of contour.segments) {
      if (segment.kind === 'line') context.lineTo(segment.to.x, segment.to.y)
      else context.bezierCurveTo(segment.control1.x, segment.control1.y, segment.control2.x, segment.control2.y, segment.to.x, segment.to.y)
    }
    if (contour.closed) context.closePath()
  }
}

function applyNodeTransform(context: RenderContext, node: IllustratorSceneNode): void {
  const matrix = node.transform
  context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)
}

function canvasBlendMode(mode: string): GlobalCompositeOperation {
  const supported: GlobalCompositeOperation[] = ['source-over','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity']
  const normalized = mode === 'normal' ? 'source-over' : mode as GlobalCompositeOperation
  return supported.includes(normalized) ? normalized : 'source-over'
}

function contextFromTarget(target: RenderCanvas | RenderContext): { context: RenderContext; canvas: RenderCanvas } {
  if ('getContext' in target) {
    const context = target.getContext('2d')
    if (context === null) throw new Error('Canvas2D context is unavailable.')
    return { context, canvas: target }
  }
  return { context: target, canvas: target.canvas as RenderCanvas }
}

export async function renderIllustratorScene(
  document: IllustratorSceneDocument,
  target: RenderCanvas | RenderContext,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const limits = resolveLimits()
  const budget = new WorkBudget(options.signal, limits.maxWorkerTimeMs)
  const diagnostics: IllustratorDiagnostic[] = []
  const artboard = options.artboardId === undefined ? document.artboards[0] : document.artboards.find((candidate) => candidate.id === options.artboardId)
  const viewport = options.viewport ?? artboard?.bounds
  if (viewport === undefined) throw new Error('Scene has no artboard or explicit viewport to render.')
  const viewWidth = Math.max(0.001, viewport.right - viewport.left)
  const viewHeight = Math.max(0.001, viewport.top - viewport.bottom)
  const width = Math.max(1, Math.round(options.width ?? viewWidth))
  const height = Math.max(1, Math.round(options.height ?? viewHeight))
  const dpr = Math.max(0.1, options.dpr ?? globalThis.devicePixelRatio ?? 1)
  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height * dpr))
  const maximum = Math.min(options.maxPixels ?? limits.maxRenderPixels, limits.maxRenderPixels)
  if (pixelWidth * pixelHeight > maximum) throw new Error(`Canvas render exceeds the ${maximum}-pixel limit.`)
  const { context, canvas } = contextFromTarget(target)
  canvas.width = pixelWidth; canvas.height = pixelHeight
  if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) { canvas.style.width = `${width}px`; canvas.style.height = `${height}px` }
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, pixelWidth, pixelHeight)
  if (options.background !== undefined) {
    context.fillStyle = safeCssColor(options.background, 'transparent')
    context.fillRect(0, 0, pixelWidth, pixelHeight)
  }
  const scaleX = pixelWidth / viewWidth
  const scaleY = pixelHeight / viewHeight
  context.setTransform(scaleX, 0, 0, -scaleY, -viewport.left * scaleX, viewport.top * scaleY)
  const hidden = new Set(options.hiddenLayerIds ?? [])

  const renderPath = (node: IllustratorPathNode, clipping = false): void => {
    context.save(); applyNodeTransform(context, node); drawPath(context, node)
    if (clipping) { context.restore(); return }
    context.globalAlpha *= clamp(node.appearance.opacity)
    context.globalCompositeOperation = canvasBlendMode(node.appearance.blendMode)
    for (const fill of node.appearance.fills) {
      const style = paintToCanvas(fill.paint, diagnostics)
      if (style === undefined) continue
      context.fillStyle = style; context.globalAlpha *= clamp(fill.opacity)
      context.fill(node.geometry.fillRule)
      context.globalAlpha = clamp(node.appearance.opacity)
    }
    for (const stroke of node.appearance.strokes) {
      const style = paintToCanvas(stroke.paint, diagnostics)
      if (style === undefined) continue
      context.strokeStyle = style; context.lineWidth = Math.max(0, stroke.width)
      context.lineCap = stroke.cap; context.lineJoin = stroke.join; context.miterLimit = Math.max(1, stroke.miterLimit)
      context.setLineDash([...stroke.dashArray]); context.lineDashOffset = stroke.dashOffset
      context.globalAlpha = clamp(node.appearance.opacity * stroke.opacity)
      context.stroke()
    }
    context.restore()
  }

  const renderNode = (node: IllustratorSceneNode): void => {
    budget.consume('renderNodes', 1, limits.maxNodes, 'render')
    if (!node.visible || (node.type === 'Layer' && hidden.has(node.id))) return
    if (node.type === 'Path' || node.type === 'CompoundPath') { if (!node.clippingPath) renderPath(node); return }
    if (node.type === 'ClipGroup') {
      context.save()
      const clip = node.children.find((child): child is IllustratorPathNode => (child.type === 'Path' || child.type === 'CompoundPath') && child.clippingPath)
      if (clip !== undefined) {
        applyNodeTransform(context, clip); drawPath(context, clip); context.clip(clip.geometry.fillRule)
        const inverse = clip.transform
        // Restore the parent coordinate system after installing the clip. Canvas keeps the clip in device space.
        if (inverse.a !== 1 || inverse.b !== 0 || inverse.c !== 0 || inverse.d !== 1 || inverse.e !== 0 || inverse.f !== 0) context.setTransform(scaleX, 0, 0, -scaleY, -viewport.left * scaleX, viewport.top * scaleY)
      }
      for (const child of node.children) if (child !== clip) renderNode(child)
      context.restore(); return
    }
    if (node.type === 'Layer' || node.type === 'Group' || node.type === 'SymbolDefinition') {
      context.save(); context.globalAlpha *= clamp(node.appearance.opacity); context.globalCompositeOperation = canvasBlendMode(node.appearance.blendMode)
      for (const child of node.children) renderNode(child)
      context.restore(); return
    }
    if (node.type === 'Text') {
      context.save()
      context.globalCompositeOperation = canvasBlendMode(node.appearance.blendMode)
      applyNodeTransform(context, node)
      context.scale(1, -1)
      let x = 0
      const y = 0
      for (const run of node.runs) {
        const fill = paintToCanvas(run.fill, diagnostics)
        if (fill !== undefined) {
          context.fillStyle = fill; context.globalAlpha = clamp(run.opacity)
          const family = (run.fontPostScriptName ?? 'sans-serif').replace(/["'<>]/gu, '')
          context.font = `${Math.max(0.1, run.fontSize)}px "${family}"`
          context.fillText(run.text, x, y)
        }
        x += run.text.length * run.fontSize * 0.6
      }
      context.restore(); return
    }
    diagnostics.push(diagnostic('AI_RENDER_NODE_OMITTED', 'warning', 'render', `${node.type} ${node.id} has no resolved Canvas2D representation and was omitted.`, { nodeId: node.id, feature: node.type }))
  }
  for (const child of document.children) renderNode(child)
  context.restore()
  return { width, height, revision: options.revision ?? 0, fidelity: diagnostics.some((entry) => entry.severity === 'error') ? 'partial' as IllustratorFidelity : document.fidelity, diagnostics }
}
