<div align="center">

# DSH小助手 🐋

**住在桌面上、由 DeepSeek Harness 真实工作状态驱动的 Agent 伴侣。**

入口属于 DSH，生命周期属于 DSH，显示层属于桌面。

[使用](#使用) · [外观设置](#外观设置) · [素材与动画](#素材与动画) · [协议](#协议v1) · [参考与致谢](#参考与致谢) · [已知边界](#已知边界)

![version](https://img.shields.io/badge/version-0.1.0-informational) · [![license](https://img.shields.io/badge/license-MIT-success)](LICENSE) · ![platform](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey) · ![DSH](https://img.shields.io/badge/DSH-plugin-4B6BFB)

</div>

DSH小助手不是需要单独启动的桌宠应用：它由 DSH 插件拉起，跟着 DSH 一起启动和退出，
以透明、无边框、始终置顶的原生窗口待在桌面上。切到 VS Code、浏览器或全屏应用之后，
照样能看到 DSH 当前在思考、在执行、在等你确认，还是已经完成。

> 当前版本 `0.1.0` · macOS（Apple Silicon / Intel 通用二进制）· 仓库自带编译好的 helper
> 与素材包，clone 下来就能跑，不需要 Xcode

## 状态展示

七个耐久状态各自有动作与文案，同一状态还会随机换姿势，不会一直重复同一张图。

| 待机 | 思考 |
| --- | --- |
| ![待机中](assets/readme/status-idle.png) | ![正在思考](assets/readme/status-thinking.png) |

| 执行 | 等你确认 |
| --- | --- |
| ![正在执行](assets/readme/status-working.png) | ![等你确认](assets/readme/status-waiting.png) |

| 完成 | 出错 |
| --- | --- |
| ![任务完成](assets/readme/status-success.png) | ![任务出错](assets/readme/status-error.png) |

多项目并行时，气泡只给两行关键信息：谁在跑、谁在等你。

![多项目并行](assets/readme/parallel.png)

完成通知是**独立的一层**：状态气泡被"还在跑的项目"占着，通知照样出得来，
而且会一直挂着，点一下才消失。

![完成通知](assets/readme/notice.png)

## 它是什么

**展示与交互逻辑跑在原生 Swift 里，状态由 DSH 会话事件驱动**，两者之间只有一条
一行一条 JSON 的 stdio 协议 —— 没有 WebView、没有注入 DOM、没有在你的页面里画画。

```
DSH worker（Node）                        原生 helper（Swift / AppKit）
┌───────────────────────────┐             ┌──────────────────────────────┐
│ session/event             │             │ NSPanel（透明 · 无边框 ·      │
│   ↓ events → state-machine│  stdin  →   │  所有 Space · 全屏之上）      │
│   ↓ pet-reducer           │  JSON 行    │  ↓ PetAnimation（纯逻辑）     │
│ 7 个耐久状态 + 脉冲 + 通知 │  ← stdout   │  ↓ PetView.draw（原生绘制）   │
│   ↓ pet-process           │             │ 点击分区 · 右键菜单 · 拖拽     │
│ 守护 / 心跳 / 重启 / 退出  │             │ PetMetrics（纯几何）· 总结弹窗 │
└───────────────────────────┘             └──────────────────────────────┘
             ↕ 设置：DSH 设置服务（唯一来源）+ 本机回环端点（设置面板读写）
```

## 为什么这样分层

| 关注点 | 放在哪 | 理由 |
|---|---|---|
| 会话事件 → 状态 | Node（`events.js` / `state-machine.js` / `pet-reducer.js`） | 只有宿主知道 DSH 的语义；纯函数，可在 Node 里直接单测 |
| 状态 → 画面 | 原生（`PetAnimation` + `PetMetrics`） | 程序化挑选与几何算式不需要重新导出素材 |
| 窗口行为 | 原生（`PetWindow`） | `.floating` + `canJoinAllSpaces` 这些层级标记只有 AppKit 能设 |
| 进程生死 | Node（`pet-process.js`） | 宿主负责守护：就绪前排队、心跳、限次重启、优雅退出 |
| 台词与配置 | Node（`pet-copy.js` / `pet-interactions.js` / `pet-settings.js`） | 改文案不该重编译二进制 |

**关键设计**：helper 是个只认协议的哑终端 —— 它不知道 DSH 是什么，也就不会因为
DSH 版本变化而崩；反过来 DSH 也不关心它怎么画。

## 目录

```
src/                        宿主插件（Node，一行行都有单测）
  index.js                  入口：只做装配（一个 settings scope → pet + 端点）
  protocol.js               协议常量 + 编解码/校验（宿主、自检、探针共用）
  events.js                 DSH 会话事件枚举与归一化（单项目视角）
  state-machine.js          状态机：显式迁移表 + 每会话一台机器
  pet-reducer.js            多项目汇总：选主角 + 生成两行台词 + 完成通知
  pet-copy.js               台词、并行短句、状态图标
  pet-interactions.js       互动语义（动作 → 台词、连点彩蛋、区块映射）
  pet-process.js            helper 子进程：排队/心跳/重启/优雅退出 + 协议自检
  pet-settings.js           配置 schema / 归一化 / **唯一的配置作用域**
  pet-endpoint.js           本机回环 HTTP 端点（设置面板读写 + 互动 + 日报）
  pet-summary-corpus.js     日报的纯数据层（语料切分、提示词）
  pet-summary-agent.js      日报的执行层（读会话快照、跑隐藏会话）
  pet-summary.js            日报的编排（全量 / 增量两种模式）
  pet-summary-store.js      增量水位持久化（原子写）
  client.js                 设置面板卡片（不画宠物，只调设置与互动）
native/Sources/
  PetManifest.swift         素材清单解析
  PetState.swift            七个耐久状态（枚举，不再是裸字符串）
  PetAnimation.swift        动画内核（纯逻辑，无窗口）
  PetMetrics.swift          **气泡/通知/窗口几何**（纯逻辑，测量与绘制同源）
  PetProtocol.swift         行协议编解码 + 字段取值 + 输出通道
  PetHeadless.swift         无窗口运行器（自检/CI 走它，与 GUI 同一套解析）
  FrameStore.swift          帧缓存（按需读盘，内存上限）
  PetWindow.swift           透明悬浮 NSPanel（层级/空格/全屏标记）
  PetView.swift             绘制入口 + 鼠标 + 可访问性
  PetController.swift       控制器：生命周期、绘制、菜单、协议分发
  PetSummaryWindow.swift    日报弹窗（自研 markdown 渲染 + 复制原文）
  PetLayout.swift           位置与偏好持久化（原子写、全字段可选）
  main.swift                启动参数、stdin 循环、headless 分支
test/                       Node 单测（按模块分文件）
scripts/                    素材管线与构建脚本（见下）
assets/pack/                素材包（脚本生成，可换成自己的立绘）
assets/motion/              序列帧源（含 source.mp4 归档，不进版本库）
assets/readme/              README 里的状态样例图（原生窗口原样截取，带透明通道）
runtime/bin/darwin/         编译产物 .app（**仓库里直接带了**，clone 即可用；
                            重新编译见 `npm run build:helper`）
```

## 使用

```bash
npm run build:pack      # 从 dsh-whale-musume 生成素材包（--src 可指定素材目录）
npm run build:helper    # 编译原生 helper（需要 Xcode 命令行工具）
npm run build           # 上面两步 + 自检
npm run verify          # 自检：素材 / helper / 模块 / 握手 / **协议一致性** / 状态归约
npm test                # Node 侧单测（含真实 helper 的进程/心跳/协议一致性，
                        #   以及**真实 DSH 设置服务**的集成用例；缺 DSH 包时自动跳过）
npm run test:swift      # 纯逻辑内核检查（动画、几何、布局持久化）
npm run test:all        # 三样一起跑
npm run probe           # 不经 DSH，直接驱动宠物跑一遍状态与动作（肉眼验收）
npm run report:check    # 量一量最近一次日报有多长、有没有违反硬性限制
npm run probe -- --where   # 让原生端自报坐标/气泡实测尺寸（排查排版问题）
npm run probe -- --notice  # 只验完成通知层（与状态气泡互不干扰）
npm run probe -- --menu    # 只验"只带 action 的浮层"能被原生播出
```

### 装到 DSH 里

```bash
git clone https://github.com/vianvio/dsh-assistant.git ~/dsh-assistant
```

然后在 profile 的 `package.json` 里加依赖与 bundle id（与其它本地插件一样走 link）：

```json
{
  "dependencies": { "dsh-assistant": "link:~/dsh-assistant" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-assistant"] } }
}
```

仓库里已经带了**编译好的 macOS helper**（`runtime/bin/darwin/dsh-assistant-helper.app`）
与素材包，所以 clone 下来即可运行、不需要 Xcode；只有你想改原生端或重新生成素材时
才需要 `npm run build:helper` / `npm run build:pack`。

重启 DSH 后，桌面右下角会出现宠物；设置面板里多一张「DSH小助手」卡片
（同时注册 `settings.section` 的独立设置页与 `settings.plugin.item` 的插件配置行）。

## 单项目：事件枚举 → 状态机

`src/events.js` 是唯一认事件的地方，`src/state-machine.js` 是唯一改状态的地方。

| DSH 事件 | 归一化后携带 | 状态机触发 |
| --- | --- | --- |
| `turn/start` | — | `TURN_STARTED` |
| `step/start` · `assistant/chunk` · `assistant/message` | — | `STEP_PROGRESS` |
| `tool/call` | `tool` / `callId` / `asksUser` | `TOOL_STARTED`（要人类拍板的走 `QUESTION_ASKED`） |
| `tool/result` | `callId` / `error` | `TOOL_FINISHED`（带 error 时额外闪一下错误脉冲） |
| `todo/write` | `progress{current,completed,total}` | `TASK_UPDATED` |
| `approval/asked` | `tool` | `APPROVAL_REQUESTED` |
| `approval/decided` | — | `APPROVAL_RESOLVED` |
| `user/message` | — | `USER_REPLIED` |
| `turn/end` | `result`（completed / blocked / aborted / max-tokens / failed） | `TURN_SETTLED` |

只枚举**真的会用到**的事件：不认识的类型一律返回 `undefined` 忽略（不做兜底猜测）。
工具名按关键词分成四类活动（`searching / editing / testing / commanding`），决定气泡说
「在找东西」还是「在跑命令」；`ask_*`、`exit_plan_mode`、`*authorize*` 这类会被识别成
「需要人类拍板」，把宠物切到等待态。

状态机（`TRANSITIONS` 是显式表，加事件不会漏；测试会校验表本身合法）：

```
IDLE ──TURN_STARTED──▶ THINKING ──TOOL_STARTED──▶ WORKING
  ▲                        │  ◀──TOOL_FINISHED────  │
  │                        └──QUESTION/APPROVAL──▶ WAITING
  │                                                  │ APPROVAL_RESOLVED / USER_REPLIED
  │                                                  ▼
  │                                      回到 THINKING（或 WORKING）
  ├──TURN_SETTLED(completed)──▶ SUCCESS ──2.2s──▶ IDLE
  └──TURN_SETTLED(failed)─────▶ ERROR   ──3.0s──▶ IDLE
      TURN_SETTLED(blocked) ──▶ 停在 WAITING（等你处理）
```

`SUCCESS` / `ERROR` 是「停留态」：宿主每秒 tick 一次状态机，到点自动回落，不依赖下一条事件。
`DISCONNECTED` 目前没有触发点：素材表里有 9 段"睡着/钓鱼/发呆"的动画，但代码里没有
把它置位的路径 —— 留给以后接"helper 掉线"这类语义时用。

## 多项目并行：两行短句说清全局

宠物只有一个身体，所以 reducer 先选「主角」（等你 > 出错 > 干活 > 思考），再决定说两行：

| 情况 | 第一行 | 第二行 |
| --- | --- | --- |
| 单项目 | 当前动作（如「看着命令跑完」） | `agent-mesh · 2/5 · 修复登录接口` |
| 两个在跑 | `2 个在跑` | `agent-mesh ● · dsh-assistant ◐` |
| 有人在等 | `1 个在跑，1 个等你` | `dsh-assistant ⏸ · agent-mesh ●` |
| 四个在跑 | `4 个在跑` | `p1 ● · p2 ◐ · p3 ◐ +1` |

- 图标：`○` 空闲 `◐` 思考 `●` 干活 `⏸` 等你 `✓` 完成 `✕` 出错；
- 第二行最多列 3 个项目，其余用 `+N` 收尾；空闲项目不占篇幅（全空闲时才列）；
- 第一行 ≤ 12 字，第二行 ≤ ~24 字 —— 桌面气泡只有 ~448px 宽；
- 设置端点 `GET /plugins/dsh-assistant/config` 会带上 `focus` 与 `roster`，面板里能看到完整并行情况。

本机端点一共四条（都由同一个 prefix 路由处理，只认回环 + 同源）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/plugins/dsh-assistant/config` | 读配置 + helper 状态 + 主角/并行名单 |
| PATCH | `/plugins/dsh-assistant/config` | 改配置（白名单字段） |
| POST | `/plugins/dsh-assistant/config/action` | 互动动作 / 跑一次日报 |
| POST | `/plugins/dsh-assistant/config/viewed` | 客户端上报"在看哪个会话" → 消通知 |
| GET | `/plugins/dsh-assistant/config/pending` | 客户端长轮询取命令（打开会话） |

## 完成通知：独立一层，钉到被查看为止

**问题**：状态气泡表达的是「此刻在干什么」，并行时会被优先级更高的项目抢走
（WAITING > ERROR > WORKING > THINKING > SUCCESS > IDLE）。所以"某个任务跑完了"
一旦被抢走，桌面上就再也看不到，用户只能切回 DSH。

**做法**：完成/出错时另发一条 `notice`，原生端在**状态气泡上方单开一条通知栏**
（窗口向上长，宠物位置不动，最多同时 3 条，最新在最前）；每条自带 20 分钟兜底超时。

| 什么时候消失 | 实现 |
| --- | --- |
| **点一下那条通知** | 原生端命中测试 → 本地移除并回报给宿主（见下"点通知跳到会话"） |
| **点开日报通知** | 回报 `interaction{action:'notice-open'}`，宿主同样把账本清掉（否则会一直挂在 pendingNotices） |
| **在侧边栏切到该会话** | 客户端插件订阅会话列表的 `current` → `POST <endpoint>/viewed` → 清 |
| **回到该项目说话** | 该会话再来 `user/message` = 已查看 → 宿主下发 `notice-clear{reason:'seen'}` |
| **该会话首次载入内存** | `session/created` → `markSessionSeen()` → 清 |
| **会话销毁** | `session/disposed` → 连带清掉它的通知 |

### 点通知 → 跳到对应会话

完成通知不只是"看一眼"：**点它会把 DSH 切到那个会话**（顺手把窗口带到前台）。

```
原生（点通知）──interaction{action:'notice-open-session', noticeId, sessionId}──▶ 宿主
                                                                                  │ 入命令队列
客户端 ──GET <endpoint>/pending（长轮询）──▶ 宿主 ──▶ sessions.open(sessionId)
```

- 会话 id 由宿主写在 `notice{sessionId}` 里 —— 不让原生端去拆 `通知 id` 里那串复合串；
- **宠物自己打不开 DSH 界面**：能切会话的只有浏览器里的 `sessions.open(id)`
  （侧边栏点会话走的也是它），所以中间必须有一次客户端往返；
- 通道是**长轮询**（空闲 20 秒一个请求），点通知到界面切换之间几乎无延迟；
- helper 没在跑时端点立刻返回（没人会去点通知），命令在队列里最多留 30 秒、最多 8 条。

> **为什么"切到该会话"必须由客户端上报**：宿主侧的 `session/created` 每个会话**只发一次**
> （DSH 的 `announce()` 带 `announced` 标记，重复 `enter()` 还会抛错），而**刚跑完任务的
> 会话本来就在内存里** —— 用户点它不会有任何事件，通知于是永远挂着。
> 会话列表的 `current` 才是"用户此刻在看哪个会话"的权威来源。

协议：`notice{id, project, state, title, detail, action?}` —— **id 必填**（没有 id 就清不掉），
`notice-clear{id?|project?|reason?}`。

## 外观设置

设置只有**一个来源**：`createSettingsScope()`（`src/pet-settings.js`）。
`index.js` 装配一次，同时交给宠物与本地端点 —— 两端读写的必须是同一份。

| 后端 | 何时用 | 行为 |
| --- | --- | --- |
| DSH 设置服务 | `ctx.settings` 可用且 `@deepseek-ai/schemastery` 能解析到 | 持久化到 `$DSH_HOME/settings.yaml` 的 `dsh-assistant:` 段 |
| 内存兜底 | 服务不可用 / 注册被拒 | 重启即丢，但**同样支持 `watch`**（原生菜单改动能热更新） |

| 设置 | 取值 | 说明 |
| --- | --- | --- |
| `enabled` | 布尔，默认 true | 关闭后立即收起桌面窗口 |
| `scale` | 0.15 – 2.0，默认 **0.4** | 1 = 原始尺寸；右键菜单有 40% / 55% / 70% / 100% 四挡 |
| `bubbleEnabled` | 布尔，默认 true | 是否显示气泡 |
| `bubbleTheme` | `light` / `dark`，默认 `light` | 浅色气泡配**黑字**，深色配**白字** |
| `reducedMotion` | 布尔，默认 false | 减少程序化动效；原生端同时用它清帧缓存 |
| `soundEnabled` | 布尔，默认 false | 完成/出错时 `NSSound.beep()` |
| `includeSubagents` | 布尔，默认 false | 允许子 Agent 抢占宠物状态 |
| `backgroundSummary` | 布尔，默认 false | 任务后台总结（见下） |

**只下发用户显式设过的字段**：`configMessage()` 检查设置的用户层里有没有这个 key，
没有就留给原生端自己那份 `layout.json`。否则宿主一启动就会把用户在悬浮窗菜单里
调好的大小/配色推回默认值（现象是"调整大小后重启又恢复原来的大小"）。

### 气泡在小尺寸下单独放大（可读性）

宠物可以缩到 40%，但气泡**同比缩小就没法读了**（13pt → 5.2pt）。所以气泡用自己的系数：

```
bubbleScale = min(1, scale × 1.5)      # 小尺寸放大 1.5×，≥70% 时封顶 1.0
```

各档实测（`npm run probe -- --where` 让原生端自报）：

| 档位 | 气泡系数 | 气泡带 | 最小宽 | 标题字号 | 明细节字号 | 窗口高（无通知） |
| --- | --- | --- | --- | --- | --- | --- |
| 迷你 40% | 0.60 | 50.4pt | 180pt | 10pt | 8.5pt | 134.6pt |
| 小 55% | 0.83 | 69.3pt | 198pt | 10.7pt | 8.7pt | — |
| 中 70% | 1.00 | 84pt | 240pt | 13pt | 10.5pt | — |
| 原尺寸 100% | 1.00 | 84pt | 240pt | 13pt | 10.5pt | — |

排布按实测高度：

```
窗口高 = 宠物高 + anchorGap + 气泡实测高 + 通知块
通知块 = 通知行高 × N + 行间距 × (N-1) + 固定 8pt
```

**两个必须同时成立的点**（少一个就会出现"刚打开时气泡被压扁"）：

1. **文案变化时要重排窗口** —— 气泡文案是异步到的，不在文案变化处调 `resizeWindow()`，
   气泡会被 clamp 到 24pt（一条缝），要等下一次换片段才恢复；
2. **量气泡尺寸要用"将要设置的宽度"**，不能用 `view.bounds.width` ——
   重排过程中它还是旧值，量出来的行数与实际不符，高度自然不对。

这两条现在由 `PetMetrics` 保证：**测量与绘制取同一个算式**（`bubbleSize` → `bubbleRect`），
`npm run test:swift` 里有一条断言专门守着"窗口高度用的就是那份气泡实测高度"。

## 菜单功能（投喂点心 / 戳一下 / 夸夸它 / 摸摸头 / 回到原位 / 今天干了什么）

四项互动走的是同一条链路，**菜单、鼠标点击、设置面板按钮三者共用**：

```
原生（菜单项 / 点击分区）
   └─ emit interaction{zone|action}
        └─ 宿主 INTERACTIONS[action] 取台词、挑一个 ttl
             └─ overlay{action:'feed', message:'吃一口再干活', ttlMs:2400}
                  └─ 原生按 action 从素材表 manifest.actions 里随机挑一段播放 + 上气泡
```

宿主**只发动作语义**（`action`），不指定具体片段 —— 原生端有 `clip` 就用 `clip`，
只有 `action` 就从素材表里按动作挑。命令词汇两边对齐：

| 宿主下发 | 原生处理 |
| --- | --- |
| `command{action:'home'}` / `'reset-position'` | 回到右下角（离边缘 24pt），并确保窗口可见（隐藏后能回来） |
| `command{action:'hide'}` | 收起窗口 |
| `command{action:'open-summary'}` | 打开日报弹窗 |
| `command{action:'where'}` | 回报坐标/屏幕/气泡实测尺寸（探针用） |

## 「今天干了什么」：隐藏会话 → markdown → 弹窗复制

右键宠物 →「今天干了什么」（或设置面板里的「生成日报」按钮）：回顾今天的会话，
产出一份「今天做了什么 + 待办」的 markdown，生成完在宠物上方弹一条通知，
**点一下打开弹窗**，弹窗里有「复制 Markdown」按钮（复制的是**原文**，不是渲染结果）。

![今日总结弹窗](assets/readme/today-report.png)

### 新会话必须是隐藏的

DSH 没有 `hidden` 开关，**真正的隐藏标记是 `origin: 'subagent'`** ——
客户端侧边栏的可见性判断就是 `session.origin !== 'subagent' && …`。
所以日报会话用 `agents.create({ meta: { cwd, origin: 'subagent' } })` 创建：
既不会出现在左侧列表，也不会弹系统通知。

> 为什么不用"建完再删"：会话持久化层**没有删除 API**，删不掉就会永远占着列表。

### 两种模式（设置页「任务后台总结」开关）

**关闭（默认）**：点日报时把所有会话拼进一个 prompt 一次性生成。

**开启（分而治之）**：

```
会话每次压缩 ──► 后台提炼这一段已完成的内容 ──► 留存（水位 = 最后事件时间）
                                                      │
点「生成日报」────────────────────────────────────────┤
   ① 切出每个会话"今天 + 水位之后"的**增量**
   ② 每个会话**单独**提炼（一轮隐藏会话，互不干扰）
   ③ 再把各会话提炼**汇总**成「今天做什么 + 待办」
```

后台那一步有三条纪律（都是算过账的）：

- **只提炼、不汇总** —— 后台不需要日报正文，走 `refinePendingParts()`。原先复用了完整的
  分步总结（含最后那次汇总），而那次汇总的结果在后台路径里被直接丢掉，等于每次压缩白花一次调用；
- **全局单飞** —— 同时压缩两个会话不该并发跑两整套（水位要跑完才推进）；
- **与 helper 解耦** —— 没编译原生端也要能攒（它服务的是日报）；只有用户显式把宠物关掉
  （`enabled: false`）才停 —— 那是"我不想为它花钱"的明确信号。

想确认它到底省了多少：`npm run report:check -- --delta` 会列出每个会话"已留存到哪、
现在点一次日报还要补多少行"。

为什么全量实现有硬伤：所有会话拼进一个 prompt 会让不同项目的术语**互相干扰**；
总量封顶后直接截断会让排在后面的会话**整个被丢掉**；每次全量重读纯属浪费。

**超限会重写一遍**：提示词只是软约束。生成后会用 `reportViolations()` 量一遍
（**行数 + 单分组条数 + 整节条数 + 待办有没有按项目聚合** —— 只查行数会漏掉
"某个项目写了 10 条"这种），超了就把上一次的输出原样递回去让它删减
（`buildRewritePrompt`，最多多跑一轮；重写完还更长就保留原版）。
度量只有一份实现（`measureReport`），宿主判定与 `npm run report:check` 共用 ——
两边各写一份就会出现"工具说超了、宿主说没超"这种最费解的偏差。

两节**都按项目分组**，用 `**项目名**` 单独一行（原生端的 markdown 渲染器认加粗段落）：

```markdown
## 今天做了什么

**dsh-assistant**
- ……

## 待办

**dsh-assistant**
- [ ] ……
```

两套提示词共用同一份**硬性限制**（`SUMMARY_LIMITS`）：**每个项目最多 3 条**、
`今天做了什么` 最多 12 条、`待办` 最多 6 条且必须按项目聚合、全文不超过 30 行，
并在**提示词末尾再复述一遍**（长输入里开头的约束最容易被忽略）。数字抽成常量并被测试守着 ——
之前"每个项目最多 3 条"只写在一条要求的中段，汇总模式那条路径干脆没有上限，日报就越写越长。

行数上限是 30 而不是 25：**分组行本身要占行**（两节各一组标题，5 个项目就是 10 行），
25 行对多项目的日子结构性不够，会天天触发重写。压长度靠的是条目上限。

增量切分靠**事件时间水位**：`extractDeltas()` 只取 `time > max(今天0点, 已总结水位)` 的事件，
水位存在 `$DSH_HOME/dsh-assistant/summaries.json`（同水位重复写入会覆盖，压缩重复触发不会拼出重复内容）。

其他几条容易再踩的约定：

- 数据来源走 `ctx.sessionQuery.listSessions()` + `readSession(id)`（能读**未加载**的会话），
  不手解磁盘上的 `session.v3.jsonl.zstd`；
- 读不出来的会话退回 `readSurface()`，再不行就跳过 —— 不能让一个坏会话毁掉一整天的日报；
- **标题是异步的**：`readTitleSnapshots(ids)` 批量读一次（曾经漏了 `await`，
  于是每个会话的标题都退化成 cwd）；
- 只取**用户真人发的消息**（`source.kind === 'user'`）与助手文字；
- 过滤 `origin === 'subagent'`，**避免把自己跑日报的会话再喂回自己**；
- 跑完 `handle.dispose()`（唯一能保证 agent 停下、会话从内存摘掉的入口），并先 `sessions.flush()`。

## 素材与动画

素材是**按显示尺寸烘焙的序列帧**：88 段 clip，每段 30 帧（`frameMs` 见 manifest），
统一高 240px、宽度按原图比例（154–338px），原生端据此建窗 —— 窗口紧贴角色，
不会留一大片透明区域白吃鼠标点击。

随机与播放规则（`PetAnimation`，`npm run test:swift` 里逐条验证）：

- 进入某状态 → 从该状态的素材里随机挑一段，**避开当前这段**，也**避开上次该状态用过的**；
- 长时间停在 IDLE → 每 60s 换一段，桌面不至于几个月都是同一张；
- 浮层/脉冲到期后回到状态底片；同状态只更新文案时**不换图**；
- 时间基准是**模拟时钟**（`advance(elapsedMs:)` 累计），不是墙钟 ——
  通知过期、浮层到期、帧播放共用一条时间线，测试才能稳定驱动。

### 管线脚本

```bash
npm run build:pack      # 从姿态图 + assets/motion 生成素材包（默认 240px / q78）
npm run motion:all      # 批量把静态姿态转成序列帧（**会花钱**，需 DASHSCOPE_API_KEY）
npm run motion:post     # 后处理：--amplify 增强动作 / --densify 插值加密 / --restore
npm run motion:measure  # 诊断：每段的动作幅度（step/range），指出偏弱的段
```

共享逻辑在 `scripts/petgen_lib.py`（素材定位、姿态归一化、sidecar 原子读写、帧运算），
**打包参数只在一处定义**（`PACK_CHAR_H` / `PACK_QUALITY`）；`build-helper.sh` 与
`package.json` 都显式传同一组参数，避免"重新生成出来的包和随包分发的不一致"。

`build_pack.py` 的两条安全约定：**先读源图再动输出目录**（源目录指错时不会把
`assets/pack` 清空），`--dry-run` 只报计划；manifest 原子写。

### 用百炼把静图变成微动作序列帧

`scripts/bailian_motion.py` 走完整链路：
静图 → 合成绿幕 → 首尾帧生视频 → ffmpeg 抽帧 → 色键抠像 + 原图 alpha 约束 →
整段同一缩放系数、底边对齐 → `assets/motion/<group>/<clip>/` + sidecar。

几个必须知道的约束：

| 事实 | 影响 |
| --- | --- |
| 万相图生视频**只接受 RGB 输入，不吃透明通道** | 必须先把角色合成到纯色幕布上 |
| 输出永远是 MP4（H.264），**没有 alpha** | 抽帧后要自己抠像 |
| 首帧与尾帧可以是**同一张图** | 模型只在中间插微动、回到原位 → 天然无缝循环 |
| 模型 / Endpoint / API Key 必须同一地域 | 北京用 `dashscope.aliyuncs.com`，跨境调用直接失败 |
| 结果视频 URL 只保留 24 小时 | 脚本里下完就落地成 `source.mp4` 归档 |

归档的 `generation.json` **只增不改**：`--from-archive` 重新抽帧不会把当初生成它那次的
`task_id` 抹掉（曾经每跑一次就清空一遍，88 段的 provenance 全是 null）。

```bash
export DASHSCOPE_API_KEY=sk-xxxx
python3 scripts/bailian_motion.py --pose idle-cute --group idle --clip idle-cute-motion \
    --state IDLE --dry-run                       # 先看会发出什么请求（不花钱）
npm run motion:all -- --dry-run --limit 1        # 批量；--reprocess-archive 零成本重做后处理
npm run build:pack && npm run verify             # 合并并检查契约
```

## 协议（v1）

宿主 → helper：`hello` / `config` / `state` / `pulse` / `overlay` / `notice` /
`notice-clear` / `summary` / `command` / `ping` / `shutdown`
helper → 宿主：`ready` / `pong` / `interaction` / `settings` / `closed` / `error`

```jsonc
// 宿主：耐久状态
{ "v": 1, "kind": "state", "state": "WORKING", "message": "正在执行项目命令", "detail": "agent-mesh · 执行阶段" }
// 宿主：一次性情绪（ttl 到期回到 resumeState）
{ "v": 1, "kind": "pulse", "state": "SUCCESS", "ttlMs": 2200, "resumeState": "IDLE" }
// 宿主：动作浮层（只给语义，素材由原生端随机挑）
{ "v": 1, "kind": "overlay", "action": "pat", "message": "再摸一下就要收费啦", "ttlMs": 1800 }
// 宿主：完成通知（sessionId 让"点通知"能跳到对应会话）
{ "v": 1, "kind": "notice", "id": "session-a:12", "sessionId": "session-a", "project": "dsh-assistant",
  "state": "SUCCESS", "title": "任务完成了", "detail": "dsh-assistant · 执行阶段" }
// helper：用户在宠物身上做了什么
{ "v": 1, "kind": "interaction", "source": "click", "zone": "head", "clickCount": 1 }
// helper：点了完成通知（宿主据此让客户端切会话）
{ "v": 1, "kind": "interaction", "source": "click", "action": "notice-open-session",
  "noticeId": "session-a:12", "sessionId": "session-a" }
// helper：不认识的 kind（宿主会记一条 warn，便于发现协议漂移）
{ "v": 1, "kind": "error", "message": "unknown kind: xxx" }
```

状态取值：`IDLE / THINKING / WORKING / WAITING / SUCCESS / ERROR / DISCONNECTED`。

设置链路则有一条**对着真实 `@deepseek-ai/dsh-settings` 跑**的集成用例
（`test/dsh-integration.test.mjs`）：注册 namespace → 端点读 → 端点写 → 落盘 →
用户层判定。假 provider 测不出"namespace 用错"这类问题 ——
历史上那次"设置永远存不进去"正是只有真 provider 才能复现。

**协议漂移是会被抓住的**：`npm run verify` 里有一条「协议一致性」检查，
把宿主**能发的每一种消息**都发给 headless helper（它与 GUI 走同一套解析），
任何 `error` 回执都算失败 —— 否则"某个按钮点了没反应"这类问题握手是绿的、根本看不出来。

## 参考与致谢

这个项目的两半（**画面**与**状态**）都站在别人的成果上。没有下面这两个仓库，
就不会有现在的 dsh-assistant —— 特此致谢。

### 🐋 角色素材 · [Sutera-Diffusus/dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume)

> MIT License · Copyright © 2026 **Sutera-Diffusus**
> DeepSeek Harness 桌宠插件：元气鲸鱼娘陪你写代码

本项目默认的 **88 段角色素材全部来自这个仓库**。上游是静态姿态图，我们做了三件加工：

1. 统一高度（切状态时角色大小不跳）、宽度按原图比例；
2. 按显示尺寸烘焙成 WebP（不存 400px 的过采样素材）；
3. 其中一部分用百炼图生视频生成微动作，再抠像、对齐、插值成序列帧。

**加工不改变上游的许可与署名要求：角色形象版权仍归原作者**，本项目只以 MIT 分发代码与
加工后的素材。想换成自己的角色：把图丢进一个目录，改 `scripts/build_pack.py` 顶部的
`STATE_ASSETS` / `ACTION_ASSETS`，重跑 `npm run build:pack` —— 宿主与原生端都不用改。

### 🐟 原生悬浮窗骨架 · [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu)

> MIT License · Copyright © 2026 **QCYTSN**

「原生透明面板 + stdio JSON 协议 + 会话事件归约」这条路线，是这个仓库用**生产代码**先跑通的。
我们照着它做，省掉了"原生方案在 DSH 里到底行不行"那一段最贵的试错。

在它的基础上本项目做了四处加固（都是踩过的坑）：

| 加固点 | 它原来的做法 | 这里的做法 |
|---|---|---|
| **帧内存** | 启动时把 manifest 里所有帧读进内存（45MB 量级） | 按"当前播放的 clip"懒加载 + `NSCache` 上限，静态内存几 MB |
| **可访问性** | 自绘内容对 VoiceOver 不可见 | 显式提供 `accessibilityLabel/Value`，状态变化时同步更新 |
| **僵尸进程** | —— | 宿主退出走 `shutdown` → 等 3s → `SIGTERM`，同时 helper 在 stdin EOF 时自杀（双保险） |
| **布局路径** | —— | `DSH_HOME/dsh-assistant/layout.json` 优先、Application Support 兜底；原子替换写入，改 `DSH_HOME` 后不会跑到屏幕外 |

### 其它

- 素材生成依赖 **阿里云百炼**（图生视频模型），管线脚本在 `scripts/`；
- 配色与排版参考了 DSH 自身的界面规范（深/浅两套气泡配色）。

完整署名与许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 改名说明（`dsh-pet` → `dsh-assistant`）

原先叫 `dsh-pet`（中文名「DS看板娘」）。改名只换了**对外标识** —— 包名、插件 id、
设置 namespace、数据目录、env 前缀、helper 应用名、日报会话前缀 —— **没有**改内部的
代码标识：`src/pet-*.js`、`PetView.swift`、`mountPet()` 这些名字里的 `pet` 指的是
"这只角色"，不是项目名。

升级时有两处兼容是有意保留的：

- 日报会话前缀认**两种**：`pet-review-*`（旧会话）与 `assistant-review-*`（新会话），
  因为它们都已经躺在会话存储里了；
- 设置段与数据目录会从 `dsh-pet` **复制**到 `dsh-assistant`，旧目录原样保留
  （确认无误后可以自己删掉 `$DSH_HOME/dsh-pet/`）。

## 已知边界

- **平台**：原生 helper 目前只有 macOS（AppKit）。Windows/Linux 要么重写面板层，
  要么退回 Electron 子窗口方案（会失去「全屏应用之上」这一条）。
- **分发**：.app 是 ad-hoc 签名。别人从浏览器下载会被 Gatekeeper 拦，正式分发需要
  Developer ID + 公证。
- **素材体积**：`assets/pack` 约 46MB（88 段 × 30 帧）；`assets/motion` 另有几百 MB
  的源 MP4，已加进 `.gitignore`。
- **素材来源**：默认取自 [dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume)（MIT, © 2026 Sutera-Diffusus，见[参考与致谢](#参考与致谢)）。想换角色：
  把图丢进一个目录、改 `scripts/build_pack.py` 顶部的 `STATE_ASSETS` / `ACTION_ASSETS`，
  重跑 `npm run build:pack` 即可，宿主与原生端都不用改。
