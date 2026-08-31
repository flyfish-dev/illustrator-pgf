# 0.1.0 交付证据

## 自动化

- 最终测试：55 passed / 0 failed / 0 skipped；Node.js v24.20.0 下 TAP 总耗时 84.701875 ms。
- TypeScript：strict 构建和 `tsc --noEmit` 通过。
- 安装：Node.js 22/24 下 `npm ci --ignore-scripts` 与 `npm run check` 通过，0 个依赖漏洞。
- 样例：351 字节 Illustrator PostScript，136 个 token；Lossless AST 低级 API 与 session API 均逐字节往返。
- CLI：`inspect`、`ast`、`scene`、`support`、`svg`、`diff`、`benchmark`、`operators` 已执行。
- 结构差异：样例与自身比较 `equal: true`。
- 安全声明：样例未知可见操作符被保留并报告，整体 fidelity 降为 `partial`。

## npm tarball

- 文件：`flyfish-illustrator-pgf-0.1.0.tgz`
- 打包大小：138,389 bytes
- 解包大小：698,836 bytes
- 文件数：114
- npm SHA-1：`f5bcbc13a827f99110f86cf629651eefac58a94c`
- 完整性：`sha512-b61LF/i8xTNayRGX/r5o+7Bf2lax5gTr+sVAjyVE/3FnzBAIAr1FHtH5uyIN9Of4hKWDenVX6OH+iym+mB415Q==`

## 冷安装

在空目录使用 Node.js v24.20.0 从最终 tgz 安装并验证：

- `@flyfish/illustrator-pgf`
- `@flyfish/illustrator-pgf/node`
- `@flyfish/illustrator-pgf/worker`
- `@flyfish/illustrator-pgf/worker-runtime`
- `@flyfish/illustrator-pgf/file-viewer-adapter`
- 根入口和 Node 入口 `.d.ts`
- `illustrator-pgf` CLI

详细机器可读报告见 `docs/cold-install-report.json` 与 `docs/package-report.json`。

## 不能被本交付替代的稳定版门禁

当前没有用户提供的跨版本真实 Illustrator 授权语料、Illustrator 结构 Oracle、固定字体/ICC 的视觉 Oracle、三浏览器截图矩阵、长时间 fuzz 与规范目标设备性能报告。因此版本保持开发基线 0.1.0；结构保留或合成样例成功不会被描述成所有 Illustrator 特性的 `supported/high`。
