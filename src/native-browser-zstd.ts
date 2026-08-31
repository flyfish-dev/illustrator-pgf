export interface BrowserZstdDecoder {
  decode(
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Uint8Array | Promise<Uint8Array>
}

export interface BrowserZstdCodecProvider {
  zstdDecompress(
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
  decompressZstd(
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
  zstd(
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
}

function assertZstdFrame(input: Uint8Array): void {
  if (
    input.byteLength < 4
    || input[0] !== 0x28
    || input[1] !== 0xb5
    || input[2] !== 0x2f
    || input[3] !== 0xfd
  ) {
    throw new Error('Input does not begin with the standard zstd frame magic.')
  }
}

export function createBrowserZstdCodecProvider(
  decoder: BrowserZstdDecoder,
  options: Readonly<{
    requireFrameMagic?: boolean
    maximumInputBytes?: number
  }> = {},
): BrowserZstdCodecProvider {
  const decode = async (
    input: Uint8Array,
    maximumOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    if (!(input instanceof Uint8Array)) {
      throw new TypeError('zstd input must be a Uint8Array.')
    }
    if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 0) {
      throw new RangeError('maximumOutputBytes must be a non-negative safe integer.')
    }
    const maximumInputBytes = options.maximumInputBytes ?? 256 * 1024 * 1024
    if (input.byteLength > maximumInputBytes) {
      throw new RangeError(
        `zstd input exceeds the ${maximumInputBytes}-byte limit.`,
      )
    }
    if (options.requireFrameMagic !== false) assertZstdFrame(input)
    if (signal?.aborted === true) {
      throw new DOMException('zstd decode aborted.', 'AbortError')
    }
    const output = await decoder.decode(input, maximumOutputBytes, signal)
    if (!(output instanceof Uint8Array)) {
      throw new TypeError('Browser zstd decoder must return Uint8Array.')
    }
    if (output.byteLength > maximumOutputBytes) {
      throw new RangeError(
        `zstd output exceeds the ${maximumOutputBytes}-byte limit.`,
      )
    }
    if (signal?.aborted === true) {
      throw new DOMException('zstd decode aborted.', 'AbortError')
    }
    return output
  }
  return {
    zstdDecompress: decode,
    decompressZstd: decode,
    zstd: decode,
  }
}

export interface BrowserZstdModule {
  decompress(
    input: Uint8Array,
    maximumOutputBytes?: number,
  ): Uint8Array | Promise<Uint8Array>
}

export function browserZstdDecoderFromModule(
  module: BrowserZstdModule,
): BrowserZstdDecoder {
  return {
    async decode(input, maximumOutputBytes, signal) {
      if (signal?.aborted === true) {
        throw new DOMException('zstd decode aborted.', 'AbortError')
      }
      const output = await module.decompress(input, maximumOutputBytes)
      if (!(output instanceof Uint8Array)) {
        throw new TypeError('zstd module returned a non-Uint8Array result.')
      }
      return output
    },
  }
}
