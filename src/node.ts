export * from './types.js'
export * from './limits.js'
export * from './errors.js'
export * from './pdf.js'
export * from './lexer.js'
export * from './ast.js'
export * from './scene.js'
export * from './semantic.js'
export * from './render-svg.js'
export * from './render-canvas.js'
export { nodeCodecProvider } from './node-codecs.js'

import type {
  DecodeOptions,
  IllustratorContainerInspection,
  IllustratorDecodedSource,
  IllustratorEngine,
  IllustratorEngineOptions,
  IllustratorInput,
  InspectOptions,
} from './types.js'
import { inspectIllustratorContainer, decodeIllustratorPrivateSource as decodeCore } from './container.js'
import { DirectIllustratorEngine } from './engine.js'
import { nodeCodecProvider } from './node-codecs.js'

export async function inspectIllustrator(input: IllustratorInput, options: InspectOptions = {}): Promise<IllustratorContainerInspection> {
  return inspectIllustratorContainer(input, options, { codecProvider: nodeCodecProvider })
}

export const inspectIllustratorContainerNode = inspectIllustrator

export async function decodeIllustratorPrivateSource(input: IllustratorInput, options: DecodeOptions = {}): Promise<IllustratorDecodedSource> {
  return decodeCore(input, options, { codecProvider: nodeCodecProvider })
}

export async function createIllustratorEngine(options: IllustratorEngineOptions = {}): Promise<IllustratorEngine> {
  return new DirectIllustratorEngine({ ...options, forceDirect: true }, { codecProvider: nodeCodecProvider })
}
