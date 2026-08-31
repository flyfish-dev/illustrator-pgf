import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ByteLruCache,
  CooperativeBudget,
  createBrowserZstdCodecProvider,
  detectIllustratorVersionProfile,
  exactCubicBezierBounds,
  resolveNativeFidelity,
} from '../src/native-foundation.js'
import {
  buildNativeAdvancedObjectModel,
  buildNativeResourceGraph,
  buildNativeTextModel,
  buildNativeTransparencyModel,
  classifyNativeSourceSections,
  decodeNativeResources,
  extractNativeArtboards,
  resolveNativeResource,
} from '../src/native-analysis.js'
import {
  buildNativeRenderPlan,
  renderNativePlanToSvg,
} from '../src/native-render.js'
import {
  compareNativeRgbaOracle,
  compareNativeStructureOracle,
  createDeterministicNativeMutations,
  nativeStructureSnapshot,
  scanNativeSourceSecurity,
  validateNativeOracleManifest,
} from '../src/native-verification.js'
import { openNativeIllustratorDocument } from '../src/native-pipeline.js'
import { DIRECT_SOURCE_BYTES } from './fixtures.js'

test('high fidelity cannot be promoted without real Illustrator and Oracle evidence', () => {
  const decision = resolveNativeFidelity('high', [
    {
      id: 'synthetic',
      kind: 'synthetic-fixture',
      status: 'passed',
    },
    {
      id: 'security',
      kind: 'security-budget',
      status: 'passed',
    },
  ])
  assert.equal(decision.effective, 'partial')
  assert.equal(decision.promotable, false)
  assert.ok(decision.missingEvidence.includes('structure-oracle'))
  assert.ok(decision.missingEvidence.includes('visual-oracle'))
})

test('high fidelity becomes promotable only when every required gate passes', () => {
  const decision = resolveNativeFidelity('high', [
    'synthetic-fixture',
    'real-illustrator-fixture',
    'structure-oracle',
    'visual-oracle',
    'performance-budget',
    'security-budget',
  ].map((kind, index) => ({
    id: `evidence-${index}`,
    kind: kind as
      | 'synthetic-fixture'
      | 'real-illustrator-fixture'
      | 'structure-oracle'
      | 'visual-oracle'
      | 'performance-budget'
      | 'security-budget',
    status: 'passed' as const,
  })))
  assert.equal(decision.effective, 'high')
  assert.equal(decision.promotable, true)
})

test('version profile distinguishes AI24 zstd private source', () => {
  const profile = detectIllustratorVersionProfile([
    '%!PS-Adobe-3.0',
    '%AI24_CreatorVersion: 24.0',
    '%AI24_ZStandard_Data',
    '%%Creator: Adobe Illustrator 24.0',
  ].join('\n'))
  assert.equal(profile.family, 'ai24')
  assert.equal(profile.privateCompression, 'zstd')
  assert.equal(profile.capabilities.zstdPrivateSource, true)
})

test('cubic bounds include derivative extrema rather than control-box bounds', () => {
  const bounds = exactCubicBezierBounds(
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 100, y: 0 },
  )
  assert.equal(bounds.left, 0)
  assert.equal(bounds.right, 100)
  assert.ok(Math.abs(bounds.bottom - 75) < 1e-9)
})

test('byte-accounted LRU evicts the least recently used entries', () => {
  const cache = new ByteLruCache<string>(8)
  cache.set('a', 'A', 4)
  cache.set('b', 'B', 4)
  assert.equal(cache.get('a'), 'A')
  const evicted = cache.set('c', 'C', 4)
  assert.deepEqual(evicted.map((entry) => entry.key), ['b'])
  assert.deepEqual(cache.entries().map((entry) => entry.key), ['a', 'c'])
})

test('cooperative budget enforces operation and abort limits', () => {
  const budget = new CooperativeBudget({ maximumOperations: 2 })
  budget.checkpoint()
  budget.checkpoint()
  assert.throws(() => budget.checkpoint(), /budget/iu)
  const controller = new AbortController()
  controller.abort()
  assert.throws(
    () => new CooperativeBudget({ signal: controller.signal }).checkpoint(),
    /abort/iu,
  )
})

test('browser zstd adapter validates frame and decompressed byte limits', async () => {
  const provider = createBrowserZstdCodecProvider({
    decode: () => Uint8Array.of(1, 2),
  })
  const frame = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd)
  assert.deepEqual(
    [...await provider.zstdDecompress(frame, 2)],
    [1, 2],
  )
  await assert.rejects(
    () => provider.zstdDecompress(frame, 1),
    /limit/iu,
  )
  await assert.rejects(
    () => provider.zstdDecompress(Uint8Array.of(1, 2, 3, 4), 8),
    /magic/iu,
  )
})

test('modern artboard metadata retains UUID selection lock PAR ruler and bleed', () => {
  const source = [
    '%!PS-Adobe-3.0',
    '3 /Real (BleedTopValue)',
    '4 /Real (BleedRightValue)',
    '5 /Real (BleedBottomValue)',
    '6 /Real (BleedLeftValue)',
    '%_/Dictionary :',
    '0 100 /RealPointRelToROrigin %_ (PositionPoint1)',
    '200 0 /RealPointRelToROrigin %_ (PositionPoint2)',
    '10 20 /RealPoint %_ (RulerOrigin)',
    '%_ (Board\\040One) /UnicodeString (Name)',
    '%_ (uuid-1) /String (ArtboardUUID)',
    '%_ 1 /Bool (IsArtboardSelected)',
    '%_ 1 /Bool (IsArtboardLocked)',
    '%_ 1.25 /Real (PAR)',
    '(ArtboardArray)',
    '%%EOF',
  ].join('\n')
  const artboards = extractNativeArtboards(source)
  assert.equal(artboards.length, 1)
  assert.equal(artboards[0]?.name, 'Board One')
  assert.equal(artboards[0]?.uuid, 'uuid-1')
  assert.equal(artboards[0]?.selected, true)
  assert.equal(artboards[0]?.locked, true)
  assert.equal(artboards[0]?.pixelAspectRatio, 1.25)
  assert.deepEqual(artboards[0]?.rulerOrigin, { x: 10, y: 20 })
  assert.deepEqual(artboards[0]?.bleed, {
    top: 3,
    right: 4,
    bottom: 5,
    left: 6,
  })
})

test('lossless AST statements are classified into source sections without rewriting raw data', () => {
  const ast = {
    statements: [
      { kind: 'comment', raw: '%%BeginProlog\n', span: { start: 0, end: 14 } },
      { kind: 'operator', operator: 'def', raw: '/x 1 def\n', span: { start: 14, end: 23 } },
      { kind: 'comment', raw: '%%EndProlog\n', span: { start: 23, end: 35 } },
      { kind: 'operator', operator: 'm', raw: '0 0 m\n', span: { start: 35, end: 41 } },
      { kind: 'comment', raw: '%%Trailer\n', span: { start: 41, end: 51 } },
      { kind: 'comment', raw: '%%EOF\n', span: { start: 51, end: 57 } },
    ],
  }
  const sections = classifyNativeSourceSections(ast)
  assert.ok(sections.sections.some((entry) => entry.kind === 'prolog'))
  assert.ok(sections.sections.some((entry) => entry.kind === 'drawing'))
  assert.ok(sections.sections.some((entry) => entry.kind === 'trailer'))
})

test('resource graph and resource decoders retain gradient pattern raster and advanced identities', () => {
  const ast = {
    statements: [
      {
        kind: 'operator',
        operator: 'Bd',
        operands: [{ value: 'Gradient A' }, 0],
        raw: '(Gradient A) 0 Bd\n',
      },
      {
        kind: 'operator',
        operator: 'noop',
        operands: [],
        raw: '0 0.5 %_BS\n1 0.5 %_BS\n',
      },
      { kind: 'operator', operator: 'BD', operands: [], raw: 'BD\n' },
      {
        kind: 'operator',
        operator: 'PB',
        operands: [{ value: 'Pattern A' }, 1, 1, 0, 0, 20, 20],
        raw: '(Pattern A) 1 1 0 0 20 20 PB\n',
      },
      { kind: 'operator', operator: 'PE', operands: [], raw: 'PE\n' },
      {
        kind: 'operator',
        operator: 'XI',
        operands: [32, 16, 8, { value: 'DeviceRGB' }],
        raw: '32 16 8 /DeviceRGB XI\n',
      },
      {
        kind: 'operator',
        operator: 'AI9_BeginSymbol',
        operands: [{ value: 'Symbol A' }],
        raw: '(Symbol A) AI9_BeginSymbol\n',
      },
      {
        kind: 'operator',
        operator: 'AI9_EndSymbol',
        operands: [],
        raw: 'AI9_EndSymbol\n',
      },
    ],
  }
  const graph = buildNativeResourceGraph(ast)
  const decoded = decodeNativeResources('%!PS-Adobe-3.0\n', ast, graph)
  const kinds = new Set(graph.values().map((entry) => entry.kind))
  assert.equal(kinds.has('gradient'), true)
  assert.equal(kinds.has('pattern'), true)
  assert.equal(kinds.has('embedded-raster'), true)
  assert.equal(kinds.has('symbol'), true)
  assert.equal(decoded.gradients.length, 1)
  assert.equal(decoded.gradients[0]?.stops.length, 2)
  assert.equal(decoded.patterns.length, 1)
  assert.equal(decoded.rasters.length, 1)
  const advanced = buildNativeAdvancedObjectModel(ast, { children: [] }, graph)
  assert.ok(advanced.objects.some((entry) => entry.kind === 'symbol-definition'))
})

test('text transparency and advanced object models retain structure and downgrade unsupported layout', () => {
  const scene = {
    children: [
      {
        id: 'area-text',
        type: 'Text',
        textKind: 'area',
        storyId: 'story-1',
        runs: [{
          text: 'Hello',
          fontPostScriptName: 'ExamplePS',
          fontSize: 12,
        }],
      },
      {
        id: 'effect-1',
        type: 'LiveEffect',
        appearance: {
          opacity: 0.5,
          blendMode: 'multiply',
          maskResourceId: 'mask-1',
        },
        children: [],
      },
    ],
  }
  const text = buildNativeTextModel(scene)
  assert.equal(text.frames[0]?.kind, 'area')
  assert.deepEqual(text.requiredFonts, ['ExamplePS'])
  assert.equal(text.frames[0]?.fidelity, 'structure-only')
  const transparency = buildNativeTransparencyModel(scene)
  assert.equal(transparency.records[0]?.blendMode, 'multiply')
  assert.equal(transparency.records[0]?.maskResourceId, 'mask-1')
  const advanced = buildNativeAdvancedObjectModel(
    { statements: [] },
    scene,
    buildNativeResourceGraph({ statements: [] }),
  )
  assert.ok(advanced.objects.some((entry) => entry.kind === 'live-effect'))
})

test('shared render plan preserves clip ordering and SVG safety', () => {
  const clipGeometry = {
    fillRule: 'evenodd',
    contours: [{
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    }],
  }
  const pathGeometry = {
    contours: [{
      closed: false,
      points: [
        { x: 10, y: 10 },
        { x: 90, y: 90 },
      ],
    }],
  }
  const scene = {
    children: [
      {
        id: 'clip-group',
        type: 'ClipGroup',
        children: [
          {
            id: 'clip-path',
            type: 'Path',
            clippingPath: true,
            geometry: clipGeometry,
          },
          {
            id: 'painted-path',
            type: 'Path',
            geometry: pathGeometry,
            appearance: {
              fills: [{ paint: { kind: 'rgb', red: 1, green: 0, blue: 0 } }],
            },
          },
        ],
      },
      {
        id: 'unknown',
        type: 'UnknownNode',
        operator: 'vendorVisibleOperator',
      },
    ],
  }
  const first = buildNativeRenderPlan(scene)
  const second = buildNativeRenderPlan(scene)
  assert.equal(first.deterministicHash, second.deterministicHash)
  const beginClip = first.operations.findIndex((entry) => entry.kind === 'begin-clip')
  const path = first.operations.findIndex((entry) => entry.kind === 'path')
  const endClip = first.operations.findIndex((entry) => entry.kind === 'end-clip')
  assert.ok(beginClip >= 0 && path > beginClip && endClip > path)
  assert.ok(first.operations.some((entry) => entry.kind === 'unsupported'))
  const svg = renderNativePlanToSvg(first, {
    namespace: 'safe<script>',
  })
  assert.match(svg, /<path[^>]+d="M10 10 L90 90"/u)
  assert.match(svg, /unsupported:operator:vendorVisibleOperator/u)
  assert.doesNotMatch(svg, /<script|javascript:|foreignObject/iu)
})

test('external resources require an explicit resolver and obey byte limits', async () => {
  await assert.rejects(
    () => resolveNativeResource({
      id: 'placed-1',
      url: 'https://example.invalid/image.png',
    }),
    /denied|resolver/iu,
  )
  const resolved = await resolveNativeResource(
    { id: 'placed-1' },
    {
      policy: 'resolver-only',
      maximumBytes: 2,
      resolve: async () => Uint8Array.of(1, 2),
    },
  )
  assert.deepEqual([...resolved.bytes], [1, 2])
  await assert.rejects(
    () => resolveNativeResource(
      { id: 'too-large' },
      {
        maximumBytes: 1,
        resolve: async () => Uint8Array.of(1, 2),
      },
    ),
    /limit/iu,
  )
})

test('security inventory records active operators and deterministic malicious mutations', () => {
  const report = scanNativeSourceSecurity(
    '%!PS-Adobe-3.0\n(http://example.invalid/a) (r) file\n%%EOF\n',
  )
  assert.equal(report.safeToParse, true)
  assert.ok(report.activeContentIndicators.includes('PostScript file operator'))
  assert.deepEqual(report.externalReferences, ['http://example.invalid/a'])
  const mutations = createDeterministicNativeMutations('abc', 12)
  assert.equal(mutations.length, 11)
  assert.equal(mutations[0]?.description, 'empty input')
})

test('Oracle manifests and RGBA thresholds produce machine-readable evidence', () => {
  const manifest = {
    schemaVersion: 1 as const,
    fixtureId: 'ai24-gradient',
    illustratorVersion: '24.0',
    extension: 'ai' as const,
    license: 'internal-test-only',
    sourceSha256: 'a'.repeat(64),
    structureOracle: {
      artboards: 1,
      layers: 1,
      paths: 1,
    },
  }
  assert.deepEqual(validateNativeOracleManifest(manifest), [])
  const scene = {
    fidelity: 'partial',
    artboards: [{}],
    children: [{
      type: 'Layer',
      children: [{ type: 'Path', children: [] }],
    }],
  }
  const snapshot = nativeStructureSnapshot(scene)
  assert.deepEqual(
    compareNativeStructureOracle(snapshot, manifest.structureOracle),
    [],
  )
  const expected = Uint8Array.of(0, 0, 0, 255)
  const actual = Uint8Array.of(1, 1, 1, 255)
  const diff = compareNativeRgbaOracle(actual, expected, 1, 1, {
    channelThreshold: 2,
  })
  assert.equal(diff.passed, true)
})

test('public native session executes the complete existing container AST semantic and render chain', async () => {
  const session = await openNativeIllustratorDocument(DIRECT_SOURCE_BYTES)
  assert.equal(session.disposed, false)
  assert.ok(session.analysis.sourceBytes.byteLength > 0)
  assert.ok(session.analysis.ast.statements.length > 0)
  assert.ok(session.analysis.artboards.length >= 1)
  assert.match(session.toSvg(), /^<svg\b/u)
  assert.equal(session.resourceCacheStats().entries, 0)
  session.dispose()
  assert.equal(session.disposed, true)
  assert.throws(() => session.summary(), /disposed/iu)
})
