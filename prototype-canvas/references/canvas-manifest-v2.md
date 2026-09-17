# Canvas Manifest v2

格式标识为 `prototype-canvas@2`。v1 只用于自动迁移，生成、编辑、保存和应用都必须写回 v2。

## 顶层结构

```json
{
  "format": "prototype-canvas@2",
  "prototype": {},
  "profiles": [],
  "canvases": [],
  "audience": { "rootId": "audience-root", "nodes": [], "view": {} },
  "nodes": [],
  "edges": [],
  "snapshots": {},
  "snapshotAssets": {},
  "viewState": {},
  "analysis": {}
}
```

## 用户类型与画布

- `audience.nodes[]` 是多级思维导图节点，字段为 `id`、`title`、`type`、`typeLabel`、`descriptionHtml`、`parentId`、`order`、`collapsed`、`profileId`、`canvasId`、`layout`。`type` 只允许 `user`、`tenant`、`department`、`position`、`role`、`permission`。
- `nodes[].collapsed` 与 `audience.nodes[].collapsed` 保存各节点的展开/收起状态。编辑模式写入 Session 并随生成结果嵌入 HTML；独立 HTML 还会按文件初始状态生成隔离的浏览器本地存储键，用户刷新后继续保持自己的展开状态。SVG 不保存可交互状态。
- 只有末级节点允许持有 `profileId` 和 `canvasId`。分类节点没有画布入口。
- `profiles[]` 只保存末级用户类型的标识、名称和 `canvasId`，不保存节点可见范围。
- `canvases[]` 是彼此独立的一级画布。一个用户类型只对应一张画布；节点不在用户类型之间共享。
- 用户类型末级节点新增第一个下级时：有至少一个节点的画布必须经确认后迁移给新下级；零节点画布可直接迁移。
- 没有任何已识别用户类型时保留一个 `canvas-global` 空容器，不生成“默认视角”。

## 节点

节点必需字段包括：

```json
{
  "id": "node-page-home",
  "canvasId": "canvas-reviewer",
  "type": "page",
  "typeLabel": "页面",
  "title": "首页",
  "descriptionHtml": "<p>...</p>",
  "descriptionSource": "ai-reviewed",
  "parentId": null,
  "order": 0,
  "collapsed": false,
  "bindings": {},
  "layouts": {
    "mindmap": { "x": 80, "y": 80, "width": 220, "height": 58 },
    "snapshot": { "x": 80, "y": 80, "width": 384, "height": 278 }
  }
}
```

- 节点类型：`start`、`navigation`、`page`、`tab`、`drawer`、`modal`、`dialog`、`sheet`、`popover`、`overlay`、`step`、`state`、`scenario`。
- `bindings` 使用当前 `profileId` 或 `global` 保存关联。空对象表示未关联；未关联节点在快照模式下仍是紧凑文字节点。
- Binding 的 `actions[]` 与 `target` 支持 `selector`、`selectors[]` 和 `locator` 多重定位信息。`nth-of-type` 只能作为兜底，回放前必须用 `locator` 的语义特征校验；AI 推断或用户新定位的 Binding 必须通过全新页面重放与快照验证后才写入。
- `descriptionHtml` 只存安全富文本，不存 Markdown，也不在思维导图节点内显示。
- `descriptionSource` 取 `analysis-draft`、`ai-reviewed` 或 `user`。最终发布只接受已关联节点的 `ai-reviewed` / `user` 业务说明。
- `tab`、`drawer`、`modal`、`dialog`、`sheet`、`popover`、`overlay`、`step`、`state` 必须有且只有一个层级父节点，父节点必须是页面或更上一级下钻交互；其他入口用 `cross` 表达。
- 两种模式各自保存根节点坐标；非根节点坐标由树布局自动计算，不是用户自由坐标。

## 两类连线

- `hierarchy`：唯一父子关系。不可选择或单独删除；通过拖拽节点改变父级、同级顺序或拆成独立树。
- `cross`：与树结构无关的“联系”。可选择、删除、调整端点与曲线。
- `cross` 额外保存 `anchors.source/target` 和 `controlOffsets.source/target`。自动锚点取两个节点边界的短距离；人工拖动后可位于四边连续边界并可改绑端点节点。

## 快照

- `snapshots` 键为 `nodeId::profileId`；值保存状态、尺寸、Hash 和 `assetHash`。
- `snapshotAssets` 以 Hash 去重保存 `dataUri`。
- PNG 导出必须把图片解码后直接绘入 Canvas2D，不能依赖嵌套 SVG 图片再次编码。

## 视图状态

`viewState.canvases[canvasId]` 分别保存思维导图与快照的 `{x,y,scale}`，以及鸟瞰图倍率。模式切换时按当前视口中心附近节点做视觉锚定，不直接复用两种模式的节点坐标。
