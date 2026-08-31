import {
  asNativeRecord,
  nativeNumber,
  walkNativeScene,
} from './native-common.js'
import {
  isNativeFidelity,
  type NativeFidelity,
  type NativeFidelityEvidence,
} from './native-fidelity.js'
import type { NativeResourceGraph } from './native-resources.js'

export interface NativeOracleManifest {
  schemaVersion: 1
  fixtureId: string
  illustratorVersion: string
  extension: 'ai' | 'ait'
  license: string
  sourceSha256: string
  structureOracle?: Readonly<{
    artboards?: number
    layers?: number
    groups?: number
    paths?: number
    compoundPaths?: number
    clipGroups?: number
    textFrames?: number
    rasterImages?: number
    placedArt?: number
    resources?: number
    requiredFonts?: readonly string[]
    fidelity?: NativeFidelity
  }>
  visualOracle?: Readonly<{
    renderer: string
    width: number
    height: number
    pixelSha256?: string
    channelThreshold?: number
    maximumDifferentPixelRatio?: number
    maximumMeanChannelDelta?: number
  }>
  notes?: string
}

export interface NativeStructureSnapshot {
  artboards: number
  layers: number
  groups: number
  paths: number
  compoundPaths: number
  clipGroups: number
  textFrames: number
  rasterImages: number
  placedArt: number
  resources: number
  requiredFonts: readonly string[]
  fidelity: NativeFidelity
}

export interface NativeVisualDiffResult {
  width: number
  height: number
  pixels: number
  differentPixels: number
  differentPixelRatio: number
  meanChannelDelta: number
  maximumChannelDelta: number
  passed: boolean
  diagnostics: readonly string[]
}

export interface NativeOracleEvaluation {
  fixtureId: string
  structureDiagnostics: readonly string[]
  visual?: NativeVisualDiffResult
  passed: boolean
  evidence: readonly NativeFidelityEvidence[]
}

export function validateNativeOracleManifest(
  value: unknown,
): readonly string[] {
  const diagnostics: string[] = []
  const manifest = asNativeRecord(value)
  if (manifest?.schemaVersion !== 1) {
    diagnostics.push('schemaVersion must equal 1.')
  }
  for (const field of [
    'fixtureId',
    'illustratorVersion',
    'license',
    'sourceSha256',
  ] as const) {
    const fieldValue = manifest?.[field]
    if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
      diagnostics.push(`${field} must be a non-empty string.`)
    }
  }
  if (manifest?.extension !== 'ai' && manifest?.extension !== 'ait') {
    diagnostics.push('extension must be ai or ait.')
  }
  if (
    typeof manifest?.sourceSha256 === 'string'
    && !/^[a-f0-9]{64}$/iu.test(manifest.sourceSha256)
  ) {
    diagnostics.push(
      'sourceSha256 must be a 64-character hexadecimal SHA-256 digest.',
    )
  }
  const structure = asNativeRecord(manifest?.structureOracle)
  if (structure !== undefined) {
    for (const field of [
      'artboards',
      'layers',
      'groups',
      'paths',
      'compoundPaths',
      'clipGroups',
      'textFrames',
      'rasterImages',
      'placedArt',
      'resources',
    ] as const) {
      const fieldValue = structure[field]
      if (
        fieldValue !== undefined
        && (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 0)
      ) {
        diagnostics.push(
          `structureOracle.${field} must be a non-negative integer.`,
        )
      }
    }
    if (
      structure.fidelity !== undefined
      && !isNativeFidelity(structure.fidelity)
    ) {
      diagnostics.push('structureOracle.fidelity is invalid.')
    }
    if (
      structure.requiredFonts !== undefined
      && !Array.isArray(structure.requiredFonts)
    ) {
      diagnostics.push('structureOracle.requiredFonts must be an array.')
    }
  }
  const visual = asNativeRecord(manifest?.visualOracle)
  if (visual !== undefined) {
    if (typeof visual.renderer !== 'string' || visual.renderer.trim() === '') {
      diagnostics.push('visualOracle.renderer is required.')
    }
    for (const field of ['width', 'height'] as const) {
      const fieldValue = visual[field]
      if (!Number.isSafeInteger(fieldValue) || (fieldValue as number) <= 0) {
        diagnostics.push(`visualOracle.${field} must be a positive integer.`)
      }
    }
    for (const field of [
      'channelThreshold',
      'maximumDifferentPixelRatio',
      'maximumMeanChannelDelta',
    ] as const) {
      const fieldValue = visual[field]
      if (
        fieldValue !== undefined
        && (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue))
      ) {
        diagnostics.push(`visualOracle.${field} must be finite.`)
      }
    }
  }
  return diagnostics
}

function sceneFidelity(scene: unknown): NativeFidelity {
  const record = asNativeRecord(scene)
  return isNativeFidelity(record?.fidelity)
    ? record.fidelity
    : 'structure-only'
}

export function nativeStructureSnapshot(
  scene: unknown,
  resources?: NativeResourceGraph,
  requiredFonts: readonly string[] = [],
): NativeStructureSnapshot {
  const counts = {
    layers: 0,
    groups: 0,
    paths: 0,
    compoundPaths: 0,
    clipGroups: 0,
    textFrames: 0,
    rasterImages: 0,
    placedArt: 0,
  }
  walkNativeScene(scene, (node) => {
    if (node.type === 'Layer') counts.layers++
    else if (node.type === 'Group') counts.groups++
    else if (node.type === 'Path') counts.paths++
    else if (node.type === 'CompoundPath') counts.compoundPaths++
    else if (node.type === 'ClipGroup') counts.clipGroups++
    else if (node.type === 'Text') counts.textFrames++
    else if (node.type === 'RasterImage') counts.rasterImages++
    else if (node.type === 'PlacedArt') counts.placedArt++
  })
  const record = asNativeRecord(scene)
  const artboards = Array.isArray(record?.artboards)
    ? record.artboards.length
    : 0
  const sceneResources = asNativeRecord(record?.resources)
  return {
    artboards,
    ...counts,
    resources: resources?.values().length
      ?? (sceneResources === undefined ? 0 : Object.keys(sceneResources).length),
    requiredFonts: [...new Set(requiredFonts)].sort(),
    fidelity: sceneFidelity(scene),
  }
}

export function compareNativeStructureOracle(
  actual: NativeStructureSnapshot,
  expected: NonNullable<NativeOracleManifest['structureOracle']>,
): readonly string[] {
  const diagnostics: string[] = []
  for (const field of [
    'artboards',
    'layers',
    'groups',
    'paths',
    'compoundPaths',
    'clipGroups',
    'textFrames',
    'rasterImages',
    'placedArt',
    'resources',
  ] as const) {
    const expectation = expected[field]
    if (expectation !== undefined && actual[field] !== expectation) {
      diagnostics.push(
        `${field}: expected ${expectation}, received ${actual[field]}.`,
      )
    }
  }
  if (expected.requiredFonts !== undefined) {
    const left = [...actual.requiredFonts].sort().join('\n')
    const right = [...expected.requiredFonts].sort().join('\n')
    if (left !== right) {
      diagnostics.push(
        `requiredFonts: expected [${expected.requiredFonts.join(', ')}], received [${actual.requiredFonts.join(', ')}].`,
      )
    }
  }
  if (expected.fidelity !== undefined && actual.fidelity !== expected.fidelity) {
    diagnostics.push(
      `fidelity: expected ${expected.fidelity}, received ${actual.fidelity}.`,
    )
  }
  return diagnostics
}

export function compareNativeRgbaOracle(
  actual: Uint8Array,
  expected: Uint8Array,
  width: number,
  height: number,
  options: Readonly<{
    channelThreshold?: number
    maximumDifferentPixelRatio?: number
    maximumMeanChannelDelta?: number
  }> = {},
): NativeVisualDiffResult {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError('width must be a positive integer.')
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError('height must be a positive integer.')
  }
  const required = width * height * 4
  if (actual.byteLength !== required || expected.byteLength !== required) {
    throw new RangeError(
      `RGBA buffers must contain exactly ${required} bytes.`,
    )
  }
  const channelThreshold = Math.max(0, Math.min(255,
    options.channelThreshold ?? 8,
  ))
  const maximumDifferentPixelRatio = Math.max(0, Math.min(1,
    options.maximumDifferentPixelRatio ?? 0.001,
  ))
  const maximumMeanChannelDelta = Math.max(0, Math.min(255,
    options.maximumMeanChannelDelta ?? 1,
  ))
  let differentPixels = 0
  let sumDelta = 0
  let maximumChannelDelta = 0
  for (let pixel = 0; pixel < width * height; pixel++) {
    let pixelDifferent = false
    for (let channel = 0; channel < 4; channel++) {
      const index = pixel * 4 + channel
      const delta = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0))
      sumDelta += delta
      maximumChannelDelta = Math.max(maximumChannelDelta, delta)
      if (delta > channelThreshold) pixelDifferent = true
    }
    if (pixelDifferent) differentPixels++
  }
  const pixels = width * height
  const differentPixelRatio = differentPixels / pixels
  const meanChannelDelta = sumDelta / required
  const diagnostics: string[] = []
  if (differentPixelRatio > maximumDifferentPixelRatio) {
    diagnostics.push(
      `Different pixel ratio ${differentPixelRatio} exceeds ${maximumDifferentPixelRatio}.`,
    )
  }
  if (meanChannelDelta > maximumMeanChannelDelta) {
    diagnostics.push(
      `Mean channel delta ${meanChannelDelta} exceeds ${maximumMeanChannelDelta}.`,
    )
  }
  return {
    width,
    height,
    pixels,
    differentPixels,
    differentPixelRatio,
    meanChannelDelta,
    maximumChannelDelta,
    passed: diagnostics.length === 0,
    diagnostics,
  }
}

export function evaluateNativeOracle(
  manifest: NativeOracleManifest,
  actual: NativeStructureSnapshot,
  visual?: Readonly<{
    actual: Uint8Array
    expected: Uint8Array
  }>,
): NativeOracleEvaluation {
  const manifestDiagnostics = validateNativeOracleManifest(manifest)
  const structureDiagnostics = manifest.structureOracle === undefined
    ? ['No structure Oracle is declared.']
    : compareNativeStructureOracle(actual, manifest.structureOracle)
  const visualResult = manifest.visualOracle === undefined || visual === undefined
    ? undefined
    : compareNativeRgbaOracle(
        visual.actual,
        visual.expected,
        manifest.visualOracle.width,
        manifest.visualOracle.height,
        {
          channelThreshold: nativeNumber(manifest.visualOracle.channelThreshold),
          maximumDifferentPixelRatio: nativeNumber(
            manifest.visualOracle.maximumDifferentPixelRatio,
          ),
          maximumMeanChannelDelta: nativeNumber(
            manifest.visualOracle.maximumMeanChannelDelta,
          ),
        },
      )
  const structurePassed = manifestDiagnostics.length === 0
    && structureDiagnostics.length === 0
  const visualPassed = manifest.visualOracle === undefined
    ? true
    : visualResult?.passed === true
  const evidence: NativeFidelityEvidence[] = [
    {
      id: `${manifest.fixtureId}:real-fixture`,
      kind: 'real-illustrator-fixture',
      status: manifestDiagnostics.length === 0 ? 'passed' : 'failed',
      versions: [manifest.illustratorVersion],
      source: manifest.fixtureId,
    },
    {
      id: `${manifest.fixtureId}:structure`,
      kind: 'structure-oracle',
      status: manifest.structureOracle === undefined
        ? 'missing'
        : structurePassed
          ? 'passed'
          : 'failed',
      versions: [manifest.illustratorVersion],
      source: manifest.fixtureId,
      notes: structureDiagnostics.join(' '),
    },
    {
      id: `${manifest.fixtureId}:visual`,
      kind: 'visual-oracle',
      status: manifest.visualOracle === undefined || visual === undefined
        ? 'missing'
        : visualPassed
          ? 'passed'
          : 'failed',
      versions: [manifest.illustratorVersion],
      source: manifest.fixtureId,
      notes: visualResult?.diagnostics.join(' '),
    },
  ]
  return {
    fixtureId: manifest.fixtureId,
    structureDiagnostics: [
      ...manifestDiagnostics,
      ...structureDiagnostics,
    ],
    ...(visualResult === undefined ? {} : { visual: visualResult }),
    passed: structurePassed && visualPassed,
    evidence,
  }
}
