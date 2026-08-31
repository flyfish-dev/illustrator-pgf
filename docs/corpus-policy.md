# Corpus Policy

每个 fixture manifest 至少记录：SHA-256、来源、许可证/公开权限、Illustrator 精确版本、操作系统、保存选项、PDF compatibility、字体、ICC、外链资源、特性、预期 diagnostics 和 Oracle 版本。

## 分类

- `corpus/synthetic`：项目代码生成或手写的最小语法/容器样本，只能证明实现逻辑，不证明真实版本兼容；
- private authorized corpus：客户或项目文件，仅在受控 CI/本地运行，不进入公开仓库；
- public authorized corpus：有明确再分发许可，可以随仓库发布；
- malformed/fuzz corpus：由公开或合成样本 mutation 产生，保存触发路径与最小化结果。

## 禁止

“脱敏”不自动等于可公开。客户文件、商业字体、受限 ICC、Adobe SDK、Illustrator 二进制或受限头文件不得进入 npm tarball 或公开 Git 历史。

## Oracle 目录约定

```text
fixture/
├── source.ai
├── manifest.json
├── expected.structure.json
├── expected.artboard-1@1x.png
├── expected.artboard-1@2x.png
├── expected.artboard-1.pdf
└── resources/
```

Golden 更新必须人工审阅，不允许测试自动覆写 expected 后直接通过。
