---
name: prototype-canvas
description: 为已有 Web 或移动端自包含单 HTML 原型生成、检查、编辑和更新可导航的原型画布。适用于用户要求梳理页面、业务状态 Tab、弹窗、抽屉及用户类型关系，生成思维导图/快照导图，进入 localhost 编辑画布，或把编辑结果应用为新的单 HTML。只维护画布结构、页面说明和原型关联，不重新设计原型业务界面。
---

# 原型画布

把一个已有的自包含 HTML 原型封装为“画布 + 原型”的新单 HTML。画布支持结构图、快照图、空白节点、两类连线、用户类型、页面说明、页面定位、返回和完整 SVG 导出；localhost 工作台用于人工修正 AI 识别结果。

## 边界

- 只处理用户指定的一个原型 HTML 及明确提供的 PRD、说明或自然语言材料。
- 不覆盖或删除源 HTML；输出名固定使用 `20260901-（画布）{原型名称}.html`，同名时追加递增版本号。
- 不修改原型正文、样式或业务逻辑。需要修改原型本身时交给相应原型设计或 HTML 编辑 Skill。
- 不开发或要求专属 Agent 插件。Codex、Claude、WordBuddy、DSH 等终端均调用本 Skill 的同一组 Node.js 命令。
- 最终 HTML 必须离线可用，不依赖 CDN、网络图片或本地相对资源。
- 每次输入的单 HTML 都视为未知实现：关联能力只能依据该文件运行时实际出现的 DOM、可访问语义和用户真实操作建立，禁止写入某个验证原型的页面名、角色名、菜单顺序或框架特例。
- 节点展开/收起状态属于画布状态：localhost 编辑时写入 Session；导出的独立 HTML 在浏览器本地记录主画布和用户类型管理中每个节点的状态，刷新后恢复。SVG 只保留导出时的可见结果，不提供交互和状态记忆。

## 首次准备

在本 Skill 目录检查依赖。缺少 `node_modules` 时，先说明会在 Skill 目录安装项目依赖，再执行 `npm install`。不得全局安装依赖。

## 任务路由

- 用户要求生成画布：按“分析 → 精简复核 + 批量写回说明 → 关联体检 → 快照 → 生成 → 审计 → 浏览器验证”执行。发布前必须跑 `verify`，不得带着未验证的关联交付。
- 用户要求进入编辑模式：运行 `serve`，等待输出稳定的 `editUrl` 后打开，不自行拼接端口。
- 用户要求应用编辑：读取活动 Session，运行 `apply` 生成新文件，不覆盖旧画布。
- 用户要求检查或修复：先运行 `audit`；结构或映射问题回到 Manifest 修复，视觉/交互问题修复运行时后重新生成。

## 标准工作流

1. 完整阅读 [工作流](references/workflow.md) 与 [XMind 式交互基线](references/xmind-interaction.md)。涉及数据建模时再读 [Canvas Manifest v2](references/canvas-manifest-v2.md)；涉及页面跳转或人工定位时再读 [原型通信协议](references/interaction-contract.md)；修改 localhost 错误处理或提示文案时阅读 [用户可见异常提示](references/user-facing-errors.md)。
2. 执行分析：

   ```powershell
   node scripts/prototype-canvas.mjs analyze "C:\path\原型.html"
   ```

   分析之后先做结构探查，用真实点击确认“哪个入口能走到哪个页面”，再进入复核：

   ```powershell
   node scripts/prototype-canvas.mjs probe "C:\path\原型.html" --manifest "C:\path\manifest.json"
   ```

   - 探查在每个全新页面里逐个点击真实入口，按结果区分页面容器、浮层、仅状态变化和无效入口；默认最多 48 个入口、3 分钟预算、并行 3 路，实测几十秒。任何 html 原型都适用，不依赖专属属性。
   - 探查结果与静态草稿冲突时以探查结果为准；只有"从初始状态可达"的入口会被验证，两步以上的页面必须单独补充，不得当成已验证。
   - 确认后的关联用批量写回命令一次写入全部业务空间副本（已有用户手动定位的关联默认不覆盖，`--force` 才覆盖；关联变化会作废旧预览，采集阶段会重新生成）：

     ```powershell
     node scripts/prototype-canvas.mjs bind "C:\path\原型.html" --manifest "C:\path\manifest.json" --patch "C:\path\关联.json"
     ```

3. 阅读命令输出的 `manifestPath` 和低置信度清单。AI 必须按“未绑定系统起点 → 一级导航 → 二级导航 → 三级导航……→ 页面 → 页面操作 / 状态 / 下钻交互”组织每个用户类型的候选层级，并结合真实源码、运行行为及用户材料补充页面说明、业务状态 Tab、打开动作和具名用户类型；不得补造未提供的权限或业务规则。
   - 弹窗、抽屉、标签页、步骤和页面状态必须根据真实打开路径归属于触发它的页面或上级交互，不得作为独立树，也不得直接挂在系统起点或导航下。一个节点只有一个层级父节点；其他入口使用“联系”。
   - 页面说明要从产品与业务视角说明使用对象、业务场景、页面用途、主要信息/操作和业务结果。技术识别证据只保留在 `evidence`，不得写入页面说明。
   - AI 完成逐节点复核后，把 `descriptionSource` 设为 `ai-reviewed`，并清除已经解决的 `analysis.unresolved`；不得批量保留模板说明。
   - 复核必须通过精简复核包，不要直接读取整个 Manifest（内含内嵌快照，体积是复核包的数十倍）：

     ```powershell
     node scripts/prototype-canvas.mjs review "C:\path\原型.html" --manifest "C:\path\manifest.json"
     ```

     复核包按业务身份去重：同一个人物页面在所有业务空间中的副本只出现一条，并带 `nodeIds` 与所属画布。说明只写一次，用批量写回命令同步到全部副本：

     ```powershell
     node scripts/prototype-canvas.mjs describe "C:\path\原型.html" --manifest "C:\path\manifest.json" --patch "C:\path\说明.json"
     ```

     `--patch` 接受 `{"<复核包 id>": "<p>说明</p>"}`；无法匹配的 id 会在 `unknown` 中返回，不得忽略。
4. 发布前执行关联体检：所有已关联节点都从整页初始状态重放一次，确认能真正走到目标页面。

   ```powershell
   node scripts/prototype-canvas.mjs verify "C:\path\原型.html" --manifest "C:\path\manifest.json"
   ```

   体检失败（退出码 3）时必须先修好这些关联再继续；把坏关联留到用户使用时才发现，等于整轮重跑。
5. 需要快照时执行：

   ```powershell
   node scripts/prototype-canvas.mjs capture "C:\path\原型.html" --manifest "C:\path\manifest.json"
   ```

  默认复用同源已完成快照，只采集新增或失败项；需要强制重采时加 `--force`。任何已关联节点采集失败都必须修正定位并重采，不能把失败或"不可用"当成完成。
  采集默认并行 3 路（`--concurrency` 可调，`--concurrency 1` 为串行），进度输出到标准错误，结束时报告成功、失败、重试与耗时。

6. 生成最终画布：

   ```powershell
   node scripts/prototype-canvas.mjs generate "C:\path\原型.html" --manifest "C:\path\manifest.json"
   ```

7. 对输出运行 `audit`，并使用真实浏览器检查思维导图、快照、双击跳转、返回、用户类型、鸟瞰图、介绍面板和导出。浏览器步骤遵守当前环境的 Playwright 使用规范。

## localhost 编辑

直接执行并保持进程运行：

```powershell
node scripts/prototype-canvas.mjs serve "C:\path\原型.html" --manifest "C:\path\manifest.json"
```

- 只交付命令实际输出的 `editUrl`。
- 编辑内容先写入原型旁的 `.prototype-canvas/{prototypeKey}/sessions/`，不写回源 HTML。
- “定位关联”由用户在原型中实际打开页面、切换 Tab、触发弹窗或抽屉，系统记录路径；编辑已有节点时先自动打开当前用户类型下的既有目标。AI 识别结果仅作为候选。
- 关联记录必须保存语义选择器、可访问名称和有限结构路径等多重定位信息。回放顺序固定为“切换原型身份 → 等待身份界面稳定 → 逐步等待并执行页面动作 → 验证最终目标 → 生成快照”；不能用固定延迟代替目标等待。
- 重新定位时只保留本次从初始状态成功重放的旧前缀，再接上用户新操作；失效步骤及其后续旧路径必须舍弃，不能把新路径盲目追加到旧路径。
- 点击“确定关联”后，localhost 先用全新加载的原型验证候选路径并生成快照。两者成功后再一次性写入 Binding（关联）和快照；失败时保留原关联且明确显示“关联未保存”。
- 页面关联、快照生成等阻断式长操作必须显示居中蒙层，说明当前阶段并阻止重复提交。面向用户的异常提示必须说明发生了什么和下一步怎么做；Token、Selector、Manifest、Hash、HTTP 状态等技术细节只能写入控制台，不得直接显示。提示口径遵守 [用户可见异常提示](references/user-facing-errors.md)。
- 用户类型管理以大弹窗呈现，本身是带鸟瞰图的多级思维导图，只维护名称、预设类型（用户类型、租户、部门、岗位、角色、权限）、说明、父子层级和末级画布入口；不提供页面关联、联系线或节点业务详情。每个末级用户类型对应一张独立一级画布。
- 未识别身份时保持 `profiles: []`，不得生成“默认视角”。任意节点均允许不绑定页面。
- 用户未明确要求应用时，不执行 `apply`。

应用活动 Session：

```powershell
node scripts/prototype-canvas.mjs apply "C:\path\原型.html"
```

存在多份待处理 Session 时必须使用 `--session` 指定，不能猜测。源文件 Hash 与 Session 基线不一致时停止应用并报告冲突。

## 验证门禁

- `node scripts/test-skill.mjs`：数据模型、分析、生成、审计和 Session 回归。验证文件只写入系统临时目录并在成功后清理，不得写入 Skill 目录。
- `node scripts/prototype-canvas.mjs audit "输出画布.html"`：单文件、结构、资源和运行时审计。
- 必须把生成结果作为本地文件直接打开（`file://`）验收一次快照高清预览和双击进入原型；只验证 localhost 不算完成。离线预览不得依赖 `blob:null` 子页面，失败或尚未完成页面回放的 iframe 不得提升为可交互预览。
- 真实浏览器至少检查一个 Web 与一个移动端样本；本项目开发时回归用户提供的全部 4 个验证 HTML。
- 快照模式同时最多存在一个原型 iframe；放大后无需选中，自动增强距视口中心最近且面积足够的节点。高清预览必须等比、只读，并在平移和小幅缩放时复用同一 iframe；双击同一节点时直接把已完成回放的 iframe 提升为可交互预览，不得重复加载；退出增强后必须恢复缩略图，失败时继续显示缩略图。
- 用户类型匹配必须一次扫描当前可用的语义控件和 `select` 选项，只在控件确实尚未生成时做一次有界等待；同一个 iframe 加载周期只允许发出一次页面定位回放。localhost 可预热并复用浏览器进程，但每次关联验证必须使用新的隔离页面环境。
- 最终生成和 `audit` 必须同时验证层级归属、业务说明、关联重放与快照资源。已关联节点缺少 `ready` 快照时禁止发布，不得在导出 HTML 中留下永久“正在渲染”。
- 主画布和用户类型画布的平移必须受内容边界约束，任何方向移动到极限时都至少保留部分导图可见；鸟瞰图内容区只按实际内容产生滚动范围。
- 导出弹窗只提供“思维导图 SVG”和“页面快照 SVG”，两者都导出完整可见画布、全部连线及对应图例；快照 SVG 必须内嵌现有快照资源。
- 查看模式单击节点只选中并打开介绍面板，双击才进入原型；编辑模式双击标题改名、双击节点主体进入原型。
- localhost 必须验证按钮和双击空白新增节点、XMind 式层级拖拽、独立树吸附、多选整组拖拽、树间自动排斥、层级线不可操作、联系线创建与编辑、整棵子树删除、框选、折叠展开、普通滚轮平移、模式锚点保持，以及带双向滚动条的鸟瞰图。
- 页面关联至少用两类结构不同的临时原型验证：普通 DOM / Shadow DOM，以及身份切换后异步生成导航和页面入口的动态 DOM。必须覆盖失效位置选择器回退、用户类型同步、重新定位替换旧路径、快照与实时 HTML 打开；不得只回归某一个业务原型。
- 主画布与用户类型管理的鸟瞰图独立处理滚轮：普通滚轮移动内部纵向滚动条，`Shift + 滚轮` 移动内部横向滚动条，不能带动主画布或视口框。
