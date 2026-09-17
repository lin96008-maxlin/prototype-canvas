# 第三方组件说明

最终画布运行时内嵌以下开源组件，不依赖 CDN：

- `@dagrejs/dagre` 3.1.1，MIT License，用于有向图自动排版。
- `lucide` 1.44.0，ISC License，用于工具栏和操作图标。

开发与测试阶段使用 `esbuild`（MIT License）、`linkedom`（ISC License）和 `Playwright`（Apache-2.0 License）。这些开发工具不会作为外部依赖写入生成后的 HTML。
