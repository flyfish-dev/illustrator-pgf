export type NativeFidelity =
  | 'exact'
  | 'high'
  | 'partial'
  | 'structure-only'
  | 'unsupported'

export type NativeEvidenceKind =
  | 'synthetic-fixture'
  | 'real-illustrator-fixture'
  | 'structure-oracle'
  | 'visual-oracle'
  | 'performance-budget'
  | 'security-budget'
  | 'cross-browser'

export interface NativeFidelityEvidence {
  id: string
  kind: NativeEvidenceKind
  status: 'passed' | 'failed' | 'missing'
  versions?: readonly string[]
  source?: string
  notes?: string
}

export interface NativeFidelityDecision {
  requested: NativeFidelity
  effective: NativeFidelity
  promotable: boolean
  requiredEvidence: readonly NativeEvidenceKind[]
  missingEvidence: readonly NativeEvidenceKind[]
  failedEvidence: readonly NativeEvidenceKind[]
  evidence: readonly NativeFidelityEvidence[]
}

const FIDELITY_ORDER: readonly NativeFidelity[] = [
  'unsupported',
  'structure-only',
  'partial',
  'high',
  'exact',
]

export const NATIVE_FIDELITY_EVIDENCE_REQUIREMENTS: Readonly<
  Record<NativeFidelity, readonly NativeEvidenceKind[]>
> = {
  unsupported: [],
  'structure-only': [],
  partial: ['synthetic-fixture', 'security-budget'],
  high: [
    'synthetic-fixture',
    'real-illustrator-fixture',
    'structure-oracle',
    'visual-oracle',
    'performance-budget',
    'security-budget',
  ],
  exact: [
    'synthetic-fixture',
    'real-illustrator-fixture',
    'structure-oracle',
    'visual-oracle',
    'performance-budget',
    'security-budget',
    'cross-browser',
  ],
}

export function nativeFidelityRank(value: NativeFidelity): number {
  return FIDELITY_ORDER.indexOf(value)
}

export function nativeFidelityAtMost(
  value: NativeFidelity,
  maximum: NativeFidelity,
): NativeFidelity {
  return nativeFidelityRank(value) <= nativeFidelityRank(maximum)
    ? value
    : maximum
}

export function isNativeFidelity(value: unknown): value is NativeFidelity {
  return typeof value === 'string' && FIDELITY_ORDER.includes(value as NativeFidelity)
}

export function resolveNativeFidelity(
  requested: NativeFidelity,
  evidence: readonly NativeFidelityEvidence[],
  requirements: Readonly<
    Partial<Record<NativeFidelity, readonly NativeEvidenceKind[]>>
  > = {},
): NativeFidelityDecision {
  const requiredEvidence = requirements[requested]
    ?? NATIVE_FIDELITY_EVIDENCE_REQUIREMENTS[requested]
  const byKind = new Map<NativeEvidenceKind, NativeFidelityEvidence[]>()
  for (const entry of evidence) {
    const existing = byKind.get(entry.kind)
    if (existing === undefined) byKind.set(entry.kind, [entry])
    else existing.push(entry)
  }
  const missingEvidence = requiredEvidence.filter((kind) => {
    const entries = byKind.get(kind)
    return entries === undefined
      || entries.every((entry) => entry.status === 'missing')
  })
  const failedEvidence = requiredEvidence.filter((kind) =>
    byKind.get(kind)?.some((entry) => entry.status === 'failed') === true,
  )
  let effective = requested
  if (failedEvidence.length > 0) {
    effective = nativeFidelityAtMost(effective, 'structure-only')
  } else if (
    missingEvidence.length > 0
    && nativeFidelityRank(effective) >= nativeFidelityRank('high')
  ) {
    effective = 'partial'
  } else if (missingEvidence.length > 0 && effective === 'partial') {
    effective = 'structure-only'
  }
  return {
    requested,
    effective,
    promotable: missingEvidence.length === 0 && failedEvidence.length === 0,
    requiredEvidence,
    missingEvidence,
    failedEvidence,
    evidence: [...evidence],
  }
}

export function mergeNativeFidelity(
  values: readonly NativeFidelity[],
): NativeFidelity {
  if (values.length === 0) return 'exact'
  return values.reduce((lowest, current) =>
    nativeFidelityRank(current) < nativeFidelityRank(lowest)
      ? current
      : lowest,
  )
}
