# 架构

## 数据流

```text
ArrayBuffer / Uint8Array / Blob
  → Container Inspector
  → PDF xref/object model or direct Illustrator PostScript
  → AIPrivateData block extraction
  → bounded PDF filters
  → none / deflate / zstd private-source decode
  → Lossless Lexer
  → Lossless AST
  → versioned operator registry
  → Scene IR + diagnostics + unsupported inventory + fidelity
  → Canvas2D / OffscreenCanvas / SVG / Scene JSON
```

## 分层边界

### Container

`src/pdf.ts` 解析 PDF header、classic xref、xref stream、object stream、增量更新、代数、直接/间接 `Length` 和过滤器参数。`src/container.ts` 只在 PDF 对象模型之上跟踪 Catalog → Pages/PieceInfo → Illustrator → Private，并验证 `NumBlock` 和 `AIPrivateData*` 连续性。

容器识别不以文件扩展名或前若干 MiB 的字符串命中作为最终结论。普通 PDF 即使改名为 `.ai`，也不会获得 `pdf-private` 分类。

### Decode

PDF stream filter 与 Illustrator private-source 压缩是两层独立解码：

1. PDF 层白名单：Flate、ASCIIHex、ASCII85、RunLength 和 predictor；
2. Illustrator 层：无压缩、`%AI12…23_CompressedData`/zlib、`%AI24_ZStandard_Data`/zstd。

所有组合、解码和解压操作在产生输出时执行预算。

### Lossless Lexer / AST

Lexer 使用严格的一字节一字符映射，避免 `TextDecoder('latin1')` 实际 Windows-1252 映射导致高位字节不可逆。Token 保存 `raw` 与精确 offset/line/column；AST 保存顺序、操作数、注释、资源块和未知语法。Scene IR 不支持某项语义不会影响 AST 保存。

### Semantic registry

`IllustratorOperatorRegistry` 允许同一操作符按版本族注册处理器。每项声明 family、操作数 schema、状态读写、产物类别、fidelity 与 fixture ID。解析逻辑不集中在单个巨型 switch 中。

### Scene IR

Scene IR 使用稳定 schema，节点包含稳定 ID、source span、父子/图层关系、矩阵、边界、Appearance、fidelity、诊断及原语句索引。Scene validator 检查重复 ID、父子关系和图层归属。

### Rendering

Canvas2D 与 SVG 共用 Scene IR。SVG 只生成内部 path/group/text/clip 引用，并在返回前执行脚本、事件属性、`foreignObject` 与外部 URL 安全不变量检查。资源未解析时不绘制假占位框，而是给出 render diagnostic。

## Worker 生命周期

主线程只负责输入、会话调用和最终位图呈现。Worker client 为每个请求分配递增 ID，并维护 pending map、timeout 和 Abort 监听。因为同步 CPU 解析无法靠同一 Worker 中的后续 message 真正抢占，主线程遇到执行中的 Abort/timeout 时会终止 Worker，并拒绝所有挂起请求。

Session 和 engine 均有幂等 `dispose()`；fatal error 后 Worker 不可复用。

## 依赖方向

```text
core types/util/limits/errors
  ↑ codecs/pdf/container
  ↑ lexer/ast
  ↑ semantic/scene
  ↑ renderers
  ↑ engine/worker/sdk
  ↑ integrations/file-viewer
```

独立 SDK 不依赖 `@file-viewer/core`。适配器只动态导入稳定公共 API。
