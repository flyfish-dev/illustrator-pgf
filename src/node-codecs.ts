import * as zlib from 'node:zlib'
import type { IllustratorCodecProvider } from './codecs.js'
import { IllustratorError } from './errors.js'
import { throwIfAborted } from './util.js'

type Decoder = (input: Uint8Array, options: { maxOutputLength: number }, callback: (error: Error | null, result: Uint8Array) => void) => void

function decodeWith(decoder: Decoder | undefined, name: string, input: Uint8Array, maxOutputBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal)
  if (decoder === undefined) return Promise.reject(new IllustratorError('AI_CODEC_UNAVAILABLE', 'decode', `${name} decompression is unavailable in this Node.js build.`))
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = (): void => {
      if (settled) return
      settled = true
      reject(new IllustratorError('AI_ABORTED', 'decode', 'The Illustrator decode operation was aborted.'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      decoder(input, { maxOutputLength: maxOutputBytes }, (error, result) => {
        signal?.removeEventListener('abort', abort)
        if (settled) return
        settled = true
        if (error !== null) reject(new IllustratorError('AI_CODEC_FAILED', 'decode', `${name} decompression failed: ${error.message}`))
        else if (result.byteLength > maxOutputBytes) reject(new IllustratorError('AI_DECODE_OUTPUT_LIMIT', 'decode', `${name} output exceeds ${maxOutputBytes} bytes.`))
        else resolve(new Uint8Array(result))
      })
    } catch (error) {
      signal?.removeEventListener('abort', abort)
      if (!settled) reject(new IllustratorError('AI_CODEC_FAILED', 'decode', `${name} decompression failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
}

export const nodeCodecProvider: IllustratorCodecProvider = {
  inflate: (input, maximum, signal) => decodeWith(zlib.inflate, 'deflate', input, maximum, signal),
  inflateRaw: (input, maximum, signal) => decodeWith(zlib.inflateRaw, 'raw deflate', input, maximum, signal),
  zstd: (input, maximum, signal) => decodeWith(zlib.zstdDecompress, 'zstd', input, maximum, signal),
}
