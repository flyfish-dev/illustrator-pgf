import type { IllustratorDiagnostic, IllustratorStage, SourceSpan } from './types.js'
export class IllustratorError extends Error {
  readonly code: string
  readonly stage: IllustratorStage
  readonly diagnostics: readonly IllustratorDiagnostic[]
  constructor(code: string, stage: IllustratorStage, message: string, diagnostics: readonly IllustratorDiagnostic[] = []) {
    super(message); this.name = 'IllustratorError'; this.code = code; this.stage = stage; this.diagnostics = diagnostics
  }
}
export function diagnostic(code: string, severity: IllustratorDiagnostic['severity'], stage: IllustratorStage, message: string, options: {
  sourceSpan?: SourceSpan; nodeId?: string; feature?: string; recovery?: string; details?: Readonly<Record<string, unknown>>
} = {}): IllustratorDiagnostic { return { code, severity, stage, message, ...options } }
export function asDiagnostic(error: unknown, stage: IllustratorStage): IllustratorDiagnostic {
  if (error instanceof IllustratorError) return diagnostic(error.code, 'error', error.stage, error.message)
  if (error instanceof DOMException && error.name === 'AbortError') return diagnostic('AI_ABORTED', 'error', stage, 'Illustrator operation was aborted.')
  return diagnostic('AI_UNEXPECTED', 'error', stage, error instanceof Error ? error.message : String(error))
}

export function isIllustratorError(value: unknown): value is IllustratorError {
  return value instanceof IllustratorError || (typeof value === 'object' && value !== null && (value as { name?: unknown }).name === 'IllustratorError' && typeof (value as { code?: unknown }).code === 'string')
}
