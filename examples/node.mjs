import { readFile, writeFile } from 'node:fs/promises'
import { createIllustratorEngine } from 'illustrator-pgf/node'

const file = process.argv[2]
if (!file) throw new Error('Usage: node examples/node.mjs input.ai')
const engine = await createIllustratorEngine()
try {
  const document = await engine.open(await readFile(file))
  try {
    console.log(await document.getSummary())
    await writeFile('preview.svg', await document.exportSvg())
  } finally { document.dispose() }
} finally { engine.dispose() }
