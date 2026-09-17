# 原型 HTML 画布（Prototype Canvas）

[![持续集成检查](https://github.com/lin96008-maxlin/prototype-canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/lin96008-maxlin/prototype-canvas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-16a34a.svg)](./LICENSE)
[![Codex Skill](https://img.shields.io/badge/Codex-Skill-4967ff.svg)](./prototype-canvas/SKILL.md)
[![Single HTML](https://img.shields.io/badge/Output-Single_HTML-0f766e.svg)](#最终交付是什么)

![产品经理猪有解｜开源 AI 工具与产品方法](./docs/images/brand-banner.png)

让原型自己长出一张地图，而不是让产品经理在几十个页面、标签页和弹窗之间反复点开寻找。

单 HTML 原型做起来很快，做大了却很难讲清楚：这个文件里到底有多少页面、哪些是同一件事的不同状态、每个页面又是由哪个按钮点进去的。评审时说不清范围，交接时讲不明白入口，验收时更是没人敢确认「是不是都覆盖到了」。

Prototype Canvas 把已有原型通读一遍，生成一张可导航的画布：**思维导图**负责讲清层级与关系，**快照图**直接展示每个页面真实长什么样，双击任意节点就能进入原型对应页面。它还能在 localhost 编辑工作台里调整结构、补充页面说明、按业务空间分别管理关联，最后导出一份新的自包含 HTML。

**核心定位：一份 HTML，既是可交互原型，也是一张能讲清全局的页面地图。**

## 核心价值

- **一眼看清全局**：起点、导航、页面、标签页、抽屉、弹窗各有形状和颜色，层级线表达「谁属于谁」，橙色虚线表达「谁和谁有关联」。
- **页面预览是真的**：快照模式下每个节点展示的是那个页面真实的运行画面，不是截图标号，也不用再对着文件名猜内容。
- **双击直达页面**：从画布双击节点，直接落到原型对应页面；要改关联时，在原型里点一遍就能重新定位，不用手写选择器。
- **不同业务空间各画一张**：多租户、多区域、多角色的原型，可以按用户类型分别生成画布，同一份原型也能各看各的。
- **把说明写进画布**：页面用途、使用对象、业务结果直接挂在节点上，评审和交接时不用再另开一份文档对照。
- **离线、可传递、无服务依赖**：导出的 HTML 内嵌原型与画布运行时，断网也能打开、双击和导出。

## 功能展示

> 以下截图使用演示数据（通用 CRM 客户经营平台），仅用于展示 Skill 的交互与呈现能力。

### 思维导图模式：看清页面与交互的层级

从系统起点出发，一级导航、页面、下钻交互逐层展开。节点类型一眼可辨，橙色虚线是需要单独说明的跨页面关联，而不是层级归属。

![思维导图模式](./docs/images/01-mindmap.png)

### 快照模式：每个页面都有真实预览

同一棵树切换成快照视图，每个节点换成该页面真实运行画面。适合评审开场先整体过一遍，也适合交接时快速确认范围。

![快照模式](./docs/images/02-snapshot.png)

### 节点编辑：在画布里改结构、写说明

选中节点即可修改页面名称、节点类型和页面说明。说明支持富文本，保存后随画布一起交付；节点也能新增、拖动换层级、复制子树或删除。

![节点编辑](./docs/images/03-node-editing.png)

### 用户类型：不同业务空间各有一张画布

按用户类型（租户、部门、岗位、角色等）组织画布。每个末级用户类型对应一张独立画布，页面结构与关联互不干扰，可以分别编辑和导出。

![用户类型管理](./docs/images/04-audience.png)

### 快捷键：常用操作都有键位

新建下级、调整顺序、复制子树、建立联系、撤销重做都支持快捷键；滚轮平移、Ctrl + 滚轮缩放、空格拖拽画布，符合常见的导图操作习惯。

![快捷键](./docs/images/05-shortcuts.png)

## 主要能力

| 领域 | 能力 |
| --- | --- |
| 结构识别 | 通读原型源码与运行行为，识别页面、导航层级、标签页、抽屉、弹窗、步骤和页面状态 |
| 结构探查 | 在浏览器里逐个点击真实入口，按实际结果确认「哪个入口能走到哪个页面」，不靠猜 |
| 思维导图 | XMind 式主题树与联系线分离；拖动换层级、同级排序、拆成独立树、框选整组拖动 |
| 页面快照 | 每个节点自动生成真实运行画面；相同画面自动去重，只保留一份资源 |
| 页面说明 | 富文本页面说明，面向业务讲清使用对象、场景、用途与结果 |
| 用户类型 | 多级用户类型树，末级类型对应独立画布，可分别编辑、导出 |
| 本地编辑 | localhost 工作台：改名称、改类型、改说明、调结构、建联系、逐节点重新定位 |
| 关联验证 | 发布前把每条关联从初始状态重放一遍，确认真的能走到目标页面 |
| 导出交付 | 导出完整思维导图 SVG 与页面快照 SVG；也可以把编辑结果应用为新的自包含 HTML |
| 单文件交付 | 内嵌原型、画布运行时与样式，不依赖 CDN、网络图片或业务后端 |

## 工作方式

```mermaid
flowchart LR
    H["已有单 HTML 原型"] --> A["静态分析\n建立初始层级"]
    A --> P["结构探查\n真实点击确认入口"]
    P --> S["快照采集\n每个页面真实画面"]
    S --> V["关联验证\n逐条重放确认"]
    V --> C["画布 HTML\n导图 + 快照 + 说明"]
    C --> E["localhost 编辑\n改结构 / 补说明 / 重新关联"]
    E -->|"应用修改"| C2["新的自包含 HTML"]
```

Skill 不重新设计业务界面，也不改动原型业务逻辑。它只读取原型、补充画布所需的定位信息，并把画布与原型一起封装成新的 HTML。

## 安装

### 环境要求

- 已安装并可使用 Codex；
- 已安装 Python 3，用于运行 Codex 内置 Skill 安装器；
- 已安装 Node.js 18 或更高版本；
- 本机有 Chrome 或 Edge，用于生成页面预览与结构探查。

### 方式一：使用 Codex 内置安装器

PowerShell：

```powershell
python "$HOME\.codex\skills\.system\skill-installer\scripts\install-skill-from-github.py" `
  --repo lin96008-maxlin/prototype-canvas `
  --path prototype-canvas
```

macOS / Linux：

```bash
python ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo lin96008-maxlin/prototype-canvas \
  --path prototype-canvas
```

安装器会把 Skill 安装到 `~/.codex/skills/prototype-canvas`。安装成功后从下一轮对话开始使用。

### 方式二：手动安装

PowerShell：

```powershell
git clone https://github.com/lin96008-maxlin/prototype-canvas.git
New-Item -ItemType Directory -Force "$HOME\.codex\skills" | Out-Null
Copy-Item -Recurse ".\prototype-canvas\prototype-canvas" "$HOME\.codex\skills\prototype-canvas"
```

macOS / Linux：

```bash
git clone https://github.com/lin96008-maxlin/prototype-canvas.git
mkdir -p ~/.codex/skills
cp -R ./prototype-canvas/prototype-canvas ~/.codex/skills/prototype-canvas
```

首次运行时 Skill 会在自己的目录里安装 Node 依赖。

## 使用方式

不需要记脚本命令。正常情况下在 Codex 对话里点名 `$prototype-canvas`，并给出目标 HTML 路径即可。

### 生成画布

```text
使用 $prototype-canvas，为 C:\path\to\prototype.html 生成原型画布。
```

Skill 会依次完成：通读原型 → 在浏览器里探查真实入口 → 采集每个页面的运行画面 → 逐条验证页面关联 → 生成画布，并在导出前做一次自包含检查。

有 PRD、需求说明或用户类型划分时一并提供，页面说明会写得更贴合业务。

### 进入本地编辑模式

```text
使用 $prototype-canvas，打开 C:\path\to\prototype.html 的画布编辑模式。
```

Codex 会启动 localhost 服务并返回实际地址。工作台支持：

- 修改节点名称、类型和页面说明；
- 新增节点、拖动换层级、调整同级顺序、复制子树、删除节点；
- 建立和编辑联系线；
- 切换用户类型，分别编辑每张画布；
- 重新定位某个节点的页面关联；
- 查看鸟瞰图、缩放平移、导出 SVG。

### 应用本轮修改

```text
使用 $prototype-canvas，应用本轮画布修改。
```

Skill 会读取当前活动会话，将修改应用为一份新的自包含 HTML，不覆盖原文件。

## 什么值得画进画布

画布的价值不是把节点堆满，而是把「说不清的关系」变成看得见的结构。

| 应该进画布 | 说明 |
| --- | --- |
| 页面与它的真实入口 | 从哪个导航、按钮或行操作进入，双击就能落到该页面 |
| 业务状态与步骤 | 同一页面的不同状态、向导的不同步骤，属于页面而不是独立树 |
| 抽屉、弹窗与浮层 | 按真实打开路径归属到触发它的页面 |
| 跨页面关联 | 需要单独说明的跳转、联动或数据来源，用联系线表达 |
| 页面说明 | 谁在什么场景用、解决什么问题、主要处理什么、产生什么结果 |

没有事实依据的业务规则会被标为待确认，不会凭行业常识补造。

## 适用场景

适合：

- 原型评审开场讲清范围与结构；
- 复杂后台、多页面流程、多业务空间原型的梳理与交接；
- 需要把页面说明和原型一起交付，而不想维护多份对照文档的团队；
- 需要一份可离线打开、可直接传递的画布文件。

不负责：

- 重新设计业务页面或替换现有 UI 设计体系；
- 根据零散需求从头生成完整业务原型；
- 在没有事实依据时补造业务规则。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `prototype-canvas/SKILL.md` | Skill 入口、任务路由与流程要求 |
| `prototype-canvas/references/` | 工作流、画布数据模型、原型通信协议与交互基线 |
| `prototype-canvas/assets/` | 画布运行时、样式、原型桥接脚本 |
| `prototype-canvas/scripts/` | 分析、探查、复核、验证、采集、生成与本地服务 |
| `prototype-canvas/tests/` | Skill 回归夹具 |
| `docs/images/` | README 功能截图，可用同名文件直接替换 |
| `docs/capture-screenshots.mjs` | 截图脚本（1920×1080） |
| `.github/` | 持续集成、贡献指南与安全说明 |
| `LICENSE` | 本项目自研部分的 MIT License |
| `THIRD_PARTY_NOTICES.md` | 第三方组件与许可证边界 |

## 技术说明

- 分析与生成脚本使用 Node.js 标准库与轻量 HTML 解析，不依赖业务后端；
- 页面预览、结构探查与关联验证使用 Playwright 驱动本机 Chrome 或 Edge；
- 画布运行时内嵌进导出的 HTML，双击节点时在沙箱 iframe 中回放原型；
- 关联记录保存语义选择器、可访问名称与有限结构路径等多重定位信息，元素顺序变化后可重新查找；
- 画布数据保存在原型文件旁的 `.prototype-canvas/` 目录，不会写入原型本身。

## 质量检查

安装依赖后可直接运行 Skill 回归：

```bash
cd prototype-canvas
npm install
node scripts/test-skill.mjs
```

回归覆盖画布数据模型校验、层级归属约束、页面说明质量门禁、快照采集、画布生成、自包含审计与本地编辑会话。GitHub Actions 会在每次推送和 Pull Request 时执行依赖安装、语法检查与完整回归。

## 安全与隐私

- 画布快照会保存页面运行画面，可能包含真实客户名称与业务数据，外发前请按接收对象检查数据边界。
- `.prototype-canvas/` 目录可能保存未应用的编辑会话与快照，已被 `.gitignore` 排除，但仍需按项目要求管理。
- localhost 编辑地址包含随机会话 Token，只应在本机使用，不要转发或映射到公网。
- 不要把真实客户信息、内部系统地址、账号或密钥提交到公共仓库。
- 安全问题请通过 [GitHub Private Vulnerability Reporting](https://github.com/lin96008-maxlin/prototype-canvas/security/advisories/new) 私下反馈，详细说明见 [SECURITY.md](./.github/SECURITY.md)。

## 参与贡献

欢迎产品经理、设计师和开发者提交使用场景、兼容性问题与交互改进。提交前请阅读 [贡献指南](./.github/CONTRIBUTING.md)，并确保没有包含真实业务数据或公司专属信息。

## 开源许可

本项目自研部分采用 [MIT License](LICENSE)。第三方组件的许可证与归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 最终交付是什么

最终产物是一份普通 `.html` 文件，可以直接用浏览器打开、通过聊天工具传递，或上传到任意静态文件托管平台。它包含：

- 原有业务原型及其交互；
- 可导航的思维导图与页面快照；
- 每个节点的页面说明；
- 按用户类型划分的多张画布；
- 画布运行时与必要样式。

localhost 编辑工作台只在本机编辑时临时启动，不会作为编辑能力写入最终交付文件。
