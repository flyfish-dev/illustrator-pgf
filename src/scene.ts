import type {
  Bounds,
  IllustratorAppearance,
  IllustratorDiagnostic,
  IllustratorDocumentSummary,
  IllustratorFidelity,
  IllustratorPaint,
  IllustratorSceneDocument,
  IllustratorSceneNode,
  IllustratorSupportReport,
  IllustratorUnsupportedFeature,
  Matrix,
} from './types.js'
import { IllustratorError } from './errors.js'
import { IDENTITY_MATRIX, unionBounds } from './util.js'

export const NONE_PAINT: IllustratorPaint = Object.freeze({ kind: 'none' })
export const BLACK_PAINT: IllustratorPaint = Object.freeze({ kind: 'gray', gray: 0, alpha: 1 })
export const WHITE_PAINT: IllustratorPaint = Object.freeze({ kind: 'gray', gray: 1, alpha: 1 })

export function cloneMatrix(matrix: Matrix = IDENTITY_MATRIX): Matrix { return { ...matrix } }

export function emptyAppearance(): IllustratorAppearance {
  return { fills: [], strokes: [], opacity: 1, blendMode: 'normal', knockout: false, isolated: false, effects: [], source: 'native' }
}

const fidelityRank: Record<IllustratorFidelity, number> = { exact: 4, high: 3, partial: 2, 'structure-only': 1, unsupported: 0 }
export function lowerFidelity(left: IllustratorFidelity, right: IllustratorFidelity): IllustratorFidelity {
  return fidelityRank[left] <= fidelityRank[right] ? left : right
}

export function walkSceneNodes(document: IllustratorSceneDocument, visitor: (node: IllustratorSceneNode) => void): void {
  const visit = (node: IllustratorSceneNode): void => {
    visitor(node)
    if (node.type === 'Layer' || node.type === 'Group' || node.type === 'ClipGroup' || node.type === 'SymbolDefinition') for (const child of node.children) visit(child)
  }
  for (const node of document.children) visit(node)
}

export function sceneBounds(document: IllustratorSceneDocument): Bounds | undefined {
  let bounds: Bounds | undefined
  walkSceneNodes(document, (node) => { if (node.visible) bounds = unionBounds(bounds, node.bounds) })
  return bounds
}

export function validateIllustratorScene(document: IllustratorSceneDocument): void {
  const ids = new Set<string>()
  const visit = (node: IllustratorSceneNode, parentId?: string, layerId?: string): void => {
    if (ids.has(node.id)) throw new IllustratorError('AI_SCENE_DUPLICATE_ID', 'lower', `Scene node ID ${node.id} is duplicated.`)
    ids.add(node.id)
    if (node.parentId !== parentId) throw new IllustratorError('AI_SCENE_PARENT_MISMATCH', 'lower', `Scene node ${node.id} has parent ${node.parentId ?? '(none)'}, expected ${parentId ?? '(none)'}.`)
    const expectedLayer = node.type === 'Layer' ? node.id : layerId
    if (node.layerId !== undefined && node.layerId !== expectedLayer) throw new IllustratorError('AI_SCENE_LAYER_MISMATCH', 'lower', `Scene node ${node.id} has inconsistent layer ownership.`)
    if (node.type === 'Layer' || node.type === 'Group' || node.type === 'ClipGroup' || node.type === 'SymbolDefinition') for (const child of node.children) visit(child, node.id, expectedLayer)
  }
  for (const node of document.children) visit(node)
  const layerIds = new Set(document.layers.map((layer) => layer.id))
  for (const id of layerIds) if (!ids.has(id)) throw new IllustratorError('AI_SCENE_LAYER_ORPHAN', 'lower', `Layer ${id} is not present in the scene tree.`)
}

export function getIllustratorDocumentSummary(document: IllustratorSceneDocument): IllustratorDocumentSummary {
  let nodes = 0; let paths = 0; let textFrames = 0
  walkSceneNodes(document, (node) => { nodes++; if (node.type === 'Path' || node.type === 'CompoundPath') paths++; else if (node.type === 'Text') textFrames++ })
  return {
    sourceKind: document.sourceFingerprint.sourceKind,
    artboards: document.artboards.length,
    layers: document.layers.length,
    nodes,
    paths,
    textFrames,
    resources: Object.keys(document.resources).length,
    fidelity: document.fidelity,
    ...(sceneBounds(document) === undefined ? {} : { bounds: sceneBounds(document) }),
    sourceFingerprint: document.sourceFingerprint,
  }
}

function featureBucket(feature: IllustratorUnsupportedFeature): 'partial' | 'structure' | 'unsupported' {
  return feature.fidelity === 'partial' ? 'partial' : feature.fidelity === 'structure-only' ? 'structure' : 'unsupported'
}

export function createIllustratorSupportReport(document: IllustratorSceneDocument): IllustratorSupportReport {
  const unknownOperators: Record<string, number> = {}
  walkSceneNodes(document, (node) => {
    if (node.type === 'UnknownNode' && node.operator !== undefined) unknownOperators[node.operator] = (unknownOperators[node.operator] ?? 0) + 1
  })
  const partial = new Set<string>()
  const structure = new Set<string>()
  for (const feature of document.unsupportedFeatures) {
    const bucket = featureBucket(feature)
    if (bucket === 'partial') partial.add(feature.feature)
    else if (bucket === 'structure') structure.add(feature.feature)
  }
  const exactFeatures = ['lossless-token-order', 'source-spans', 'unknown-syntax-preservation']
  const highFeatures = ['basic-path-geometry', 'compound-paths', 'groups', 'layers', 'process-color', 'stroke-geometry', 'shared-canvas-artboards']
  return {
    fidelity: document.fidelity,
    exactFeatures,
    highFeatures,
    partialFeatures: [...partial].sort(),
    structureOnlyFeatures: [...structure].sort(),
    unsupportedFeatures: document.unsupportedFeatures,
    unknownOperators,
    diagnostics: document.diagnostics,
  }
}

export function collectDiagnostics(document: IllustratorSceneDocument): readonly IllustratorDiagnostic[] {
  const output = [...document.diagnostics]
  walkSceneNodes(document, (node) => output.push(...node.diagnostics))
  return output
}
