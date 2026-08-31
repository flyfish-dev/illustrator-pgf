# 安全模型

所有输入均视为恶意输入。

## 禁止行为

- 不执行任意 PostScript、Action、脚本或插件二进制；
- 不使用 `eval`、`Function` 或动态脚本注入；
- Worker 不主动访问网络；
- 不自动读取外链路径、本地文件或字体；
- SVG 不允许脚本、事件属性、未授权外链或 `foreignObject`。

## 预算

默认限制由 `DEFAULT_ILLUSTRATOR_LIMITS` 定义：文件/解码 128 MiB、PDF 对象 250,000、私有块 10,000、token 1,000,000、statement/node 250,000、path point 1,000,000、嵌套 256、单字符串 8 MiB、单图 64M pixels、总 raster 256 MiB、Worker 30s、render 32M pixels、cache 128 MiB。

宿主可向下收紧。任何向上放宽都必须显式配置。

## PDF 防护

- xref offset、entry width、object offset 与代数严格验证；
- 同一 revision 的重复 xref entry 拒绝；
- `/Prev` 循环拒绝；
- Page tree 循环拒绝；
- object stream 的 header、index、范围与重叠验证；
- stream 必须有可验证的直接或间接 `Length`；
- 加密 PDF private source 拒绝；
- filter 采用白名单；
- 解压输出上限传给运行时解码器。

## Worker 防护

request ID 重复、未知 session、结构化克隆错误和无效 response 都会 fail closed。执行中的 timeout/Abort 通过终止 Worker 抢占同步解析，而不是仅改变 Promise 状态。

## 已有自动化

测试包含畸形 xref/descriptor、代数错误、块序号错误、加密、未知 filter、解压上限、token/嵌套上限、SVG 注入不变量、Worker timeout/Abort/protocol error，以及 64 个确定性 mutation 输入的 total-inspection 检查。

## 尚待发布门禁

- 长时间 mutation fuzz 与覆盖率引导 fuzz；
- 真实字体/ICC/图片畸形 corpus；
- 三浏览器 CSP/no-network 自动化；
- 多文件长时间内存回落和 ImageBitmap 泄漏分析；
- 依赖/许可证/SBOM 自动生成。
