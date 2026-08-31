# Release Checklist

## 本次自动完成

- [x] TypeScript strict compile
- [x] 单元/集成测试
- [x] Lossless source roundtrip tests
- [x] PDF container matrix synthetic tests
- [x] Worker Abort/timeout/dispose tests
- [x] SVG safety tests
- [x] npm tarball dry run
- [x] npm tarball cold install smoke test
- [x] CLI inspect/scene/svg/support/benchmark smoke test
- [x] package exports and `.d.ts` smoke test
- [x] license and third-party notice included

## 稳定版前必须补齐

- [ ] 每个目标 Illustrator 版本族的真实授权 fixture
- [ ] Illustrator structural Oracle
- [ ] 固定字体/ICC 的 raster/SVG visual Oracle
- [ ] pixel mismatch、SSIM、热图报告
- [ ] Chromium/Firefox/WebKit 自动化
- [ ] CSP、MIME、asset URL、Shadow DOM、offline/no-network
- [ ] 规范设备上的 P95 parse/visible/fps 报告
- [ ] 长时间 fuzz 和内存回落报告
- [ ] browser zstd WASM 资产、版本校验和许可证清单
- [ ] File Viewer 主仓真实集成验证

任一未完成项都不得被文案隐去或用 PDF surface 成功代替。
