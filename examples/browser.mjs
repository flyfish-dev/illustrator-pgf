import { createIllustratorEngine } from 'illustrator-pgf'

const input = document.querySelector('#file')
const canvas = document.querySelector('#canvas')
const report = document.querySelector('#report')
let active

input.addEventListener('change', async () => {
  active?.dispose()
  const file = input.files?.[0]
  if (!file) return
  const engine = await createIllustratorEngine({
    workerFactory: () => new Worker(
      new URL('./illustrator-pgf.worker.mjs', import.meta.url),
      { type: 'module', name: 'illustrator-pgf' },
    ),
  })
  const document = await engine.open(file)
  active = { dispose() { document.dispose(); engine.dispose() } }
  report.textContent = JSON.stringify(await document.getSupportReport(), null, 2)
  await document.render(canvas, { width: 1000, revision: 1 })
})
