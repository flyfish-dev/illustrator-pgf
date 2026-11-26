# Native PGF development-plan completion

This document records the implementation delivered on the
`feat/native-pgf-plan-complete-v3` branch. It must be read together with
`native-pgf-high-fidelity-development-plan.md`.

The code work for every planned work package is present. Claims of visual
`high` or `exact` fidelity remain gated by real Illustrator fixtures and Adobe
rendering Oracles. Synthetic fixtures can exercise behavior, but cannot promote
fidelity on their own.

## Work-package status

| Work package | Delivered implementation | Verification status |
| --- | --- | --- |
| W0 — evidence and fidelity governance | `NativeFidelity`, evidence requirements, deterministic downgrade rules, machine-readable decisions | Automated tests cover missing, passing and failed gates. Real-file evidence is not fabricated. |
| W1 — container and codec completion | Existing PDF-compatible/direct-PostScript decoder retained; bounded browser zstd adapter added with frame validation, abort and output limits | Existing container suite plus adapter tests. Cross-browser zstd evidence remains external. |
| W2 — lossless source model | Existing lossless lexer/AST retained; header, prolog, setup, resource, drawing, fallback and trailer section map added without rewriting raw statements | Section classification is tested from source spans and raw statements. |
| W3 — semantic and geometry foundation | Version-family profiles, version-qualified operator rules, exact cubic derivative extrema, matrix helpers and stroke-bound inflation | Unit tests cover AI24 detection and exact cubic bounds. Existing path/compound/clip tests remain authoritative. |
| W4 — artboards and document structure | UUID, name, bounds, selected/locked flags, pixel aspect ratio, ruler origin, bleed and raw properties are merged from Scene IR and private source | Synthetic modern-artboard dictionary test covers every retained field. |
| W5 — paints and resources | Dependency graph, gradients/stops, patterns, raster metadata/payload identity, process/spot/ICC inventory and explicit external-resource policy | Resource graph/decoder tests cover gradient, pattern, raster and symbol identity. ICC-managed output remains evidence-gated. |
| W6 — native text | Point, area, path and threaded frame models; character runs, fonts, size, tracking, horizontal scale and baseline shift; required-font inventory | Point text can render through the shared plan. Area/path/threaded layout is preserved as structure-only until Oracle fixtures exist. |
| W7 — transparency | Object/fill/stroke opacity, blend mode, isolation, knockout and alpha/luminosity mask identity | Basic blend mapping is executable. Isolation, knockout and opacity masks remain explicit structure-only diagnostics without Oracle proof. |
| W8 — advanced Illustrator objects | Symbol, brush, live-effect and plugin object inventory; parameter retention; expanded/fallback appearance detection | Executable plugin/effect code is never run. Expanded fallback can be used; absence of fallback downgrades the object. |
| W9 — rendering parity | One recursively ordered render plan feeds Canvas and SVG; path points and segment forms, compound paths, clipping scope, text, images and unsupported nodes are represented | Deterministic plan hash and clip-order tests. SVG output is escaped, namespaced and contains no active content. |
| W10 — runtime, cancellation and memory | Cooperative operation/deadline/abort budget, byte-accounted LRU, render revision gate, disposable document session and dedicated Worker protocol | Worker abort/timeout terminates the actual Worker. Session count and resource-cache bytes are bounded. |
| W11 — corpus, Oracle and performance | AI/AIT manifest validation, structure snapshot/diff, RGBA visual diff, benchmark percentiles and performance evidence conversion | Tooling is implemented. Real Illustrator files, licensed metadata and Adobe renders must be supplied before promotion. |
| W12 — security and release hardening | Source/statement/nesting/Binary/external-reference budgets, active PostScript inventory, deterministic mutations and no implicit network resolution | Security and mutation tests are included. The parser treats PostScript as data and never executes it. |

## Public entry points

```ts
import {
  openNativeIllustratorDocument,
  createBrowserZstdCodecProvider,
  evaluateNativeOracle,
  benchmarkNativeOperation,
} from '@flyfish/illustrator-pgf'

const document = await openNativeIllustratorDocument(bytes)
console.log(document.summary())
const svg = document.toSvg({ namespace: 'preview' })
document.dispose()
```

Dedicated Worker runtime:

```ts
import { installNativeIllustratorWorker } from '@flyfish/illustrator-pgf'

installNativeIllustratorWorker(self)
```

Worker client:

```ts
import { NativeIllustratorWorkerClient } from '@flyfish/illustrator-pgf'

const worker = new Worker(new URL('./illustrator.worker.ts', import.meta.url), {
  type: 'module',
})
const client = new NativeIllustratorWorkerClient(worker)
const opened = await client.open(bytes, { timeoutMs: 30_000 })
const svg = await client.svg(opened.sessionId)
await client.disposeSession(opened.sessionId)
client.dispose()
```

## Fidelity boundary

The implementation guarantees the following for accepted input:

1. The existing lossless AST remains the source of truth. New analysis models do
   not remove unknown statements or opaque resource data.
2. Visible unsupported objects become explicit `unsupported` render operations
   and diagnostics. No bounding-box or colored-placeholder artwork is generated
   to imitate successful parsing.
3. External files are denied unless the host supplies an explicit resolver.
4. Worker abort or timeout terminates the Worker, rather than only rejecting a
   Promise on the main thread.
5. `high` and `exact` are not promotable until all required real-fixture,
   structure-Oracle, visual-Oracle, performance, security and (for `exact`)
   cross-browser evidence passes.

The repository does not include proprietary Illustrator fixtures or claim Adobe
Oracle results that were not supplied. The machinery needed to ingest and grade
that evidence is complete and documented by `oracle-manifest.schema.json`.
