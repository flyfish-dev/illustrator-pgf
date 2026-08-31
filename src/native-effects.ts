import {
  asNativeRecord,
  nativeAstStatements,
  nativeFNV1a,
  stableNativeSerialize,
  walkNativeScene,
} from './native-common.js'
import type { NativeFidelity } from './native-fidelity.js'
import type { NativeResourceGraph, NativeResourceKind } from './native-resources.js'

export type NativeAdvancedObjectKind =
  | 'symbol-definition'
  | 'symbol-instance'
  | 'brush-definition'
  | 'brush-stroke'
  | 'live-effect'
  | 'plugin-object'
  | 'expanded-fallback'

export interface NativeAdvancedObjectRecord {
  id: string
  kind: NativeAdvancedObjectKind
  nodeId?: string
  resourceId?: string
  operator?: string
  parameters: unknown
  hasExpandedFallback: boolean
  fallbackNodeIds: readonly string[]
  visibleImpact: boolean
  fidelity: NativeFidelity
}

export interface NativeAdvancedObjectModel {
  objects: readonly NativeAdvancedObjectRecord[]
  diagnostics: readonly string[]
}

function advancedKindForResource(
  kind: NativeResourceKind,
): NativeAdvancedObjectKind | undefined {
  if (kind === 'symbol') return 'symbol-definition'
  if (kind === 'brush') return 'brush-definition'
  if (kind === 'effect') return 'live-effect'
  return undefined
}

function fallbackIds(node: Record<string, unknown>): string[] {
  const candidates = [
    node.expandedAppearance,
    node.fallbackAppearance,
    node.fallback,
    node.appearanceFallback,
  ]
  const result: string[] = []
  for (const candidate of candidates) {
    const record = asNativeRecord(candidate)
    if (typeof record?.id === 'string') result.push(record.id)
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const itemRecord = asNativeRecord(item)
        if (typeof itemRecord?.id === 'string') result.push(itemRecord.id)
      }
    }
  }
  return [...new Set(result)]
}

function sceneAdvancedKind(
  node: Record<string, unknown>,
): NativeAdvancedObjectKind | undefined {
  if (node.type === 'SymbolInstance') return 'symbol-instance'
  if (node.type === 'BrushStroke') return 'brush-stroke'
  if (node.type === 'LiveEffect' || node.type === 'Effect') return 'live-effect'
  if (node.type === 'PluginObject') return 'plugin-object'
  return undefined
}

export function buildNativeAdvancedObjectModel(
  ast: unknown,
  scene: unknown,
  resources: NativeResourceGraph,
): NativeAdvancedObjectModel {
  const objects: NativeAdvancedObjectRecord[] = []
  const diagnostics: string[] = []

  for (const resource of resources.values()) {
    const kind = advancedKindForResource(resource.kind)
    if (kind === undefined) continue
    objects.push({
      id: `advanced:${resource.id}`,
      kind,
      resourceId: resource.id,
      parameters: resource.metadata,
      hasExpandedFallback: false,
      fallbackNodeIds: [],
      visibleImpact: kind !== 'symbol-definition' && kind !== 'brush-definition',
      fidelity: resource.fidelity,
    })
  }

  walkNativeScene(scene, (node) => {
    const kind = sceneAdvancedKind(node)
    if (kind === undefined) return
    const id = typeof node.id === 'string'
      ? node.id
      : nativeFNV1a(stableNativeSerialize(node))
    const fallbacks = fallbackIds(node)
    const resourceId = typeof node.resourceId === 'string'
      ? node.resourceId
      : typeof node.symbolId === 'string'
        ? node.symbolId
        : typeof node.brushId === 'string'
          ? node.brushId
          : undefined
    const hasExpandedFallback = fallbacks.length > 0
      || Array.isArray(node.children) && node.children.length > 0
    const fidelity: NativeFidelity = hasExpandedFallback
      ? 'partial'
      : 'structure-only'
    objects.push({
      id: `advanced-node:${id}`,
      kind,
      nodeId: id,
      ...(resourceId === undefined ? {} : { resourceId }),
      parameters: node.parameters ?? node.effectParameters ?? node,
      hasExpandedFallback,
      fallbackNodeIds: fallbacks,
      visibleImpact: node.visible !== false,
      fidelity,
    })
    if (!hasExpandedFallback && node.visible !== false) {
      diagnostics.push(
        `${kind} ${id} has no expanded appearance; it remains structure-only.`,
      )
    }
  })

  nativeAstStatements(ast).forEach((statement, statementIndex) => {
    const record = asNativeRecord(statement)
    if (record?.kind !== 'operator' || typeof record.operator !== 'string') return
    if (!/(?:plugin|liveeffect|effect|symbol|brush)/iu.test(record.operator)) return
    const known = objects.some((entry) => entry.operator === record.operator)
    if (known) return
    const raw = typeof record.raw === 'string'
      ? record.raw
      : stableNativeSerialize(statement)
    const plugin = /plugin/iu.test(record.operator)
    objects.push({
      id: `advanced-operator:${nativeFNV1a(`${statementIndex}:${raw}`)}`,
      kind: plugin ? 'plugin-object' : 'live-effect',
      operator: record.operator,
      parameters: Array.isArray(record.operands) ? record.operands : [],
      hasExpandedFallback: false,
      fallbackNodeIds: [],
      visibleImpact: true,
      fidelity: 'structure-only',
    })
    diagnostics.push(
      `${record.operator} is preserved losslessly; no executable plugin or effect code is run.`,
    )
  })

  return { objects, diagnostics }
}
