import type {
  IllustratorDiagnostic,
  IllustratorPaint,
  IllustratorPathNode,
  IllustratorSceneDocument,
  IllustratorSceneNode,
  SvgExportOptions,
} from './types.js'
import { diagnostic } from './errors.js'
import { resolveLimits } from './limits.js'
import { WorkBudget, clamp, escapeXml, safeCssColor } from './util.js'

export interface SvgRenderResult { svg: string; diagnostics: readonly IllustratorDiagnostic[] }

function paintToCss(paint: IllustratorPaint, diagnostics: IllustratorDiagnostic[]): string {
  switch (paint.kind) {
    case 'none': return 'none'
    case 'gray': { const value = Math.round(clamp(paint.gray) * 255); return `rgba(${value},${value},${value},${clamp(paint.alpha)})` }
    case 'rgb': return `rgba(${Math.round(clamp(paint.red) * 255)},${Math.round(clamp(paint.green) * 255)},${Math.round(clamp(paint.blue) * 255)},${clamp(paint.alpha)})`
    case 'cmyk': {
      const red = 255 * (1 - clamp(paint.cyan)) * (1 - clamp(paint.black))
      const green = 255 * (1 - clamp(paint.magenta)) * (1 - clamp(paint.black))
      const blue = 255 * (1 - clamp(paint.yellow)) * (1 - clamp(paint.black))
      diagnostics.push(diagnostic('AI_RENDER_CMYK_APPROXIMATION', 'warning', 'render', 'CMYK paint was approximated in sRGB for SVG output.', { feature: 'cmyk' }))
      return `rgba(${Math.round(red)},${Math.round(green)},${Math.round(blue)},${clamp(paint.alpha)})`
    }
    case 'lab': {
      const gray = Math.round(clamp(paint.lightness / 100) * 255)
      diagnostics.push(diagnostic('AI_RENDER_LAB_APPROXIMATION', 'warning', 'render', 'Lab paint was approximated as neutral gray because no ICC transform was supplied.', { feature: 'lab' }))
      return `rgba(${gray},${gray},${gray},${clamp(paint.alpha)})`
    }
    case 'spot':
      diagnostics.push(diagnostic('AI_RENDER_SPOT_APPROXIMATION', 'warning', 'render', `Spot ink ${paint.name} was rendered through its alternate color.`, { feature: 'spot-color' }))
      return paintToCss(paint.alternate, diagnostics)
    default:
      diagnostics.push(diagnostic('AI_RENDER_PAINT_UNSUPPORTED', 'warning', 'render', `${paint.kind} paint requires a resolved resource and was omitted.`, { feature: paint.kind }))
      return 'none'
  }
}

function pathData(node: IllustratorPathNode): string {
  const parts: string[] = []
  for (const contour of node.geometry.contours) {
    parts.push(`M${contour.start.x} ${contour.start.y}`)
    for (const segment of contour.segments) {
      if (segment.kind === 'line') parts.push(`L${segment.to.x} ${segment.to.y}`)
      else parts.push(`C${segment.control1.x} ${segment.control1.y} ${segment.control2.x} ${segment.control2.y} ${segment.to.x} ${segment.to.y}`)
    }
    if (contour.closed) parts.push('Z')
  }
  return parts.join(' ')
}

function matrixAttribute(node: IllustratorSceneNode): string {
  const m = node.transform
  return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`
}

function safeBlendMode(mode: string): string {
  return new Set(['normal','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity']).has(mode) ? mode : 'normal'
}

export function renderIllustratorSceneToSvg(document: IllustratorSceneDocument, options: SvgExportOptions = {}): SvgRenderResult {
  const limits = resolveLimits()
  const budget = new WorkBudget(options.signal, limits.maxWorkerTimeMs)
  const diagnostics: IllustratorDiagnostic[] = []
  const artboard = options.artboardId === undefined ? document.artboards[0] : document.artboards.find((candidate) => candidate.id === options.artboardId)
  const viewport = options.viewport ?? artboard?.bounds
  if (viewport === undefined) throw new Error('Scene has no artboard or explicit viewport to export.')
  const viewWidth = Math.max(0.001, viewport.right - viewport.left)
  const viewHeight = Math.max(0.001, viewport.top - viewport.bottom)
  const width = Math.max(1, Math.round(options.width ?? viewWidth))
  const height = Math.max(1, Math.round(options.height ?? viewHeight))
  const dpr = Math.max(0.1, options.dpr ?? 1)
  const pixels = width * height * dpr * dpr
  const maxPixels = Math.min(options.maxPixels ?? limits.maxRenderPixels, limits.maxRenderPixels)
  if (!Number.isFinite(pixels) || pixels > maxPixels) throw new Error(`SVG viewport exceeds the ${maxPixels}-pixel render budget.`)
  const namespace = (options.namespace ?? 'ai').replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 64) || 'ai'
  const hidden = new Set(options.hiddenLayerIds ?? [])
  const definitions: string[] = []
  const emittedIds = new Set<string>()
  const emitPathLayers = (node: IllustratorPathNode, extra = ''): string => {
    const d = pathData(node)
    const common = `d="${escapeXml(d)}" transform="${matrixAttribute(node)}" fill-rule="${node.geometry.fillRule}" opacity="${clamp(node.appearance.opacity)}" style="mix-blend-mode:${safeBlendMode(node.appearance.blendMode)}" ${extra}`
    const layers: string[] = []
    for (const fill of node.appearance.fills) layers.push(`<path ${common} fill="${paintToCss(fill.paint, diagnostics)}" fill-opacity="${clamp(fill.opacity)}" stroke="none"/>`)
    for (const stroke of node.appearance.strokes) layers.push(`<path ${common} fill="none" stroke="${paintToCss(stroke.paint, diagnostics)}" stroke-width="${Math.max(0, stroke.width)}" stroke-linecap="${stroke.cap}" stroke-linejoin="${stroke.join}" stroke-miterlimit="${Math.max(1, stroke.miterLimit)}" stroke-dasharray="${stroke.dashArray.join(' ')}" stroke-dashoffset="${stroke.dashOffset}" stroke-opacity="${clamp(stroke.opacity)}"/>`)
    if (layers.length === 0 && node.clippingPath) layers.push(`<path ${common} fill="black" stroke="none"/>`)
    return layers.join('')
  }
  const renderNode = (node: IllustratorSceneNode): string => {
    budget.consume('renderNodes', 1, limits.maxNodes, 'render')
    if (!node.visible || (node.type === 'Layer' && hidden.has(node.id))) return ''
    emittedIds.add(node.id)
    if (node.type === 'Path' || node.type === 'CompoundPath') return node.clippingPath ? '' : emitPathLayers(node)
    if (node.type === 'Layer' || node.type === 'Group' || node.type === 'SymbolDefinition') {
      const children = node.children.map(renderNode).join('')
      return `<g id="${namespace}-${escapeXml(node.id)}" opacity="${clamp(node.appearance.opacity)}" style="mix-blend-mode:${safeBlendMode(node.appearance.blendMode)}">${children}</g>`
    }
    if (node.type === 'ClipGroup') {
      const clip = node.children.find((child): child is IllustratorPathNode => (child.type === 'Path' || child.type === 'CompoundPath') && child.clippingPath)
      const clipId = `${namespace}-clip-${node.id.replace(/[^A-Za-z0-9_-]/gu, '_')}`
      if (clip !== undefined) definitions.push(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${emitPathLayers(clip)}</clipPath>`)
      const children = node.children.filter((child) => child !== clip).map(renderNode).join('')
      return clip === undefined ? `<g>${children}</g>` : `<g clip-path="url(#${clipId})">${children}</g>`
    }
    if (node.type === 'Text') {
      let cursor = 0
      const spans = node.runs.map((run) => {
        const font = escapeXml((run.fontPostScriptName ?? 'sans-serif').replace(/["'<>]/gu, ''))
        const text = escapeXml(run.text)
        const output = `<tspan x="${cursor}" y="0" font-family="${font}" font-size="${Math.max(0.1, run.fontSize)}" fill="${paintToCss(run.fill, diagnostics)}" fill-opacity="${clamp(run.opacity)}">${text}</tspan>`
        cursor += run.text.length * run.fontSize * 0.6
        return output
      }).join('')
      return `<text transform="${matrixAttribute(node)} scale(1 -1)">${spans}</text>`
    }
    if (node.type === 'UnknownNode' || node.type === 'PluginObject' || node.type === 'GradientMesh' || node.type === 'RasterImage' || node.type === 'PlacedImage' || node.type === 'SymbolInstance') {
      diagnostics.push(diagnostic('AI_RENDER_NODE_OMITTED', 'warning', 'render', `${node.type} ${node.id} has no safe resolved visual representation and was omitted.`, { nodeId: node.id, feature: node.type }))
      return ''
    }
    return ''
  }
  const body = document.children.map(renderNode).join('')
  const background = options.background === undefined ? '' : `<rect x="${viewport.left}" y="${-viewport.top}" width="${viewWidth}" height="${viewHeight}" fill="${escapeXml(safeCssColor(options.background, 'transparent'))}"/>`
  const metadata = options.includeMetadata === true ? `<metadata>${escapeXml(JSON.stringify({ format: document.format, schemaVersion: document.schemaVersion, fidelity: document.fidelity, sourceFingerprint: document.sourceFingerprint, emittedNodeIds: [...emittedIds] }))}</metadata>` : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewport.left} ${-viewport.top} ${viewWidth} ${viewHeight}" role="img" data-fidelity="${document.fidelity}">${metadata}${definitions.length === 0 ? '' : `<defs>${definitions.join('')}</defs>`}${background}<g transform="scale(1 -1)">${body}</g></svg>`
  if (/<script\b|\son[a-z]+\s*=|<foreignObject\b|(?:href|src)\s*=\s*["'](?:https?:|data:|javascript:)/iu.test(svg)) throw new Error('Internal SVG safety invariant failed.')
  return { svg, diagnostics }
}

export function exportIllustratorSvg(document: IllustratorSceneDocument, options: SvgExportOptions = {}): string { return renderIllustratorSceneToSvg(document, options).svg }
