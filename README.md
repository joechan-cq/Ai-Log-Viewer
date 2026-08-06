# AI Log Viewer

把 AI 以 `--output-format stream-json` 输出的日志，变成能读的东西。

一个可安装的离线 PWA。日志全部在本地解析，不上传任何数据；装好之后断网可用。

---

## 它解决什么问题

`stream-json` 日志是一行一个 JSON 事件的裸文本，单行可能有几百 KB，工具调用、返回结果、子 agent 的活动全都平铺在一起，肉眼几乎没法看。这个工具把它还原成一条有层级的会话时间线，并算清 token 花在了哪里。

## 功能

### 会话时间线

- **调用与结果合并**：`tool_use` / `tool_result` / 任务进度事件按 `tool_use_id` 合成一张卡片，显示工具名、参数摘要、耗时、状态
- **子 agent 内嵌**：子 agent 的完整活动缩进显示在触发它的 Agent 调用之下，卡片头部标出 agent 类型、token 用量、工具调用次数
- **按工具类型定制展示**
  - `Bash` —— 终端风格命令行，stdout / stderr 分色，标出退出与中断状态
  - `Read` / `Write` —— 按文件后缀语法高亮
  - `Edit` —— 增删对照的 diff
  - `Agent` / `Skill` / MCP 工具 —— 结构化参数与返回
  - 未知工具与未知事件类型自动降级为通用 JSON 展示，不会丢内容
- **截图内联**：结果里的 base64 图片直接显示缩略图；带图的调用在折叠状态下也有图标标记
- **左侧大纲**：主时间线一览，点击跳转；可按 agent 过滤

### Token 统计

日志里的 token 数据有两处陷阱，这里都做了处理：

- 同一个 API 响应会被拆成多条事件、`usage` 重复出现 —— 已按 `message.id` 去重，不会重复计数
- `output_tokens` 是 `message_start` 时的快照，严重偏低（一个 5,900 字符的 `Write` 调用只报 3），**不予展示**以免误导

真正可用的是 `cache_creation_input_tokens`，它精确等于该次请求相对上一次多出来的上下文。基于它提供：

- **最贵的步骤排行**：哪一步给上下文塞进了最多 token，点击直接跳到时间线对应位置
- **按工具归因**：每种工具吃掉的上下文总量与单次均值（例如 Read 调用次数只有 Bash 的四成，却吃掉更多上下文）
- 上下文写入合计、缓存读取合计、峰值上下文、API 请求数

### 其它统计

- 工具调用次数、成功/失败、总耗时与平均耗时，以及每个工具分别被主会话和哪些子 agent 调用了多少次
- **Skill 调用次数**（按 skill 名）、MCP 工具调用、用户输入的 slash 命令
- 子 agent 汇总：启动次数、工具调用数、token、峰值上下文、耗时
- 事件类型分布、消息构成、后台任务数、截图张数
- 表格中的工具行、agent 行可点击，直接过滤时间线

### 查看与检索

- **全文查看器**：长内容不在卡片里原地展开，一律弹模态窗口。支持 Markdown 渲染 / 原文切换、一键复制；几百 KB 的文本分块渲染，秒开
- **大图查看**：缩放到 800% 看截图细节，放大后可拖拽平移，可下载；多图可左右切换
- **搜索与过滤**：全文搜索（`/` 聚焦搜索框），按类型（对话 / 思考 / 工具 / 系统）、按工具、按 agent 过滤
- **深浅色主题**：跟随系统 / 浅色 / 深色三态切换

## 使用

### 打开日志

任选一种：

- 拖拽 `.log` / `.jsonl` 文件到页面
- 点「打开日志」选择文件
- 安装为 PWA 后，直接双击 `.log` / `.jsonl` 文件用它打开
- 从「最近打开」列表重新载入（记住的是文件句柄，不复制文件内容）

### 本地运行

需要 Node 22（仓库内有 `.nvmrc`）。

```bash
nvm use
npm install
npm run dev          # http://localhost:5173
```

### 构建与安装为离线应用

dev server 不生成 Service Worker，要体验离线安装需要用构建产物：

```bash
npm run build
npm run preview      # http://localhost:4173
```

在 Chrome 打开后，地址栏右侧会出现安装图标。装完即可断网使用。

部署到 GitHub Pages 这类子路径时指定 base：

```bash
BASE_PATH=/Ai-Log-Viewer/ npm run build
```

### 在线使用

<https://joechan-cq.github.io/Ai-Log-Viewer/>

推送到 `main` 会通过 [GitHub Actions](.github/workflows/deploy.yml) 自动构建部署。首次启用需要在仓库 **Settings → Pages → Source** 选择 **GitHub Actions**。

## License

Apache-2.0
