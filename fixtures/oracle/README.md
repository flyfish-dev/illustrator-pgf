# Illustrator Oracle corpus

Real `.ai` and `.ait` files are intentionally not committed unless their license
permits repository redistribution.

For every private or external fixture, keep the binary outside Git and commit a
sidecar manifest that validates against
`docs/oracle-manifest.schema.json`. The manifest must include:

- a stable fixture ID;
- the exact Illustrator version that saved the file;
- `ai` or `ait` extension;
- license/provenance text;
- SHA-256 of the original binary;
- a structure Oracle exported from Illustrator or independently verified;
- optional Adobe-rendered RGBA reference metadata and thresholds.

A fixture may contribute `real-illustrator-fixture` evidence only when its hash,
version and license fields validate. It may contribute `structure-oracle` or
`visual-oracle` evidence only when the corresponding comparison passes.

Synthetic fixtures remain useful for regression and security coverage, but they
must never be relabeled as real Illustrator evidence.

Example manifest:

```json
{
  "schemaVersion": 1,
  "fixtureId": "ai24-gradient-001",
  "illustratorVersion": "24.3.0",
  "extension": "ai",
  "license": "internal-test-only",
  "sourceSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "structureOracle": {
    "artboards": 1,
    "layers": 2,
    "paths": 7,
    "resources": 1,
    "fidelity": "partial"
  },
  "visualOracle": {
    "renderer": "Adobe Illustrator 24.3.0 macOS",
    "width": 1024,
    "height": 1024,
    "channelThreshold": 8,
    "maximumDifferentPixelRatio": 0.001,
    "maximumMeanChannelDelta": 1
  }
}
```

The zero digest above is illustrative and must be replaced by the actual SHA-256
before the manifest is accepted.
