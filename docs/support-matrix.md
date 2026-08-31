# 支持矩阵（0.1.0 开发基线）

状态定义：`implemented` 表示代码与合成/畸形测试已通过；`oracle-pending` 表示尚未由真实 Illustrator 结构/视觉 Oracle 证明，不能标记为 `supported/high` 的正式发布口径。

| 范围 | 当前实现 | Fidelity 上限 | 门禁状态 |
|---|---|---:|---|
| AI3–AI8 直接 PostScript 容器 | Creator 验证、直接进入 Lossless Lexer | high | implemented；真实版本语料 pending |
| AI9–AI10 PDF private data | Catalog/PieceInfo、块排序、PDF filters | high | implemented；真实语料 oracle-pending |
| CS–CC legacy deflate | `%AI12…23_CompressedData` + bounded zlib | high | implemented；真实语料 oracle-pending |
| AI 2020+ zstd | `%AI24_ZStandard_Data`；Node 原生 zstd 能力探测；浏览器可注入本地 decoder | high | implemented envelope；浏览器 WASM/真实语料 oracle-pending |
| AIT 身份 | 容器可解析；模板专属 metadata 尚未系统建模 | partial | oracle-pending |
| classic xref | 完整对象定位与代数验证 | high | tested |
| xref stream | `/W`、`/Index`、filter、trailer | high | tested |
| object stream | `/ObjStm`、索引和边界 | high | tested |
| incremental update | `/Prev` 链与新版本优先 | high | tested |
| Lossless token/AST | 顺序、raw、span、注释、字符串、hex/ASCII85/binary、未知语法 | exact | byte-roundtrip tested |
| 画板 | BoundingBox、合成 `%AIArtboard`、部分 ArtboardArray 提取；共享画布 | partial | real modern metadata oracle-pending |
| 图层/组 | `Lb/Ln/LB`、`u/U`、状态和层级 | high | synthetic tested；version corpus pending |
| Path/CompoundPath | move/line/cubic、close、fill/stroke、evenodd/nonzero、`*u/*U` | high | synthetic tested |
| ClipGroup | clipping path 与结构化 clip group | high | synthetic tested |
| Transform | matrix composition；节点保存原矩阵 | high | synthetic tested |
| Gray/RGB/CMYK/Spot | 原色空间保留；Canvas/SVG 对 CMYK/Spot 明确近似 | partial | ICC/Oracle pending |
| 多 fill/stroke Appearance schema | IR schema 已支持；原生多外观操作符覆盖不足 | structure-only | oracle-pending |
| Point text | run、font PS name、size、matrix、内容 | partial | font/layout oracle-pending |
| Area/path/threaded text | 类型与 payload 可保留；完整排版未实现 | structure-only / partial | oracle-pending |
| Embedded/placed image | 节点、resource、transform/尺寸线索 | structure-only | pixel/link decoder pending |
| Gradient/pattern | 独立 opaque resource 与引用诊断 | structure-only | native parameter/renderer pending |
| Symbol/brush | IR 节点/schema 存在；操作符覆盖不足 | structure-only | pending |
| Opacity/blend/overprint | 基础状态操作符；Canvas/SVG 可用子集 | partial | transparency oracle-pending |
| Opacity mask/knockout/isolation | schema 存在，完整操作符/渲染未覆盖 | structure-only | pending |
| Gradient mesh | 节点/schema；无原生网格解码器 | structure-only | pending |
| Live Effect/plugin object | opaque payload、diagnostic/fallback 字段 | structure-only / unsupported | plugin/appearance oracle-pending |
| Canvas2D | path、clip、group、text、基础 blend | partial | automated mock + browser visual pending |
| OffscreenCanvas/ImageBitmap | Worker API 和 transferable response | partial | protocol tested；browser matrix pending |
| SVG | path/group/text/clip、安全清洗 | partial | deterministic/security tested；visual pending |
| File Viewer adapter | auto/pdf/native 路由与 native session | partial | SDK API-level tested manually; host integration pending |

## 不得升级为正式 `supported/high` 的原因

当前仓库没有获授权的跨版本真实 Illustrator corpus、Illustrator Oracle 导出的结构真值、固定字体/ICC 的视觉参考、三浏览器截图矩阵和规范中的目标性能设备报告。因此，此表不会把合成 fixture 成功等同于格式级完整支持。
