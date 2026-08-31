import type {
  IllustratorArtboard,
  IllustratorDiagnostic,
  IllustratorDocumentSummary,
  IllustratorLayerNode,
  IllustratorLosslessAst,
  IllustratorSceneDocument,
  IllustratorSupportReport,
  OpenOptions,
  RenderOptions,
  RenderResult,
  SceneExportOptions,
  SvgExportOptions,
} from './types.js'

export type SerializableOpenOptions = Omit<OpenOptions, 'signal'>
export type SerializableRenderOptions = Omit<RenderOptions, 'signal'>
export type SerializableSvgExportOptions = Omit<SvgExportOptions, 'signal'>

interface RequestBase { requestId: number }
interface SessionRequestBase extends RequestBase { sessionId: number }

export type IllustratorWorkerRequest =
  | (RequestBase & { type: 'open'; bytes: ArrayBuffer; options: SerializableOpenOptions })
  | (SessionRequestBase & { type: 'getSummary' })
  | (SessionRequestBase & { type: 'getArtboards' })
  | (SessionRequestBase & { type: 'getLayers' })
  | (SessionRequestBase & { type: 'getSupportReport' })
  | (SessionRequestBase & { type: 'getDiagnostics' })
  | (SessionRequestBase & { type: 'getLosslessAst' })
  | (SessionRequestBase & { type: 'renderBitmap'; options: SerializableRenderOptions })
  | (SessionRequestBase & { type: 'exportSvg'; options: SerializableSvgExportOptions })
  | (SessionRequestBase & { type: 'exportScene'; options: SceneExportOptions })
  | (SessionRequestBase & { type: 'trimCache'; maxBytes?: number })
  | (SessionRequestBase & { type: 'disposeSession' })
  | (RequestBase & { type: 'disposeEngine' })
  | (RequestBase & { type: 'cancel'; targetRequestId: number })

export interface WorkerOpenResult { sessionId: number }
export interface WorkerBitmapResult { bitmap: ImageBitmap; render: RenderResult }

export type IllustratorWorkerResult =
  | WorkerOpenResult
  | IllustratorDocumentSummary
  | readonly IllustratorArtboard[]
  | readonly IllustratorLayerNode[]
  | IllustratorSupportReport
  | readonly IllustratorDiagnostic[]
  | IllustratorLosslessAst
  | WorkerBitmapResult
  | string
  | IllustratorSceneDocument
  | null

export interface SerializedIllustratorError {
  name: string
  code: string
  stage: string
  message: string
  stack?: string
  diagnostics?: readonly IllustratorDiagnostic[]
}

export type IllustratorWorkerRequestPayload = IllustratorWorkerRequest extends infer Request
  ? Request extends { requestId: number } ? Omit<Request, 'requestId'> : never
  : never

export type IllustratorWorkerResponse =
  | { requestId: number; ok: true; result: IllustratorWorkerResult }
  | { requestId: number; ok: false; error: SerializedIllustratorError }

export function isIllustratorWorkerResponse(value: unknown): value is IllustratorWorkerResponse {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { requestId?: unknown; ok?: unknown }
  return Number.isSafeInteger(candidate.requestId) && typeof candidate.ok === 'boolean'
}
