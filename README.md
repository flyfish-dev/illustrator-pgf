# illustrator-pgf

一个独立、离线优先、带资源预算的 Adobe Illustrator 原生 PGF/private-source 解析与预览 SDK。它把 Illustrator 文件中的 PDF-compatible 表面与原生可编辑场景严格分开，并提供：

- PDF 容器与 `AIPrivateData*` 私有块解析；
- deflate、zstd、ASCIIHex、ASCII85、RunLength 与 PDF predictor 解码；
- 字节级可往返的 Lossless Lexer / AST；
- 版本化操作符注册表与统一 Scene IR；
- Canvas2D、OffscreenCanvas/ImageBitmap、SVG 与 Scene JSON 输出；
- Dedicated Worker 会话、Abort、超时、dispose 和显式预算；
- Node CLI、低级 API 与不依赖 File Viewer 内部实现的接入适配器。

> **状态：开发基线（0.1.0），不是“所有 Illustrator 版本已通过 Oracle 的稳定完整版”。** 代码保证已接受源码的 token/AST 字节级重建，并保证未知操作符进入诊断、unsupported inventory 和必要的 `UnknownNode`，不静默丢弃。对象级和画面级支持必须继续以真实 Illustrator 语料、结构 Oracle、视觉 diff、三浏览器及性能门禁证明。

## 安装

```bash
npm install illustrator-pgf
```

## 浏览器：生产 Worker 路径

```ts
import { createIllustratorEngine } from 'illustrator-pgf'

const engine = await createIllustratorEngine({
  workerFactory: () => new Worker(
    new URL('./illustrator-pgf.worker.ts', import.meta.url),
    { type: 'module', name: 'illustrator-pgf' },
  ),
})

const document = await engine.open(file, { signal })
console.log(await document.getSummary())
console.log(await document.getLayerTree())
console.log(await document.getSupportReport())

await document.render(canvas, {
  artboardId: (await document.getArtboards())[0]?.id,
  width: 1200,
  revision: 1,
})

document.dispose()
engine.dispose()
```

应用侧 Worker 入口只需调用 `installIllustratorWorker(self)`；见 `examples/illustrator-pgf.worker.mjs`。将 `new Worker(new URL(...))` 放在应用代码的 `workerFactory` 中，可让 Vite、Webpack 等构建器识别并独立打包 Worker。原生 ESM 且运行时文件保持相邻目录时，也可以不传 `workerFactory`，由 SDK 使用随包的 `worker-entry.js`。

生产浏览器模式不会在 Worker 加载失败时回退主线程解析。`forceDirect` 只应用于受控诊断或测试。

### 浏览器 zstd

默认 Worker 不访问网络。针对 `%AI24_ZStandard_Data`，宿主应在自定义 Worker 入口中注入本地 zstd 解码器：

```ts
import { installIllustratorWorker } from 'illustrator-pgf/worker-runtime'
import { decodeLocalZstd } from './local-zstd-adapter.js'

installIllustratorWorker(self, {
  zstdDecoder: (input, maxOutputBytes, signal) =>
    decodeLocalZstd(input, { maxOutputBytes, signal }),
})
```

解码器必须在输出过程中执行上限，而不是完整解压后再检查。

## Node

```ts
import {
  createIllustratorEngine,
  inspectIllustrator,
} from 'illustrator-pgf/node'

const inspection = await inspectIllustrator(bytes)
const engine = await createIllustratorEngine()
const document = await engine.open(bytes)

const scene = await document.exportSceneJson()
const svg = await document.exportSvg()

document.dispose()
engine.dispose()
```

Node 入口使用运行时自带 zlib；在 Node.js 提供原生 zstd API 时直接使用，否则对 zstd 文件返回明确的 `AI_CODEC_UNAVAILABLE`，不会误判成功。Node 与浏览器共享同一容器、词法、AST、语义和 Scene IR 实现。

## 低级 API

```ts
import {
  inspectIllustratorContainer,
  decodeIllustratorPrivateSource,
  lexIllustratorSource,
  parseIllustratorSource,
  lowerIllustratorAst,
  renderIllustratorScene,
} from 'illustrator-pgf'
```

`Lossless AST` 与 `Scene IR` 分离：前者负责保留原始输入和未知扩展，后者只表达已声明的语义能力与明确降级。

## CLI

```bash
illustrator-pgf inspect input.ai inspection.json
illustrator-pgf decode input.ai private-source.ps
illustrator-pgf ast input.ai ast.json
illustrator-pgf scene input.ai scene.json
illustrator-pgf support input.ai support.json
illustrator-pgf svg input.ai preview.svg
illustrator-pgf diff before.ai after.ai diff.json
illustrator-pgf benchmark input.ai 20 benchmark.json
illustrator-pgf operators operator-coverage.json
```

## Fidelity

- `exact`：由确定性结构规则证明；
- `high`：高还原实现，但仍需版本/语料范围约束；
- `partial`：主要语义保留，布局、效果或色彩可能近似；
- `structure-only`：身份、层级、参数或 opaque payload 保留，未宣称画面还原；
- `unsupported`：无法安全解释，但仍定位、保存并报告。

当前细分状态见 [`docs/support-matrix.md`](docs/support-matrix.md)，实现与未通过门禁见 [`docs/implementation-report.md`](docs/implementation-report.md)。

后续原生场景高保真开发按 [`docs/native-pgf-high-fidelity-development-plan.md`](docs/native-pgf-high-fidelity-development-plan.md) 执行。该文档给出了工作包、API 收口、Oracle、性能、安全和发布验收标准。

## 安全边界

解析器不执行 PostScript 程序，不使用 `eval`/`Function`，不执行 Illustrator 插件，不主动读取本地路径或访问网络。所有输入均受对象数、解压输出、token、statement、node、path point、嵌套、图片、渲染像素、Worker 时间与缓存预算约束。

## 开发

```bash
npm test
npm run build
npm run check
npm run inspect:sample
npm run benchmark:sample
```

## 许可证

MIT。项目与 Adobe 无隶属、赞助或背书关系；Adobe Illustrator 是其各自权利人的商标。
