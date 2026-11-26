# Native PGF validation evidence

This report records the clean-room release gates executed for the
`feat/native-pgf-plan-complete-v3` branch after all implementation and test files
were committed.

## Executed gates

| Gate | Result |
| --- | --- |
| Fresh clone of the final branch | PASS |
| `npm ci --ignore-scripts` | PASS |
| Repository `npm run check` | PASS |
| `npm pack --json` | PASS |
| Install the generated tarball into an empty npm project | PASS |
| Dynamically import the package root from the cold install | PASS |
| Verify `openNativeIllustratorDocument`, `buildNativeRenderPlan`, `resolveNativeFidelity`, and `installNativeIllustratorWorker` are public functions | PASS |

The shell validation used `set -euo pipefail`, so this report was produced only
after every command above completed successfully.

## Scope of this evidence

This evidence validates installation, TypeScript/build/test integration, package
assembly, cold consumption, and the public export surface. It does **not** stand
in for Adobe Illustrator structure or visual Oracle evidence.

Features marked `partial` or `structure-only` in
`native-pgf-support-matrix.json` remain at that fidelity until licensed real
`.ai`/`.ait` fixtures and Adobe-rendered references pass the repository's Oracle
gates.
