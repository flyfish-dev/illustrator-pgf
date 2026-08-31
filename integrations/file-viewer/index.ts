import type {
  IllustratorContainerInspection,
  IllustratorDocument,
  IllustratorEngine,
  IllustratorFontResolver,
  IllustratorInput,
  IllustratorLimits,
  IllustratorResourceResolver,
} from '../../src/types.js'

export interface FileViewerDesignOptions {
  illustratorMode?: 'auto' | 'pdf' | 'native'
  illustratorWorkerUrl?: string | URL
  illustratorLimits?: Partial<IllustratorLimits>
  illustratorFontResolver?: IllustratorFontResolver
  illustratorResourceResolver?: IllustratorResourceResolver
}

export interface FileViewerIllustratorRoute {
  display: 'pdf' | 'native' | 'unsupported'
  inspection: IllustratorContainerInspection
  nativeAvailable: boolean
  reason?: string
}

export interface FileViewerIllustratorSession {
  engine: IllustratorEngine
  document: IllustratorDocument
  dispose(): void
}

/** Decides routing without importing any File Viewer internals or treating a PDF page as native artwork. */
export async function routeIllustratorInput(
  input: IllustratorInput,
  options: FileViewerDesignOptions = {},
): Promise<FileViewerIllustratorRoute> {
  const { inspectIllustrator } = await import('../../src/index.js')
  const inspection = await inspectIllustrator(input, { limits: options.illustratorLimits })
  const nativeAvailable = inspection.privateSource === 'present'
  const mode = options.illustratorMode ?? 'auto'
  if (mode === 'native') return nativeAvailable
    ? { display: 'native', inspection, nativeAvailable }
    : { display: 'unsupported', inspection, nativeAvailable, reason: 'Illustrator native private source is unavailable.' }
  if (mode === 'pdf') return inspection.pdfSurface === 'usable' || inspection.pdfSurface === 'warning-placeholder'
    ? { display: 'pdf', inspection, nativeAvailable }
    : { display: 'unsupported', inspection, nativeAvailable, reason: 'No usable PDF-compatible surface is available.' }
  if (inspection.pdfSurface === 'usable') return { display: 'pdf', inspection, nativeAvailable }
  if (nativeAvailable) return { display: 'native', inspection, nativeAvailable }
  return { display: 'unsupported', inspection, nativeAvailable, reason: 'Neither a usable PDF surface nor native Illustrator source was found.' }
}

/** Opens only the native PGF/private-source path through the SDK's stable public API. */
export async function openNativeIllustratorSession(
  input: IllustratorInput,
  options: FileViewerDesignOptions = {},
): Promise<FileViewerIllustratorSession> {
  const { createIllustratorEngine } = await import('../../src/index.js')
  const engine = await createIllustratorEngine({
    workerUrl: options.illustratorWorkerUrl,
    limits: options.illustratorLimits,
    fontResolver: options.illustratorFontResolver,
    resourceResolver: options.illustratorResourceResolver,
  })
  try {
    const document = await engine.open(input, { mode: 'native', limits: options.illustratorLimits })
    return { engine, document, dispose(): void { document.dispose(); engine.dispose() } }
  } catch (error) {
    engine.dispose()
    throw error
  }
}
