import { latin1SourceText } from './native-common.js'

export type IllustratorVersionFamily =
  | 'ai3'
  | 'ai5'
  | 'ai8'
  | 'ai9'
  | 'ai12'
  | 'ai24'
  | 'future'
  | 'unknown'

export interface IllustratorVersionCapabilities {
  layers: boolean
  liveText: boolean
  transparency: boolean
  multipleArtboards: boolean
  zstdPrivateSource: boolean
}

export interface IllustratorVersionProfile {
  family: IllustratorVersionFamily
  major?: number
  creator?: string
  fileFormat?: string
  privateCompression: 'none' | 'deflate' | 'zstd' | 'unknown'
  capabilities: IllustratorVersionCapabilities
  diagnostics: readonly string[]
}

export interface IllustratorOperatorVersionRule {
  operator: string
  minimumMajor?: number
  maximumMajor?: number
  aliases?: readonly string[]
  feature: string
}

function firstMatch(source: string, expressions: readonly RegExp[]): string | undefined {
  for (const expression of expressions) {
    const match = expression.exec(source)
    if (match?.[1] !== undefined) return match[1].trim()
  }
  return undefined
}

function familyFor(major: number | undefined): IllustratorVersionFamily {
  if (major === undefined || !Number.isFinite(major)) return 'unknown'
  if (major >= 25) return 'future'
  if (major >= 24) return 'ai24'
  if (major >= 12) return 'ai12'
  if (major >= 9) return 'ai9'
  if (major >= 8) return 'ai8'
  if (major >= 5) return 'ai5'
  return 'ai3'
}

export function detectIllustratorVersionProfile(
  source: string | Uint8Array,
): IllustratorVersionProfile {
  const text = latin1SourceText(source, 1024 * 1024)
  const creator = firstMatch(text, [
    /^%%Creator:\s*(.+)$/imu,
    /^%AI\d*_CreatorVersion:\s*(.+)$/imu,
  ])
  const fileFormat = firstMatch(text, [
    /^%AI\d*_FileFormat\s*:?[\s]*(.+)$/imu,
    /^%%LanguageLevel:\s*(.+)$/imu,
  ])
  const versionText = firstMatch(text, [
    /^%AI\d*_CreatorVersion:\s*([0-9]+(?:\.[0-9]+)?)/imu,
    /Adobe Illustrator(?:\(R\))?\s*(?:CS\d*|CC)?\s*([0-9]+(?:\.[0-9]+)?)/iu,
    /Illustrator[^0-9\r\n]*([0-9]+(?:\.[0-9]+)?)/iu,
  ])
  const parsed = versionText === undefined
    ? undefined
    : Number.parseInt(versionText, 10)
  const major = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined
  const family = familyFor(major)
  const privateCompression = /%AI24_ZStandard_Data/u.test(text)
    ? 'zstd'
    : /%AI(?:1[2-9]|2[0-3])_CompressedData/u.test(text)
      ? 'deflate'
      : /^%!PS-Adobe/mu.test(text)
        ? 'none'
        : 'unknown'
  const diagnostics: string[] = []
  if (major === undefined) {
    diagnostics.push('Illustrator creator version could not be established from native headers.')
  }
  if (family === 'future') {
    diagnostics.push('The source belongs to a newer Illustrator family; unknown operators remain evidence-gated.')
  }
  return {
    family,
    ...(major === undefined ? {} : { major }),
    ...(creator === undefined ? {} : { creator }),
    ...(fileFormat === undefined ? {} : { fileFormat }),
    privateCompression,
    capabilities: {
      layers: major === undefined || major >= 5,
      liveText: major === undefined || major >= 8,
      transparency: major === undefined || major >= 9,
      multipleArtboards: major === undefined || major >= 14,
      zstdPrivateSource: major !== undefined && major >= 24,
    },
    diagnostics,
  }
}

export function operatorRuleApplies(
  profile: IllustratorVersionProfile,
  rule: IllustratorOperatorVersionRule,
): boolean {
  if (profile.major === undefined) return true
  if (rule.minimumMajor !== undefined && profile.major < rule.minimumMajor) return false
  if (rule.maximumMajor !== undefined && profile.major > rule.maximumMajor) return false
  return true
}

export function resolveVersionedOperatorName(
  profile: IllustratorVersionProfile,
  operator: string,
  rules: readonly IllustratorOperatorVersionRule[],
): IllustratorOperatorVersionRule | undefined {
  return rules.find((rule) =>
    operatorRuleApplies(profile, rule)
    && (rule.operator === operator || rule.aliases?.includes(operator) === true),
  )
}
