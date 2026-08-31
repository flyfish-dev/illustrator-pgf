# API

## 门面

```ts
inspectIllustrator(input, options?)
createIllustratorEngine(options?)
```

浏览器 `createIllustratorEngine()` 默认要求 Dedicated Worker。Node 请从 `@flyfish/illustrator-pgf/node` 导入，它返回使用同一核心实现的 direct engine。

生产构建建议通过 `workerFactory` 在应用代码中直接创建 Worker，使构建器识别 worker 入口：

```ts
const engine = await createIllustratorEngine({
  workerFactory: () => new Worker(
    new URL('./illustrator-pgf.worker.ts', import.meta.url),
    { type: 'module' },
  ),
})
```

应用侧 `illustrator-pgf.worker.ts` 调用 `installIllustratorWorker(self)`。也可通过 `workerUrl` 指向宿主已发布的本地资产；Worker 不会自动请求 CDN。

## Document session

- `getSummary()`：节点、路径、文字、资源、画板、图层和 fidelity 摘要；
- `getArtboards()`：共享画布上的视图/裁切边界；
- `getLayerTree()`：稳定 ID 和状态；
- `getSupportReport()`：unknown operator、unsupported inventory 和 fidelity；
- `getDiagnostics()`：跨 container/decode/lex/parse/lower/render/resource 的结构诊断；
- `getLosslessAst()`：完整 token/statement AST；
- `render()` / `renderToBitmap()`：Canvas 或 ImageBitmap；
- `exportSvg()`：安全 SVG；
- `exportSceneJson()`：版本化 Scene IR；
- `trimCache()`：缓存收缩入口；
- `dispose()`：释放 session。

## 低级 API

```ts
inspectIllustratorContainer()
decodeIllustratorPrivateSource()
lexIllustratorSource()
parseIllustratorSource()
lowerIllustratorAst()
renderIllustratorScene()
```

高级和低级 API 共享同一实现，不存在第二套格式规则。

## 输入与所有权

输入为 `ArrayBuffer | Uint8Array | Blob`。Worker client 在 transfer 前创建受控副本，避免意外 detach 调用方的原 buffer；Worker 内部不再额外 base64 化。

## 取消与超时

- 调用前已 aborted：直接拒绝，不启动请求；
- Worker 执行中 aborted 或 timeout：终止 Worker，拒绝所有 pending promise；
- fatal `error`/`messageerror`/协议错误：终止 Worker；
- fatal 后 engine 不可复用；
- `dispose()` 幂等。

## 错误和诊断

异常使用 `IllustratorError`，包含稳定 `code`、`stage` 和 diagnostics。可恢复/降级问题进入 `IllustratorDiagnostic`。公开错误码不得在无迁移说明时改变含义。

## Scene schema

Scene IR `schemaVersion` 与 npm SemVer 分离。0.1.0 使用 schema 1；不兼容 schema 改动必须单独迁移。
