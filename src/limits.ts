import type { IllustratorLimits } from './types.js'
export const DEFAULT_ILLUSTRATOR_LIMITS: Readonly<IllustratorLimits> = Object.freeze({
  maxFileBytes: 128 * 1024 * 1024,
  maxDecodedBytes: 128 * 1024 * 1024,
  maxPdfObjects: 250_000,
  maxPrivateBlocks: 10_000,
  maxTokens: 1_000_000,
  maxStatements: 250_000,
  maxNodes: 250_000,
  maxPathPoints: 1_000_000,
  maxNesting: 256,
  maxStringBytes: 8 * 1024 * 1024,
  maxSingleRasterPixels: 64_000_000,
  maxTotalRasterBytes: 256 * 1024 * 1024,
  maxWorkerTimeMs: 30_000,
  maxRenderPixels: 32_000_000,
  maxCacheBytes: 128 * 1024 * 1024,
})
export function resolveLimits(overrides?: Partial<IllustratorLimits>): IllustratorLimits {
  const result = { ...DEFAULT_ILLUSTRATOR_LIMITS }
  if (overrides === undefined) return result
  for (const key of Object.keys(result) as (keyof IllustratorLimits)[]) {
    const value = overrides[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} must be a positive safe integer.`)
    result[key] = value
  }
  return result
}
