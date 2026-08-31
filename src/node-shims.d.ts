declare module 'node:fs/promises' {
  export function readFile(path: string | URL): Promise<Uint8Array>
  export function writeFile(path: string | URL, data: string | Uint8Array): Promise<void>
}
declare module 'node:zlib' {
  export function inflate(input: Uint8Array, options: { maxOutputLength: number }, callback: (error: Error | null, result: Uint8Array) => void): void
  export function inflateRaw(input: Uint8Array, options: { maxOutputLength: number }, callback: (error: Error | null, result: Uint8Array) => void): void
  export function zstdDecompress(input: Uint8Array, options: { maxOutputLength: number }, callback: (error: Error | null, result: Uint8Array) => void): void
  export function deflateSync(input: Uint8Array): Uint8Array
  export function zstdCompressSync(input: Uint8Array): Uint8Array
}
declare const process: {
  argv: string[]
  stdout: { write(value: string | Uint8Array): void }
  stderr: { write(value: string): void }
  exitCode?: number
  memoryUsage(): { heapUsed: number }
  versions: { node: string }
  platform: string
  arch: string
}
declare module 'node:test' { const test: (name: string, fn: () => void | Promise<void>) => void; export default test }
declare module 'node:assert/strict' { const assert: any; export default assert }
