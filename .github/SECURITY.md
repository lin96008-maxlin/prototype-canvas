# 安全说明

## 数据边界

这个工具会在本地读取你的 HTML 原型，并在原型文件旁生成画布数据目录：

```text
.prototype-canvas/{prototypeKey}/
├─ manifest.json          画布结构、页面说明与关联
├─ index.json             编辑会话索引
└─ sessions/              未应用的编辑会话与页面快照
```

这些内容可能包含真实客户名称、页面截图和业务说明。请按项目的数据安全要求管理，不要提交到公共仓库（仓库已默认忽略该目录）。

导出的画布 HTML 会内嵌原型与页面快照，外发前请按接收对象检查数据边界。

## 本地服务

进入编辑模式时，Skill 会在本机启动只监听 `127.0.0.1` 的编辑服务，访问地址包含随机会话 Token。

- 不要转发该地址；
- 不要把它映射到公网；
- 编辑结束或不再使用时，可以直接关闭该进程。

## 反馈安全问题

如果你发现可能影响数据安全的问题，请通过 GitHub 的 Private Vulnerability Reporting 私下反馈，不要直接开公开 Issue：

https://github.com/lin96008-maxlin/prototype-canvas/security/advisories/new

请说明复现步骤、影响范围和可能的修复方向。
