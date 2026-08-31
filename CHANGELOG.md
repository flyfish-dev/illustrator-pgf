# Changelog

## Unreleased

- Accept real Illustrator deflate/zstd markers whose codec payload starts immediately after the marker.
- Locate revisable-source payloads after alternate private preview blocks.
- Preserve Illustrator `%%BeginData` payloads and gradient resource marks without swallowing following statements.
- Lower extended layer flags, AI5 path aliases, custom colors, indirect paint operators and object opacity used by real AI/AIT files.
- Add the native PGF high-fidelity development and acceptance plan.

## 0.1.0

- Added bounded Illustrator PDF/private-source container parser.
- Added strict byte-lossless Lexer and AST.
- Added versioned semantic operator registry and Scene IR schema 1.
- Added Canvas2D, OffscreenCanvas/ImageBitmap and safe SVG paths.
- Added Dedicated Worker protocol, Abort/timeout and disposal lifecycle.
- Added Node entry, CLI diagnostics/diff/benchmark, and File Viewer adapter.
- Added synthetic corpus, malformed-input tests, support matrix and release gates.
