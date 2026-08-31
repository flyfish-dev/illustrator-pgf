# Illustrator 原生 PGF 高保真完善开发方案

> 文档状态：执行方案
> 适用仓库：`illustrator-pgf`
> 基线：`0.1.0` 主链路，加当前工作树中的真实 AI/AIT 兼容修复
> 上位规范：[`DEVELOPMENT-SPEC.md`](../DEVELOPMENT-SPEC.md)
> 本文不包含人力、工期或排期估算。

## 1. 交付目标

最终交付物是一套纯前端、离线可部署、可终止、带资源预算的 Illustrator 原生场景解析与渲染 SDK。它直接读取 AI/AIT 中的 PGF/private source，建立 Lossless AST、Scene IR 和资源图，并在浏览器 Worker 中输出画板、图层、可交互 Canvas、SVG 或 Scene JSON。

“高保真”在本项目中有明确含义：

- 原生模式的画面来自 PGF 场景，不借 PDF-compatible 页面冒充原生解析结果；
- 已声明支持的对象必须通过真实 Illustrator 文件、结构 Oracle 和视觉 Oracle；
- 缺字体、缺外链资源、缺 ICC、未知可见操作符或未实现效果时，API 必须给出准确诊断并降低 fidelity；
- PDF-compatible 表面可以作为默认显示、对照或文件内 fallback，但不能替代原生功能验收；
- 不执行任意 PostScript、Action、插件二进制，也不依赖服务端转换或公网资源。

第三方插件如果没有文件内 expanded/fallback appearance，不可能在浏览器里通用还原。此类对象的完成标准是完整保留身份、参数、源位置和影响范围，并明确标记为 `unsupported`，而不是伪造一个近似色块。

## 2. 当前基线

仓库已经具备可继续扩展的主链路，不需要推倒重写。

| 范围 | 当前状态 | 后续重点 |
|---|---|---|
| PDF/直接 PostScript 容器 | classic xref、xref stream、object stream、增量更新、PieceInfo/Private、分块与代数检查已实现 | 补齐跨版本真实语料和未来版本兼容策略 |
| 压缩 | none、deflate、Node zstd 已实现；浏览器允许注入本地 zstd decoder | 把浏览器 zstd 变成正式可复用子路径并加入独立门禁 |
| Lossless Lexer/AST | strict Latin-1、注释、复合值、binary、BeginData、未知语句和字节级重建已实现 | 在真实跨版本 corpus 上证明无未记录丢失 |
| 操作符注册表 | 当前报告含 172 个操作符：69 个 `high`、21 个 `partial`、82 个 `structure-only` | 把按名称登记升级为按版本、参数、状态和 Oracle 证明的覆盖 |
| 画板/图层/路径 | 已能从真实 AI/AIT 读取 4 个画板、5 个图层、336 个节点和 254 条路径 | 完成现代画板元数据、复杂层级、精确边界和大画布 |
| 文字 | point text 和部分 run/matrix 已进入 Scene IR | 完成 story、area/path/threaded text、字体解析和排版 |
| 图片、渐变、图案、符号、画笔 | 已保存节点、引用或 opaque resource | 实现参数解码、资源图和真实渲染 |
| 透明、混合、mask、overprint | 基础状态和 schema 已有 | 实现隔离组、knockout、opacity mask 和正确合成 |
| Canvas/SVG | 路径、裁切、基础文字和安全 SVG 已实现 | 建立确定性参考后端、分块渲染和专项视觉门禁 |
| Worker/API | session、Abort、timeout、dispose、ImageBitmap 已实现 | 增加能力查询、分级 fidelity、资源准备和流式进度 |
| File Viewer | 本地已验证 PDF/native 切换、图层显隐、移动端和浏览器 zstd | 等独立包发布新版本后移除消费端补丁并跑公开发布门禁 |

当前 `npm run check` 为 63 项测试通过。实现报告、支持矩阵和 release checklist 已同步当前状态；`docs/test-report.txt` 明确保留为 0.1.0 初始基线的 55 项 TAP 输出，不作为当前测试数量依据。

## 3. 完成口径

### 3.1 支持剖面

功能不使用一个笼统的“支持 AI”开关。发布矩阵至少维护以下剖面：

| 剖面 | 内容 | 允许的 fidelity |
|---|---|---|
| `container-lossless` | 容器、private source、解压、Lossless AST、版本指纹 | `exact` |
| `native-vector-core` | 画板、图层、组、路径、compound、clip、transform、实色 fill/stroke | `high` |
| `native-production` | 文字、图片、渐变、图案、透明、blend、mask、符号、常见画笔、ICC | `high` 或有来源的 `partial` |
| `native-advanced` | mesh、Live Effect、特殊对象、第三方插件及 expanded/alternate appearance | 按对象计算，允许显式 `unsupported` |

稳定版可以声明某个剖面和版本族已经通过，不能把一个版本的基础路径通过扩大成所有版本、所有对象均为高保真。

### 3.2 fidelity 必须按节点计算

文档级 fidelity 是各可见节点、资源和渲染决策的汇总。Scene IR 中的每个可见节点至少增加以下可审计信息：

```ts
interface IllustratorFidelityEvidence {
  level: IllustratorFidelity
  renderSource: 'native' | 'expanded' | 'alternate' | 'pdf-surface' | 'none'
  reasons: readonly string[]
  operatorIds: readonly string[]
  resourceIds: readonly string[]
  oracleFixtureIds: readonly string[]
}
```

以下情况禁止返回 `high`：

- 存在未知且可能影响画面的操作符；
- 字体被替换，且没有 outline/expanded appearance；
- 外链图片、ICC 或图案资源缺失；
- blend、mask、knockout、overprint 被忽略；
- 使用未经验证的颜色近似；
- 只画了边界框、占位色块或空画布；
- 解析器使用了 PDF surface，却把来源写成 native。

调用方不得通过参数强制抬高 fidelity，只能选择是否接受某个最低等级。

## 4. 目标架构

### 4.1 数据流水线

```text
Input bytes
  -> ContainerEnvelope
  -> DecodedPrivateProgram
  -> LosslessTokenStream / LosslessAST
  -> VersionProfile + SemanticProgram
  -> SceneIR + ResourceGraph + FidelityEvidence
  -> RenderPlan
  -> CPU reference renderer / optional accelerated renderer
  -> Canvas, ImageBitmap, SVG, Scene JSON, diagnostics
```

每层只做自己的事。容器层不推断文字，语义层不读取网络，渲染器不回头猜原始操作符。任何降级都必须能追溯到 source span、operator、resource 和最终节点。

### 4.2 模块拆分

当前 `src/semantic.ts` 已经承担注册表、graphics state、Scene Builder 和各类 handler。继续增加操作符会快速失控，应按领域拆开，但保持统一注册接口：

```text
src/
├── container/
├── syntax/
│   ├── lexer.ts
│   ├── ast.ts
│   └── binary-sections.ts
├── semantic/
│   ├── registry.ts
│   ├── version-profile.ts
│   ├── graphics-state.ts
│   ├── document.ts
│   ├── hierarchy.ts
│   ├── geometry.ts
│   ├── appearance.ts
│   ├── text.ts
│   ├── raster.ts
│   ├── gradients.ts
│   ├── patterns.ts
│   ├── symbols.ts
│   ├── brushes.ts
│   ├── transparency.ts
│   └── advanced.ts
├── resources/
│   ├── graph.ts
│   ├── embedded.ts
│   ├── linked.ts
│   ├── fonts.ts
│   └── color-profiles.ts
├── render/
│   ├── plan.ts
│   ├── bounds.ts
│   ├── cpu-reference.ts
│   ├── canvas2d.ts
│   ├── compositing.ts
│   ├── tiles.ts
│   └── svg.ts
└── worker/
```

迁移应保持公共 API 和 Scene schema 可升级。不要为了拆文件同时重写容器、AST 和 Worker；先用现有测试锁住行为，再逐模块搬迁。

### 4.3 渲染后端

必须保留一个确定性的 CPU reference renderer。它是视觉 Oracle 的对照实现，也是 GPU 不可用时的安全后备。WebGL/WebGPU 可以承担路径批处理、mesh、滤镜和大画布加速，但只有与 reference backend 的结构和视觉差异通过后才能启用。

渲染计划至少包含：

- 解析后的绘制顺序和 group stack；
- 画板裁切与共享画布坐标；
- 几何、paint、mask 和 compositing pass；
- 资源依赖及准备状态；
- 节点 bounds、脏区和 tile；
- fidelity 与 fallback 来源；
- 当前渲染预算和被拒绝原因。

## 5. 开发工作包

工作包按依赖关系排列。前一项的门禁未通过时，不应通过临时特判绕到后面。

### W0：冻结可复现基线

开发内容：

- 提交当前 container、lexer、AST、AI5 语义和真实 AI/AIT 修复；
- 更新 `CHANGELOG.md`、实现报告、测试报告、支持矩阵和 operator coverage；
- 将 File Viewer 使用的浏览器 zstd adapter 整理成独立、可测试的公共子路径，例如 `illustrator-pgf/browser-zstd`；
- npm 包同时保留无 codec 的核心路径，zstd 只进入 Worker 或显式子路径；
- 建立 `npm pack`、冷安装、Vite Worker 和原生 ESM smoke test。

验收标准：

- `npm run check`、冷安装和 tarball 文件清单通过；
- 真实 AI/AIT 的画板、图层、节点、路径和未知操作符统计进入固定 golden；
- deflate、zstd、无压缩 private source 都在浏览器 Worker 中通过；
- zstd 在产生输出时执行上限，超限返回 `AI_DECODE_OUTPUT_LIMIT`；
- 主线程包不包含 lexer、AST、semantic 或 zstd 实现；
- 文档中的测试数字、当前状态和支持边界与代码一致。

### W1：语料、Oracle 和覆盖台账

开发内容：

- 建立 public、private-authorized、synthetic、malformed/fuzz 四类 corpus；
- 为每个文件记录 SHA-256、授权、Illustrator 版本、平台、保存选项、字体、ICC、链接资源和特性标签；
- 建立结构 Oracle、raster Oracle 和资源 Oracle；
- 新增 `corpus validate`、`oracle compare`、`visual diff` 命令；
- operator coverage 增加版本范围、真实 fixture、结构 Oracle、视觉 Oracle 和最后验证版本；
- golden 更新必须生成审阅 diff，禁止测试自动覆写后直接通过。

语料最低要求：

- 每个声明支持的版本族至少有 5 个获授权真实文件，来源不少于 2 类；
- 每个版本族至少包含最小文件、交叉特性文件、生产复杂文件，以及适用时的 native-only、PDF-compatible、AIT；
- 每个支持特性有 1 个单特性 fixture 和至少 2 个交叉特性 fixture；
- 每个已知失败类别有最小化 malformed fixture；
- 商业字体、客户文件和受限资源只进入受控语料，不进入公开 Git 或 npm 包。

验收标准：

- corpus manifest 可以独立校验，哈希或资源缺失时立即失败；
- 每个 `high` operator 都能追溯到真实 fixture 和 Oracle；
- 每个 unknown operator 都进入按版本、可见性和出现频率汇总的报告；
- 结构和视觉报告记录 parser commit、Oracle 版本、浏览器、DPR、字体和 ICC；
- 没有授权证明的文件不能成为正式支持证据。

### W2：版本、语法和资源块

开发内容：

- 完成 AI3 至当前目标版本族的 marker、version fingerprint 和矛盾检查；
- 补齐真实 `%%BeginData`、pseudo-comment、binary、ASCII85、hex、procedure、dictionary 和 Illustrator 特有标记；
- 区分 prolog 定义、资源定义和实际绘制语句，绝不执行 PostScript；
- 对未来版本保留 unknown token/statement/resource，不自动套用上一版本 handler；
- 记录操作数消费范围，避免一个异常数组吞掉后续文档；
- 让每条 recovery 都生成稳定 diagnostic code。

验收标准：

- 目标 corpus 中 private source 解码后 SHA-256 与 Oracle 一致；
- token 和 statement 重组与源字节完全一致；
- 换行、注释、转义字符串和二进制段保持原始字节；
- 没有未记录的 statement 丢失；
- 未闭合容器、错误长度、异常嵌套和版本矛盾可稳定恢复或拒绝；
- 任意接受的未知语法都能从 AST 导出，不因 Scene IR 不支持而丢失。

### W3：画板、层级和几何核心

开发内容：

- 解析现代 ArtboardArray、名称、UUID、bounds、bleed、ruler origin、锁定和选择状态；
- 保留共享画布坐标、large canvas scale 和一次性的 Y 轴转换；
- 完成 layer/group/compound/clip 的顺序、嵌套、visible、locked、printable、preview、isolation 和 layer color；
- 完成 open/closed path、line/cubic、smooth/corner point、compound holes、fill rule 和 clipping path；
- 实现 stroke cap、join、miter、dash、dash offset 和对齐；
- 使用解析几何计算 cubic bounds，不用控制点包围盒代替真实 bounds；
- 图层显隐只重绘受影响的 pass/tile。

验收标准：

- 画板、层级、节点顺序和状态与结构 Oracle 完全一致；
- 坐标、控制点和 transform 的绝对误差不超过 `0.01pt`；
- cubic 和 stroke bounds 与 Oracle 的误差不超过 `0.05pt`；
- nonzero/evenodd、compound hole 和 clip 的专项 fixture 全部通过；
- 基础矢量在 1px 抗锯齿容差带外的差异像素不超过 0.25%，SSIM 不低于 0.995；
- 单图层开关不会重建整个 AST/Scene，也不会泄漏旧 ImageBitmap。

### W4：Appearance、渐变、图案和颜色

开发内容：

- 将 fill/stroke 从单一 graphics state 升级为有顺序的 Appearance stack；
- 支持多 fill、多 stroke、对象 opacity、stroke alignment 和 appearance 来源；
- 解码 linear/radial gradient、stop、midpoint、spread、transform 和引用；
- 解码 pattern definition/instance、pattern transform、裁切和循环引用；
- 保留 Gray、RGB、CMYK、Lab、Spot、tint 和 alternate color；
- 提供按需加载的本地 ICC color provider，区分 screen、ICC-managed、soft-proof 和 overprint preview；
- 每次近似转换都记录 profile、intent 和 fallback 公式。

验收标准：

- Appearance 顺序、fill/stroke 数量和资源引用与 Oracle 一致；
- gradient stop 位置误差不超过 `0.001`，midpoint 误差不超过 `0.005`；
- pattern 原点和 transform 误差不超过 `0.05pt`；
- 固定 profile 下 Gray/RGB 实色的 `Delta E 2000` P95 不超过 1；
- CMYK/Spot 软打样的 `Delta E 2000` P95 不超过 2，最大值不超过 5；
- 缺 ICC、Spot alternate 或 overprint 规则时不能返回 `high`；
- 色彩、渐变、图案的视觉 diff 分开统计，不用整张图平均值掩盖局部错误。

### W5：文字与字体

开发内容：

- 完成 point、area、path、threaded text 和多 frame story；
- 解析 character run、paragraph run、方向、对齐、缩进、行距、tracking、kerning、baseline shift、horizontal/vertical scale；
- 建立 Illustrator 字体引用到 PostScript name、OpenType face、嵌入子集和宿主字体的解析链；
- 将 shaping 和 line layout 分开；shaping 可使用经过许可证审查的本地 WASM，排版规则由本项目实现并测试；
- 支持横排、竖排、path text、area overflow 和 threaded frame continuation；
- 优先使用文件内 outline/expanded appearance；字体替换必须暴露替换结果；
- 禁止自动访问系统路径或公网字体。

验收标准：

- story、frame、run、字符内容、样式和顺序与结构 Oracle 一致；
- 固定同一字体文件时，glyph ID 与换行位置完全一致；
- glyph origin、advance、baseline 和 frame inset 的误差不超过 `0.05pt`；
- 文本 bounds 误差不超过 `0.25pt`；
- point、area、path、threaded、横排和竖排分别有真实专项 fixture；
- 缺字体时返回字体引用、缺失原因和受影响节点，fidelity 最高只能是 `partial`；
- 不得因文字内容可提取就把排版标为 `high`。

### W6：嵌入图片和外链资源

开发内容：

- 解析 embedded raster、placed/linked image、像素尺寸、DPI、crop、alpha、transform 和 ICC；
- 对 JPEG、PNG、TIFF、PSD/EPS 等资源按实际容器建立 decoder capability，不按扩展名猜测；
- `IllustratorResourceResolver` 只接受宿主显式提供的映射、File/Blob 或授权句柄；
- 资源读取受单文件、总字节、像素、递归深度和超时预算；
- 缺失或损坏资源产生稳定诊断，并保留原引用信息；
- 图片解码、颜色转换和缩放在 Worker/OffscreenCanvas 中完成。

验收标准：

- 资源 ID、链接路径摘要、crop、alpha 和 transform 与 Oracle 一致；
- 相同解码器和 ICC 环境下，嵌入图片有效区域的 SSIM 不低于 0.995；
- crop/clip 边界误差不超过 1 个输出像素；
- 透明边缘单独检查 alpha，不用白底合成掩盖错误；
- 缺外链资源时画面不得无诊断地留空，也不得自动联网；
- 图片炸弹、超大尺寸和畸形 metadata 在分配 RGBA 前被拒绝。

### W7：透明、混合、mask 和 overprint

开发内容：

- 实现 object/group opacity、常见 blend mode、transparency group、isolated group 和 knockout；
- 区分 clipping mask、alpha opacity mask 和 luminosity mask；
- compositing pass 使用预乘 alpha，并明确颜色空间；
- overprint 与 Spot/CMYK 管线统一处理，不在普通 sRGB 混合后补丁式模拟；
- 保存 flatten、expanded 和 alternate appearance 的来源；
- 对超出预算的离屏层返回诊断，禁止静默忽略 mask/effect。

验收标准：

- 每种支持的 blend mode 至少有实色、透明渐变和嵌套组三类 fixture；
- mask 边界、反相、luminosity 和 transform 与 Oracle 一致；
- 透明/混合专项图在容差带外的差异像素不超过 1%，SSIM 不低于 0.99；
- isolated、knockout 和普通组的输出可被测试明确区分；
- overprint fixture 在固定 CMYK/Spot profile 下通过分色和合成 Oracle；
- 任一被忽略的可见 compositing 语义都会把受影响节点降到 `partial` 或更低。

### W8：符号和画笔

开发内容：

- 建立 symbol definition/instance、嵌套 transform、override 和循环引用检测；
- 支持 calligraphic、scatter、art、pattern 和 bristle 等目标画笔类型，按真实 corpus 决定声明范围；
- 对文件内已有 expanded path 优先复用，并标记来源；
- 没有 expanded appearance 时，原生画笔参数必须生成确定性几何；
- 资源实例共享 immutable definition，避免为每个 instance 复制完整节点树。

验收标准：

- symbol definition 数量、instance 引用、transform 和 override 与 Oracle 一致；
- 循环引用在展开前被拒绝并产生稳定错误；
- 每种声明支持的画笔都有单路径、曲线路径、闭合路径和 transform fixture；
- expanded/native 两条路径分别进入 fidelity evidence；
- 画笔轮廓视觉 diff 达到复杂外观门禁，且缩放后无明显接缝或顺序错误。

### W9：Mesh、Live Effect 和特殊对象

开发内容：

- 解析 gradient mesh 的拓扑、控制点、节点颜色和透明度，建立自适应细分；
- 为 envelope、Live Paint、graph、3D、变形和已知 Illustrator 特殊对象建立明确节点类型；
- Live Effect 按“原生参数、expanded fallback、alternate content、opaque unsupported”顺序处理；
- 第三方插件保存插件 ID、payload 摘要、source span、fallback、影响节点和不支持原因；
- 不加载或执行任何插件、Action、脚本或 PostScript procedure。

验收标准：

- mesh 拓扑和控制点与结构 Oracle 一致，细分误差有固定上限；
- 使用 expanded/alternate 时，API 和 UI 能看见真实来源；
- 没有 fallback 的特殊对象不会生成假画面；
- 每种声明支持的高级对象都有独立支持矩阵、真实 fixture 和视觉报告；
- 插件对象即使 unsupported，也必须在 AST、Scene IR、诊断和导出 JSON 中可定位。

### W10：大文件、增量渲染和缓存

开发内容：

- 将 parse、resource prepare、render plan 和 raster 分成可观测阶段；
- 为节点建立空间索引和精确 bounds，按画板、viewport 和 tile 裁剪；
- 支持首画板优先、渐进可见、后台资源准备和取消；
- 图层显隐、画板切换和缩放复用 Scene IR、资源和 tile；
- 所有缓存按字节计量，使用 LRU 或等价策略回收；
- 大 Buffer 只转移一次，禁止主线程和 Worker 同时保留多个完整副本；
- Worker、codec、color backend 和可选 GPU backend 保持按需加载。

验收标准：

- 10 MiB、50,000 节点文档的 P95 完整解析不超过 1.5 秒；
- 同一文档首画板 P95 可见时间不超过 2.5 秒；
- 主线程没有超过 50ms 的 parser 长任务；
- 10,000 节点交互目标为 60fps，100,000 节点启用 tile 后不低于 30fps；
- 连续 20 次 open/render/dispose 后，强制 GC 测试中的 retained heap 不超过稳定基线的 110% 加 16 MiB；
- Abort、timeout 或 viewer destroy 会终止实际 Worker 计算并关闭待处理 ImageBitmap；
- 包体积报告分别列出 main client、Worker、zstd、color backend 和可选 renderer 的 raw/gzip/brotli。

### W11：公共 API 和快速接入

开发内容：

- 保持 `inspectIllustrator()`、`createIllustratorEngine()` 和 `IllustratorDocument` 主入口；
- 增加 capability、prepare、progress、fidelity evidence 和资源状态 API；
- 把 schema、Worker runtime、浏览器 zstd 和 Node runtime 做成稳定 exports；
- 资源解析器、字体解析器和 color provider 使用显式接口，禁止依赖 File Viewer 内部类型；
- 所有诊断 code、Scene schema 和 support report 版本化；
- File Viewer adapter 只调用公共 API，不引用 `dist/src/*` 等内部路径。

目标接口：

```ts
const engine = await createIllustratorEngine({
  workerFactory,
  limits,
  fontResolver,
  resourceResolver,
  colorProvider,
  defaultTimeoutMs: 30_000,
})

const document = await engine.open(file, {
  mode: 'native',
  signal,
  minimumFidelity: 'partial',
  onProgress(event) {},
})

const capabilities = await document.getCapabilities()
const artboards = await document.getArtboards()
const layers = await document.getLayerTree()
const evidence = await document.getFidelityEvidence()

await document.prepare({
  artboardId: artboards[0]?.id,
  features: ['fonts', 'images', 'color'],
  signal,
})

await document.render(canvas, {
  artboardId: artboards[0]?.id,
  hiddenLayerIds: [],
  width: 1600,
  background: '#fff',
  colorMode: 'screen',
  revision: 1,
  signal,
})

document.dispose()
engine.dispose()
```

验收标准：

- 浏览器 ESM、Vite、Webpack、Worker URL、自定义 Worker factory 和 Node CLI 均有冷安装 smoke；
- package exports 不暴露内部构建目录；
- codec、font、resource、color 和 render backend 均可独立替换；
- API 中能区分 native、expanded、alternate 和 PDF surface；
- capability 和 fidelity 来自解析证据，调用方不能伪造；
- 所有示例离线运行，不请求 CDN；
- API 变更生成 machine-readable diff 和迁移说明。

### W12：安全、fuzz 和浏览器矩阵

开发内容：

- 分别对 PDF 对象模型、private block、解压、lexer、AST、semantic、resource 和 renderer 建立 fuzz harness；
- 增加字体、ICC、图片、gradient、pattern 和资源循环畸形语料；
- 检查 CSP、Worker MIME、WASM MIME、Shadow DOM、移动端、DPR、多 viewer、多文件连续打开和 no-network；
- 生成依赖锁定、许可证清单、SBOM 和供应链扫描报告；
- fatal error 统一释放 Worker、WASM、ImageBitmap、canvas 和 resolver pending request。

验收标准：

- 每个 fuzz target 至少完成 1,000 万次执行或等价覆盖率门禁，无未处理崩溃、死循环和无界内存；
- 所有发现的问题都保存最小化 fixture 和回归测试；
- Chromium、Firefox、WebKit 的打开、渲染、图层开关、取消、销毁和连续打开门禁通过；
- CSP 环境不需要 `unsafe-eval`，运行时无公网请求；
- 解压炸弹、图片炸弹、资源循环和巨大坐标在危险分配前终止；
- fatal error 后 pending request 数量归零，Worker 不再运行。

## 6. Oracle 与视觉验收规则

### 6.1 Oracle 生成

Oracle 是开发和验收工具，不进入浏览器发布包。每个 fixture 目录至少包含：

```text
fixture-id/
├── source.ai
├── manifest.json
├── expected.structure.json
├── expected.resources.json
├── expected.artboard-1@1x.png
├── expected.artboard-1@2x.png
├── expected.artboard-1.pdf
└── resources/
```

Oracle 输出要记录 Illustrator 精确版本、平台、字体文件哈希、ICC 哈希、导出参数和 Oracle schema 版本。不得提交 Adobe SDK、Illustrator 二进制、受限头文件或未授权素材。

### 6.2 指标

全局 `SSIM >= 0.98` 只作为旧规范的最低发布底线，不能作为单个功能关闭条件。开发验收使用更严格的分层指标：

| 对象 | 结构门禁 | 视觉门禁 |
|---|---|---|
| 基础路径/裁切/实色 | 坐标 `<= 0.01pt`，bounds `<= 0.05pt` | SSIM `>= 0.995`，容差带外差异 `<= 0.25%` |
| 文字 | glyph、run、换行一致，位置 `<= 0.05pt` | 文本区域 SSIM `>= 0.99`，另报 baseline/bounds |
| 图片 | transform/crop/alpha 一致 | 有效区域 SSIM `>= 0.995`，alpha 单独比较 |
| 渐变/图案 | stop、midpoint、transform、引用一致 | SSIM `>= 0.99`，差异像素 `<= 1%` |
| 透明/blend/mask | group stack 和 mask 引用一致 | SSIM `>= 0.99`，差异像素 `<= 1%` |
| 高级效果/fallback | 来源和影响节点一致 | 按该效果专项阈值，不得只检查非空像素 |

所有视觉报告必须输出原图、实际图、热图、mask、指标 JSON 和失败区域。抗锯齿容差带最多 1px；容差带不能覆盖实色内部、文字基线偏移或大面积颜色错误。

### 6.3 浏览器差异

浏览器不以整图 hash 相等为目标。固定字体、ICC、DPR 和 reference backend 后，每个浏览器分别与自己的批准 golden 比较，同时用结构指标约束几何和文字。浏览器升级造成 golden 变化时必须人工审阅热图，不允许自动接受。

## 7. 操作符完成流程

每个新增或升级操作符按同一流程处理：

1. 在真实文件中确认版本、参数栈和上下文，不从名称猜语义。
2. 添加最小 synthetic fixture，锁住 lexer/AST 和参数消费范围。
3. 添加获授权真实 fixture 及结构 Oracle。
4. 在对应领域模块实现 handler，声明 state reads/writes、产物和 fidelity。
5. 更新 Scene schema、validator 和 diagnostic code。
6. 增加单元、交叉特性、视觉、畸形输入和预算测试。
7. 生成 operator coverage 和 unknown operator diff。
8. 只有结构、视觉、浏览器和安全门禁全部通过后，才能把该版本范围提升到 `high`。

建议 issue 模板：

```md
## Feature / operator

- Version family:
- Operator / resource marker:
- Source span example:
- Known operand forms:
- Graphics-state reads/writes:
- Scene node/resource output:
- Native / expanded / alternate behavior:
- Public fixture:
- Private fixture:
- Structure Oracle:
- Visual Oracle:
- Malformed cases:
- Limits affected:
- Diagnostics:
- Fidelity before / after:
- Acceptance evidence:
```

## 8. 发布门禁

### Gate A：可复现基线

- 当前真实 AI/AIT 修复已进入发布版本；
- 63 项及新增测试全部通过；
- 浏览器 zstd、Worker、tarball、冷安装和 File Viewer 本地集成通过；
- 报告、支持矩阵和代码一致。

### Gate B：Native Vector Core

- `container-lossless` 和 `native-vector-core` 在目标版本 corpus 上通过；
- 画板、层级、路径、clip、transform、实色和 stroke 达到 W3 指标；
- unknown 可见操作符全部可定位并降低 fidelity；
- 三浏览器和目标设备性能门禁通过。

### Gate C：Native Production

- 文字、图片、渐变、图案、颜色、透明、mask、符号和声明支持的画笔通过各自 Oracle；
- 字体、资源和 ICC 缺失路径全部可诊断；
- 大文件、缓存、取消和内存回落通过；
- File Viewer 只通过公开 API 接入，无消费端私有补丁。

### Gate D：稳定发布

- 版本/特性支持矩阵没有无证据的 `high`；
- 所有发布包、Worker、codec、WASM、字体、ICC 和样本许可证可审计；
- fuzz、SBOM、三浏览器、性能、内存、结构和视觉报告齐全；
- advanced 对象要么有通过门禁的 native/expanded/alternate 输出，要么明确 `unsupported`；
- README、API、support matrix、File Viewer 和 npm 描述使用同一口径。

任何一个 Gate 只证明该 Gate 定义的范围，不能提前宣传后续 Gate 已完成。

## 9. File Viewer 对接要求

独立仓发布新版本后，File Viewer 应执行以下收口：

- 用正式版本替换 `patches/illustrator-pgf@0.1.0.patch`；
- 保持 `illustratorMode: 'auto' | 'pdf' | 'native'`；
- `auto` 默认显示已验证的 PDF-compatible 表面，同时允许进入 native 结构；
- native-only 文件可以不安装 PDF renderer；
- Worker、zstd、color backend 和许可证由 asset manifest 复制到本地；
- UI 显示画板、图层、当前 render source、fidelity 和 unsupported summary；
- PDF/native 反复切换不复用已 detach 的 Buffer，不泄漏旧 session；
- 390px 移动视口、触控拖动、图层抽屉、打印和缩略图继续进入浏览器门禁；
- 支持矩阵只在独立 SDK 对应 Gate 通过后升级。

## 10. 开发交接清单

接手开发前：

- [ ] 阅读 `DEVELOPMENT-SPEC.md`、本方案、支持矩阵、安全模型和 corpus policy；
- [ ] 确认当前 HEAD、工作树修复和 npm 发布版本，不从旧 `0.1.0` tarball 重新覆盖；
- [ ] 运行 `npm run check`，保存基线测试和 operator coverage；
- [ ] 验证真实 AI/AIT fixture 的 SHA-256、许可和当前结构统计；
- [ ] 确认 File Viewer 当前依赖版本与消费端 patch 状态。

每个功能合入前：

- [ ] 有真实 fixture、结构 Oracle 和明确的版本范围；
- [ ] AST 仍可字节级重建；
- [ ] handler 有操作数 schema、状态读写、fixture ID 和 diagnostic；
- [ ] Scene schema、validator、support report 和 fidelity evidence 已更新；
- [ ] 单元、交叉、视觉、畸形和预算测试已通过；
- [ ] unknown operator、包体积和性能没有无解释回退；
- [ ] 文档没有把 fallback 或非空画面写成 native high fidelity。

准备发布时：

- [ ] `npm run check`、tarball dry-run 和冷安装通过；
- [ ] corpus、operator、结构、视觉、性能、内存、fuzz、浏览器报告已生成并审阅；
- [ ] Worker/codec/WASM/字体/ICC/许可证清单完整；
- [ ] API diff、Scene schema、diagnostic code 和迁移说明一致；
- [ ] File Viewer 使用公开 API 完成真实文件和浏览器回归；
- [ ] 支持矩阵只声明已经通过的版本与特性。

## 11. 不接受的完成证据

以下结果都不能单独证明原生 PGF 高保真已经完成：

- 某个 demo 能打开；
- PDF-compatible 页面显示正常；
- Canvas 有非透明像素；
- 只对 synthetic fixture 通过；
- 能列出图层、画板或节点数量；
- AST 没报错，但 unknown 可见操作符未处理；
- 本地 Chromium 通过，Firefox/WebKit 未验证；
- 视觉“看起来差不多”，没有结构 Oracle、热图和指标；
- 为某个样例文件写路径、图层名、页码或颜色特判；
- 忽略字体、ICC、mask、blend 或插件后仍返回 `high`；
- File Viewer 通过内部路径或消费端补丁才能运行；
- 构建成功，但 tarball、离线资源、许可证或冷安装未验证。

开发人员应以本方案的 Gate 和逐项验收结果为准。未通过的功能继续保留 `partial`、`structure-only` 或 `unsupported`，直到证据补齐。
