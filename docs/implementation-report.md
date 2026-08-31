# 实现与验收报告

## 结论

0.1.0 已实现从容器识别、私有块提取/解压、Lossless Lexer/AST、版本化语义 lowering、Scene IR、Canvas/SVG、Worker/session、Node CLI 到 File Viewer 适配器的完整工程主链路。

当前可以作出的强保证：

1. 对已接受的 strict Latin-1 Illustrator source，token 拼接与 AST 重建必须与输入字节一致，否则内部不变量直接失败；
2. 每个 operator statement 都进入已注册处理器，或进入 unknown diagnostic、unsupported inventory，并在可能影响可见内容时产生 `UnknownNode`；
3. PDF private source 只通过对象模型和 Catalog/PieceInfo 证据提取；
4. 所有解压、token、statement、node、path、嵌套、时间和渲染均受预算；
5. Worker 的 Abort/timeout 会终止实际执行；
6. 未解析资源不以空白成功、边界框或占位色块冒充高还原。

当前不能作出的声明：**“所有 Illustrator 版本、操作符、文字排版、效果和颜色均已达到正式 supported/high”。** 该声明需要真实跨版本 corpus、Illustrator 结构 Oracle、视觉 Oracle、固定字体/ICC、三浏览器和目标设备性能报告；这些资产未随本次输入提供。

## 已实现模块

- `types/limits/errors/util`：稳定类型、预算、严格字节映射、SHA-256；
- `codecs/node-codecs`：PDF filters、predictor、zlib/zstd；
- `pdf`：classic/xref stream/object stream/incremental/indirect Length；
- `container`：direct PS、PieceInfo/Private、AIPrivateData、none/deflate/zstd；
- `lexer/ast`：无损 token、复合值、资源块、精确 span；
- `semantic/scene`：版本注册表、graphics state、层级、Path/Text/Resource/Unknown、schema validator；
- `render-svg/render-canvas`：安全输出和明确近似诊断；
- `engine/worker-*`：会话、transferable、revision、timeout、Abort、dispose；
- `node/cli`：inspect/decode/ast/scene/support/svg/diff/benchmark/operators；
- `integrations/file-viewer`：无内部依赖的路由与 native session。

## 自动化结果

当前工作树已重新执行 `npm run check`：**63 tests / 63 passed / 0 failed**；TypeScript strict build 和 npm tarball dry-run 均通过。`docs/test-report.txt` 保留 0.1.0 初始基线的 55 项 TAP 输出，不再作为当前测试数量依据；CLI 产物见 `corpus/synthetic/minimal.*`，操作符覆盖见 `docs/operator-coverage.json`。

覆盖包括：

- classic xref、xref stream、object stream、incremental update；
- PDF Flate 和间接 Length；
- private none/deflate/zstd；
- marker 与 codec header 紧邻、alternate private block 前缀；
- NumBlock/序号/代数/filter/encryption/page cycle；
- CR/LF/CRLF、嵌套字符串、name escape、hex/ASCII85/binary；
- Illustrator `%%BeginData`、pseudo-comment resource 和 gradient data mark；
- 字节级 AST roundtrip 和 trailing/unknown 保存；
- 路径、compound、clip、extended layer flags、AI5 custom color/opacity、text matrix、资源降级；
- SVG 安全/确定性和 Canvas 调用；
- Worker session、Abort、timeout、协议错误与 dispose；
- 64 个确定性 mutation 输入。

## 与规范完成定义的差距

| 门禁 | 当前 |
|---|---|
| 代码、类型、Worker、运行时资产 | 主链路完成；浏览器 zstd 需宿主注入本地 decoder |
| 真实语料矩阵 | 未提供，pending |
| Lossless AST 无未记录丢失 | 合成/测试输入通过；真实 corpus 待扩展 |
| Scene IR 结构 Oracle | schema validator 已有；Illustrator Oracle pending |
| 视觉 Oracle | SVG/Canvas 自动化已有；Illustrator pixel/SSIM pending |
| 诊断/fidelity | 已实现 |
| 性能/内存 | CLI benchmark 已实现；规范目标设备报告 pending |
| fuzz/no-network/三浏览器 | mutation 基线已有；长 fuzz 与 browser matrix pending |
| API/文档/包/许可证 | 完成；tarball、子路径 exports、`.d.ts`、CLI 和冷安装通过 |
| File Viewer | 独立适配器完成；本地主仓真实 AI/AIT、PDF/native 切换、图层、移动端和浏览器 zstd 已验证；独立包发布与公开发布门禁 pending |

因此版本保持 `0.1.0` 开发基线，不发布为夸大的“稳定完整版”。
