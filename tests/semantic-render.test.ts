import test from 'node:test'
import assert from 'node:assert/strict'
import { parseIllustratorSource } from '../src/ast.js'
import { createDefaultOperatorRegistry, lowerIllustratorAst, lowerIllustratorSource } from '../src/semantic.js'
import { createIllustratorSupportReport, getIllustratorDocumentSummary, validateIllustratorScene, walkSceneNodes } from '../src/scene.js'
import { exportIllustratorSvg, renderIllustratorSceneToSvg } from '../src/render-svg.js'
import type { IllustratorPathNode, IllustratorSceneNode, IllustratorTextNode } from '../src/types.js'
import { DIRECT_SOURCE_BYTES } from './fixtures.js'

function nodes(scene: Awaited<ReturnType<typeof lowerIllustratorSource>>): IllustratorSceneNode[] {
  const result: IllustratorSceneNode[] = []
  walkSceneNodes(scene, (node) => result.push(node))
  return result
}

test('versioned operator registry exposes declared schemas and fixture IDs', () => {
  const coverage = createDefaultOperatorRegistry().coverage()
  assert.ok(coverage.length > 100)
  const layer = coverage.find((entry) => entry.operator === 'Lb')
  assert.equal(layer?.family, 'ai5')
  assert.equal(layer?.fixtureId, 'layer-begin')
  assert.deepEqual(layer?.stateWrites, ['hierarchy'])
})

test('paths, appearance, layer hierarchy and artboard lower into Scene IR', async () => {
  const scene = await lowerIllustratorSource(DIRECT_SOURCE_BYTES)
  const all = nodes(scene)
  const layer = all.find((node) => node.type === 'Layer')
  const path = all.find((node): node is IllustratorPathNode => node.type === 'Path')
  assert.equal(scene.artboards[0]?.name, 'Main')
  assert.equal(layer?.name, 'Artwork')
  assert.equal(path?.geometry.contours[0]?.segments.length, 3)
  assert.equal(path?.geometry.contours[0]?.closed, true)
  assert.equal(path?.appearance.fills[0]?.paint.kind, 'cmyk')
  assert.equal(path?.appearance.strokes[0]?.width, 2)
  assert.equal(path?.parentId, layer?.id)
  assert.equal(path?.layerId, layer?.id)
})

test('text remains native structured text with explicit partial fidelity', async () => {
  const scene = await lowerIllustratorSource(DIRECT_SOURCE_BYTES)
  const text = nodes(scene).find((node): node is IllustratorTextNode => node.type === 'Text')
  assert.equal(text?.runs[0]?.text, 'Hello (PGF)')
  assert.equal(text?.runs[0]?.fontPostScriptName, 'Helvetica')
  assert.equal(text?.runs[0]?.fontSize, 12)
  assert.equal(text?.bounds?.left, 30)
  assert.ok(Math.abs((text?.bounds?.bottom ?? 0) - 42.12) < 0.001)
  assert.equal(text?.fidelity, 'partial')
})

test('unknown visible operators become inventory, diagnostics and hidden UnknownNode', async () => {
  const scene = await lowerIllustratorSource(DIRECT_SOURCE_BYTES)
  const unknown = nodes(scene).find((node) => node.type === 'UnknownNode')
  assert.equal(unknown?.type, 'UnknownNode')
  assert.equal(unknown?.visible, false)
  assert.ok(scene.unsupportedFeatures.some((feature) => feature.feature === 'unknown-visible-operator' && feature.visible))
  assert.ok(scene.diagnostics.some((diagnostic) => diagnostic.code === 'AI_OPERATOR_UNKNOWN'))
  assert.equal(scene.fidelity, 'partial')
})

test('PostScript prolog definitions do not create visible scene nodes', async () => {
  const source = '%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator 8\n%%BoundingBox: 0 0 10 10\n%%BeginProlog\n/foo { 1 2 mysteryProgram } def\n%%EndProlog\n0 0 m\n10 10 l\nS\n%%EOF\n'
  const scene = await lowerIllustratorSource(source)
  assert.equal(nodes(scene).filter((node) => node.type === 'UnknownNode').length, 0)
  assert.equal(scene.diagnostics.filter((diagnostic) => diagnostic.code === 'AI_OPERATOR_UNKNOWN').length, 0)
})

test('compound paths retain multiple contours and even-odd fill', async () => {
  const source = '%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator 8\n%%BoundingBox: 0 0 100 100\n*u\n0 0 m\n100 0 l\n100 100 l\n0 100 l\nh\n25 25 m\n25 75 l\n75 75 l\n75 25 l\nh\n*U\nf*\n%%EOF\n'
  const scene = await lowerIllustratorSource(source)
  const compound = nodes(scene).find((node): node is IllustratorPathNode => node.type === 'CompoundPath')
  assert.equal(compound?.geometry.contours.length, 2)
  assert.equal(compound?.geometry.fillRule, 'evenodd')
})

test('clip groups are represented structurally instead of flattening geometry', async () => {
  const source = '%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator 8\n%%BoundingBox: 0 0 100 100\n0 0 m\n100 0 l\n100 100 l\nh\nW\nn\n10 10 m\n90 90 l\nS\nU\n%%EOF\n'
  const scene = await lowerIllustratorSource(source)
  const clip = nodes(scene).find((node) => node.type === 'ClipGroup')
  assert.ok(clip !== undefined)
  if (clip === undefined || clip.type !== 'ClipGroup') throw new Error('Expected ClipGroup')
  assert.ok(clip.children.some((child) => (child.type === 'Path' || child.type === 'CompoundPath') && child.clippingPath))
})

test('gradient and image operators are preserved as resources/nodes with structure-only fidelity', async () => {
  const source = '%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator 10\n%%BoundingBox: 0 0 100 100\n(My Gradient) Bd\n1 2 3 rawGradientRecord\nBD\n20 10 XI\n%%EOF\n'
  const scene = await lowerIllustratorSource(source)
  assert.ok(Object.values(scene.resources).some((resource) => resource.kind === 'gradient'))
  assert.ok(nodes(scene).some((node) => node.type === 'RasterImage'))
  assert.ok(scene.unsupportedFeatures.some((feature) => feature.feature === 'embedded-raster-decoder'))
  assert.equal(scene.fidelity, 'structure-only')
})

test('Scene IR validator detects parent corruption', () => {
  const ast = parseIllustratorSource(DIRECT_SOURCE_BYTES)
  const scene = lowerIllustratorAst(ast)
  const path = nodes(scene).find((node) => node.type === 'Path')
  assert.ok(path !== undefined)
  if (path === undefined) throw new Error('Expected path')
  const originalParent = path.parentId
  path.parentId = 'corrupt-parent'
  assert.throws(() => validateIllustratorScene(scene), /parent/iu)
  path.parentId = originalParent
  validateIllustratorScene(scene)
})

test('support report and summary are derived from scene data', async () => {
  const scene = await lowerIllustratorSource(DIRECT_SOURCE_BYTES)
  const report = createIllustratorSupportReport(scene)
  const summary = getIllustratorDocumentSummary(scene)
  assert.equal(summary.artboards, 1)
  assert.equal(summary.layers, 1)
  assert.ok(summary.paths >= 1)
  assert.equal(report.unknownOperators.mysteryVisibleOperator, 1)
  assert.ok(report.exactFeatures.includes('unknown-syntax-preservation'))
})

test('safe SVG export namespaces IDs and excludes active content', async () => {
  const scene = await lowerIllustratorSource(DIRECT_SOURCE_BYTES)
  const result = renderIllustratorSceneToSvg(scene, { namespace: 'case<script>', includeMetadata: true })
  assert.match(result.svg, /^<svg/u)
  assert.doesNotMatch(result.svg, /<script|onload=|onclick=|foreignObject|javascript:/iu)
  assert.match(result.svg, /data-fidelity=/u)
  assert.match(result.svg, /case_script_/u)
})

test('SVG output is deterministic for the same Scene IR and options', async () => {
  const scene = await lowerIllustratorSource(DIRECT_SOURCE_BYTES)
  assert.equal(exportIllustratorSvg(scene, { namespace: 'stable' }), exportIllustratorSvg(scene, { namespace: 'stable' }))
})

test('Canvas2D renderer respects viewport dimensions and emits drawing operations', async () => {
  const { renderIllustratorScene } = await import('../src/render-canvas.js')
  const scene = await lowerIllustratorSource(DIRECT_SOURCE_BYTES)
  const calls: string[] = []
  const canvas: any = { width: 0, height: 0 }
  const context: any = new Proxy({ canvas, fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0, font: '' }, {
    get(target, property) {
      if (property in target) return (target as any)[property]
      return (..._args: unknown[]) => { calls.push(String(property)) }
    },
    set(target, property, value) { (target as any)[property] = value; return true },
  })
  canvas.getContext = () => context
  const result = await renderIllustratorScene(scene, canvas, { width: 400, height: 200, dpr: 1 })
  assert.equal(canvas.width, 400)
  assert.equal(canvas.height, 200)
  assert.equal(result.width, 400)
  assert.ok(calls.includes('fill') && calls.includes('stroke') && calls.includes('fillText'))
})
