#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import {
  createIllustratorEngine,
  decodeIllustratorPrivateSource,
  inspectIllustrator,
} from './node.js'
import { createDefaultOperatorRegistry } from './semantic.js'
import { reconstructIllustratorSource } from './ast.js'
import type { IllustratorSceneDocument, IllustratorSceneNode } from './types.js'

function usage(): string {
  return `illustrator-pgf <command> [arguments]\n\nCommands:\n  inspect <file> [output]             Inspect the AI/PGF container only\n  decode <file> [output]              Extract decoded Illustrator private source\n  ast <file> [output]                 Export the lossless AST as JSON\n  scene|parse <file> [output]         Export Scene IR as JSON\n  support <file> [output]             Export fidelity/unsupported report as JSON\n  svg <file> [output]                 Export the first artboard as safe SVG\n  diff <left> <right> [output]        Compare normalized Scene IR structure\n  benchmark <file> [runs] [output]    Measure full open/parse latency and heap delta\n  operators [output]                  Export the versioned operator coverage table\n`
}

function json(value: unknown): string {
  return `${JSON.stringify(value, (_key, item: unknown) => item instanceof Uint8Array ? { type: 'Uint8Array', length: item.byteLength, hex: [...item.slice(0, 64)].map((byte) => byte.toString(16).padStart(2, '0')).join(''), truncated: item.byteLength > 64 } : item, 2)}\n`
}

async function emit(value: string | Uint8Array, output?: string): Promise<void> {
  if (output === undefined || output === '-') process.stdout.write(value)
  else await writeFile(output, value)
}

function flattenScene(scene: IllustratorSceneDocument): Readonly<Record<string, unknown>>[] {
  const output: Readonly<Record<string, unknown>>[] = []
  const visit = (node: IllustratorSceneNode): void => {
    output.push({
      id: node.id,
      type: node.type,
      parentId: node.parentId,
      layerId: node.layerId,
      name: node.name,
      transform: node.transform,
      bounds: node.bounds,
      visible: node.visible,
      fidelity: node.fidelity,
      appearance: node.appearance,
      ...(node.type === 'Path' || node.type === 'CompoundPath' ? { geometry: node.geometry } : {}),
      ...(node.type === 'Text' ? { textKind: node.textKind, direction: node.direction, runs: node.runs } : {}),
      ...(node.type === 'UnknownNode' ? { operator: node.operator, payload: node.payload } : {}),
    })
    if (node.type === 'Layer' || node.type === 'Group' || node.type === 'ClipGroup' || node.type === 'SymbolDefinition') for (const child of node.children) visit(child)
  }
  for (const child of scene.children) visit(child)
  return output
}

async function openScene(file: string): Promise<IllustratorSceneDocument> {
  const engine = await createIllustratorEngine()
  try {
    const document = await engine.open(await readFile(file))
    try { return await document.exportSceneJson() }
    finally { document.dispose() }
  } finally { engine.dispose() }
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]!
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  if (command === undefined || command === '--help' || command === '-h') { process.stdout.write(usage()); return }
  if (command === 'operators') { await emit(json(createDefaultOperatorRegistry().coverage()), args[1]); return }
  if (command === 'diff') {
    const [, leftFile, rightFile, output] = args
    if (leftFile === undefined || rightFile === undefined) throw new Error(`diff requires two files.\n\n${usage()}`)
    const [left, right] = await Promise.all([openScene(leftFile), openScene(rightFile)])
    const leftNodes = flattenScene(left); const rightNodes = flattenScene(right)
    const maximum = Math.max(leftNodes.length, rightNodes.length)
    const differences: { index: number; left?: unknown; right?: unknown }[] = []
    for (let index = 0; index < maximum && differences.length < 1000; index++) {
      const a = leftNodes[index]; const b = rightNodes[index]
      if (JSON.stringify(a) !== JSON.stringify(b)) differences.push({ index, ...(a === undefined ? {} : { left: a }), ...(b === undefined ? {} : { right: b }) })
    }
    await emit(json({ equal: differences.length === 0 && leftNodes.length === rightNodes.length, left: { nodes: leftNodes.length, fidelity: left.fidelity, artboards: left.artboards }, right: { nodes: rightNodes.length, fidelity: right.fidelity, artboards: right.artboards }, differences, truncated: differences.length >= 1000 }), output)
    return
  }
  if (command === 'benchmark') {
    const [, file, runsRaw, output] = args
    if (file === undefined) throw new Error(`benchmark requires a file.\n\n${usage()}`)
    const runs = runsRaw === undefined ? 10 : Number(runsRaw)
    if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error('benchmark runs must be an integer from 1 to 100.')
    const bytes = await readFile(file)
    const times: number[] = []
    const heapBefore = process.memoryUsage().heapUsed
    for (let index = 0; index < runs; index++) {
      const engine = await createIllustratorEngine()
      const started = performance.now()
      try {
        const document = await engine.open(bytes)
        try { await document.getSummary() }
        finally { document.dispose() }
      } finally { engine.dispose() }
      times.push(performance.now() - started)
    }
    const heapAfter = process.memoryUsage().heapUsed
    await emit(json({ file, bytes: bytes.byteLength, runs, milliseconds: { values: times, min: Math.min(...times), median: percentile(times, 0.5), p95: percentile(times, 0.95), max: Math.max(...times), mean: times.reduce((sum, value) => sum + value, 0) / times.length }, heapDeltaBytes: heapAfter - heapBefore, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch } }), output)
    return
  }

  const [, file, output] = args
  if (file === undefined) throw new Error(`Missing input file.\n\n${usage()}`)
  const bytes = await readFile(file)
  if (command === 'inspect') { await emit(json(await inspectIllustrator(bytes)), output); return }
  if (command === 'decode') { await emit((await decodeIllustratorPrivateSource(bytes)).bytes, output); return }

  const engine = await createIllustratorEngine()
  try {
    const document = await engine.open(bytes)
    try {
      if (command === 'ast') { const ast = await document.getLosslessAst(); await emit(json({ ...ast, reconstructedByteLength: reconstructIllustratorSource(ast).byteLength }), output); return }
      if (command === 'scene' || command === 'parse') { await emit(json(await document.exportSceneJson()), output); return }
      if (command === 'support') { await emit(json(await document.getSupportReport()), output); return }
      if (command === 'svg') { await emit(await document.exportSvg(), output); return }
      throw new Error(`Unknown command ${command}.\n\n${usage()}`)
    } finally { document.dispose() }
  } finally { engine.dispose() }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
