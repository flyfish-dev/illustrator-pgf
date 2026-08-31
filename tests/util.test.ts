import test from 'node:test'
import assert from 'node:assert/strict'
import { bytesEqual, latin1Decode, latin1Encode, sha256 } from '../src/util.js'
import { resolveLimits } from '../src/limits.js'

test('strict Latin-1 mapping round-trips every byte 0..255', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
  assert.equal(latin1Decode(bytes).length, 256)
  assert.ok(bytesEqual(latin1Encode(latin1Decode(bytes)), bytes))
})

test('Latin-1 encoder rejects characters outside one byte', () => {
  assert.throws(() => latin1Encode('A😀'), /Latin-1/u)
})

test('SHA-256 fallback/WebCrypto result is stable', async () => {
  assert.equal(await sha256(latin1Encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('limits can only be positive safe integers', () => {
  assert.throws(() => resolveLimits({ maxTokens: 0 }), /positive safe integer/u)
  assert.equal(resolveLimits({ maxTokens: 12 }).maxTokens, 12)
})
