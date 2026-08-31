# 格式版本与指纹

解析结果交叉记录：PDF 版本、`ContainerVersion`、`CreatorVersion`、`RoundtripVersion`、`%%AI8_CreatorVersion`、`%%AI5_FileFormat`、`%AI12_*`/`%AI17_*`/`%AI24_*` 特征、MIME、Creator、Illustrator namespace 与解码源码 SHA-256。

出现同一字段多个值时生成 `AI_VERSION_CONTRADICTION`，不会静默选择而不报告。

| 族 | 原生数据入口 | 当前策略 |
|---|---|---|
| AI3–AI8 | 文件本体 PostScript | 验证 PS header 与 Adobe Illustrator Creator；无执行地词法/语义解析 |
| AI9–AI10 | PDF private streams | 通过对象图找到 descriptor；块号连续性和 `NumBlock` 一致性校验 |
| CS–CC legacy | `%AI12…23_CompressedData` | 拼接 PDF 层解码块后，使用有界 zlib 解压 |
| AI 2020+ | `%AI24_ZStandard_Data` | Node 运行时有原生 zstd 时使用；否则明确报 unavailable；浏览器通过自定义 Worker 注入本地 decoder |
| 未来版本 | 未知 marker/operator | 安全提取可识别层；未知内容保留；fidelity 降级；不继承上一版本声明 |

当前 marker 和元数据规则是开发基线。每个真实版本首次进入支持矩阵前，必须添加原文件 SHA-256、保存选项、结构 Oracle、视觉 Oracle 和对应 fixture/test ID。
