# Native PGF pipeline release notes

## Added

- Evidence-gated fidelity decisions for `exact`, `high`, `partial`,
  `structure-only`, and `unsupported` support levels.
- Illustrator version-family profiles and version-qualified operator rules.
- A bounded browser zstd adapter with abort and output-budget enforcement.
- Lossless source-section classification covering document setup, resources,
  native drawing code, fallback data, and trailer content.
- Exact cubic Bézier extrema bounds, matrix composition helpers, and
  stroke-bound inflation.
- Modern artboard metadata including UUID, selected/locked state, pixel aspect
  ratio, ruler origin, bleed, and retained raw properties.
- A dependency-aware resource graph plus gradient, pattern, raster,
  process/spot color, and ICC-profile inventories.
- Explicit host-controlled placed-resource resolution with deny-by-default
  network policy.
- Native text models for point, area, path, and threaded frames, including
  character-run metrics and required-font reporting.
- Transparency, blend, isolation, knockout, and opacity-mask models.
- Symbol, brush, live-effect, plugin-object, and expanded-appearance fallback
  models without executing input code.
- A deterministic render plan shared by Canvas and SVG, including compound
  paths, clipping scope, text, image resources, and explicit unsupported nodes.
- Byte-accounted LRU caches, cooperative cancellation budgets, disposable
  document sessions, and a Dedicated Worker protocol/client.
- AI/AIT Oracle manifests, structure comparison, RGBA visual comparison,
  performance evidence, security budgets, and deterministic mutation tooling.

## Compatibility

The existing public container, lexer, AST, semantic lowering, Scene IR, Canvas,
SVG, engine, and worker exports remain available. The new native pipeline is
additive and exported from the package root.

## Integrity note

No feature is promoted to `high` or `exact` solely because a synthetic test
passes. Real Illustrator fixtures, structure Oracles, visual Oracles,
performance evidence, and security evidence remain mandatory according to the
requested fidelity level.
