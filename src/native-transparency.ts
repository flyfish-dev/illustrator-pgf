import {
  asNativeRecord,
  nativeBoolean,
  nativeNumber,
  nativeString,
  walkNativeScene,
} from './native-common.js'
import type { NativeFidelity } from './native-fidelity.js'

export interface NativeTransparencyRecord {
  id: string
  nodeId?: string
  opacity: number
  fillOpacity: number
  strokeOpacity: number
  blendMode: string
  isolated: boolean
  knockout: boolean
  maskResourceId?: string
  maskMode?: 'alpha' | 'luminosity' | 'unknown'
  fidelity: NativeFidelity
}

export interface NativeTransparencyModel {
  records: readonly NativeTransparencyRecord[]
  diagnostics: readonly string[]
}

export function buildNativeTransparencyModel(
  scene: unknown,
): NativeTransparencyModel {
  const records: NativeTransparencyRecord[] = []
  const diagnostics: string[] = []
  walkNativeScene(scene, (node) => {
    const appearance = asNativeRecord(node.appearance)
    const opacity = nativeNumber(appearance?.opacity)
      ?? nativeNumber(node.opacity)
      ?? 1
    const fillOpacity = nativeNumber(appearance?.fillOpacity) ?? opacity
    const strokeOpacity = nativeNumber(appearance?.strokeOpacity) ?? opacity
    const blendMode = nativeString(appearance?.blendMode)
      ?? nativeString(node.blendMode)
      ?? 'normal'
    const isolated = nativeBoolean(appearance?.isolated)
      ?? nativeBoolean(node.isolated)
      ?? false
    const knockout = nativeBoolean(appearance?.knockout)
      ?? nativeBoolean(node.knockout)
      ?? false
    const maskResourceId = typeof appearance?.maskResourceId === 'string'
      ? appearance.maskResourceId
      : typeof node.maskResourceId === 'string'
        ? node.maskResourceId
        : undefined
    const rawMaskMode = nativeString(appearance?.maskMode)
      ?? nativeString(node.maskMode)
    const maskMode: NativeTransparencyRecord['maskMode'] = rawMaskMode === 'alpha'
      || rawMaskMode === 'luminosity'
      ? rawMaskMode
      : rawMaskMode === undefined
        ? undefined
        : 'unknown'
    if (
      opacity === 1
      && fillOpacity === 1
      && strokeOpacity === 1
      && blendMode === 'normal'
      && !isolated
      && !knockout
      && maskResourceId === undefined
    ) return
    const nodeId = typeof node.id === 'string' ? node.id : undefined
    const fidelity: NativeFidelity = maskResourceId === undefined
      && !knockout
      && !isolated
      ? 'partial'
      : 'structure-only'
    records.push({
      id: `transparency:${nodeId ?? records.length}`,
      ...(nodeId === undefined ? {} : { nodeId }),
      opacity,
      fillOpacity,
      strokeOpacity,
      blendMode,
      isolated,
      knockout,
      ...(maskResourceId === undefined ? {} : { maskResourceId }),
      ...(maskMode === undefined ? {} : { maskMode }),
      fidelity,
    })
    if (maskResourceId !== undefined) {
      diagnostics.push(
        `Opacity mask ${maskResourceId} is preserved structurally and requires compositing Oracle evidence.`,
      )
    }
    if (knockout) {
      diagnostics.push(
        `Knockout group ${nodeId ?? records.length - 1} is preserved but remains structure-only.`,
      )
    }
  })
  return { records, diagnostics }
}

export function canvasCompositeOperationForBlendMode(
  blendMode: string,
): GlobalCompositeOperation | undefined {
  const normalized = blendMode.trim().toLowerCase().replace(/[ _]/gu, '-')
  const supported: Readonly<Record<string, GlobalCompositeOperation>> = {
    normal: 'source-over',
    multiply: 'multiply',
    screen: 'screen',
    overlay: 'overlay',
    darken: 'darken',
    lighten: 'lighten',
    'color-dodge': 'color-dodge',
    'color-burn': 'color-burn',
    'hard-light': 'hard-light',
    'soft-light': 'soft-light',
    difference: 'difference',
    exclusion: 'exclusion',
    hue: 'hue',
    saturation: 'saturation',
    color: 'color',
    luminosity: 'luminosity',
  }
  return supported[normalized]
}
