# /perf 修复报告（run2a）

> 对象：`lib/metrics.ts`、`app/perf/dashboard.tsx`、`app/perf/page.tsx`、`app/globals.css`
> 依据：上轮 `perf-analysis.md`（22 条风险清单）。实测环境：Next 16.3.6 + React 19.2.8 +
> chart.js 4.5.1，HeadlessChrome 153（CDP 埋点，与上轮同一口径脚本），
> prod=`next start`:3320、dev=`next dev`:3310（localhost，见 §6.3 环境注记）。

## 目录
- §1 修改总览与风险映射（每处修改 ↔ 报告条目 ↔ 根因机制）
- §2 定时器架构重新设计（验收 4）
- §3 修复前后 60s 实测对照（验收 1、2）
- §4 语义保持验证（验收 3）
- §5 交互正确性实测（pick / 过滤 / 排序后图表跟随 / 卸载清理）
- §6 对上轮报告的口径修正（附实测证据）
- §7 边界场景自检（约束 4）
- §8 next build 路由表
- §9 四个文件 diff

## §1 修改总览与风险映射

### 1.1 `lib/metrics.ts`（重写 compute 的数据访问与缓存）

| 修改 | 对应报告条目 | 根因机制 |
|---|---|---|
| `sumLog` 用 `WeakMap<data, Σlog(v+1)>` 按数据引用缓存；`sin(i/97)` 在 METRICS 创建时算一次 | 「非惰性 useState 初值…单批 300×20000 点实测 61ms」「setRows 全量替换…61ms+协调」 | 300 个指标的 compute 对**同一份** RAW 各算一遍 `Σ log(v+1)·sin(i/97)`；而 `Σ log(v+1)` 与指标无关、`sin(i/97)` 是常数，正确结果 = `sumLog(RAW)/n × factor × th`。不变量被每指标、每 tick 重复计算是 61ms 长任务的根源。缓存后单批 300 次 compute 为 O(300) |
| `compute(data, th)` 改为由调用方注入阈值；删除 `typeof localStorage === "undefined"` 兜底 | 「metrics.ts:13 typeof 兜底掩盖 SSR 无 localStorage」「metrics.ts:9-15 compute 闭包内读 localStorage（实测 828.6k 次/60s）」 | compute 在渲染期（含 SSR）直接访问浏览器存储，使服务端静默用系数 1、客户端按本地存储取系数，两端口径分叉；且每指标每批 1 次同步 Storage 读。现在 metrics.ts 是同构纯计算，客户端在事件上下文（mount effect / tick 回调）读 300 个键后注入 |

数值等价性：新旧 compute 仅浮点求值顺序不同（`Σ(log·sin)` vs `sin·Σlog`），
实测（tsc 编译后 Node 运行，300 指标全量比对）最大相对误差 **1.15e-14**，
两位小数显示完全一致；`th` 注入路径实测 `compute(RAW,'2.5')` 与旧式手算一致。

### 1.2 `app/perf/dashboard.tsx`（重写状态、定时器、图表生命周期）

| 修改 | 对应报告条目 | 根因机制 |
|---|---|---|
| `import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale } from "chart.js"` + `Chart.register(...)` | 「dashboard.tsx:4 chart.js/auto 全量注册无法 tree-shake」 | auto 入口副作用式注册全部控制器/刻度/插件；具名导入后 Turbopack 可 tree-shake，实测 chunk 中已无 ArcElement/Radar/Tooltip/BarController 等（§6.1 有体积口径修正） |
| 删除 `export const dynamic = "force-dynamic"` | 报告已判「非问题误判」 | Route Segment Config 只从 page/layout/route 模块读取（node_modules/next/dist/docs 的 route-segment-config 文档确认），客户端组件内导出是死代码；/perf 的 ƒ Dynamic 来自 page.tsx 的 `await searchParams`，删除后构建实测仍 ƒ |
| 惰性 `useState(computeInitialRows)`，首帧 `th=null`、`ts=0` 占位 | 「非惰性 useState 初值每次渲染求值被丢弃（prod 300/dev 600 次 compute）」「ts:Date.now() 水合必失配（React #519）」 | 非惰性 `useState(expr)` 的 expr 每次渲染都求值；`Date.now()` 在 SSR 与客户端取值时刻不同。惰性初始化只在首次渲染执行一次；`ts=0` 使 SSR 与 CSR 首帧逐字节一致 |
| `timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ... })` 模块级共享 | 同上 #519 条目 | `toLocaleString()` 不带参数时结果依赖运行时默认 locale **和时区**：SSR(Node) 与浏览器可能不同（本机 Node 为 Asia/Shanghai、headless Chrome 另有一套），不定死就是新的失配源。显式 locale+UTC 后两端输出确定一致 |
| `numberFmt` 提升为模块级单例 | 「new Intl.NumberFormat 每次渲染新建（实测 34.5k 次/60s）」 | 构造在组件体内未 memo；现 60s 实测 nf=4 |
| 单一 `setInterval(REFRESH_MS=8000)`，`useEffect(..., [])` + `clearInterval` cleanup | 「第二个 useEffect 无依赖数组，interval 不回收正反馈」「1000/(tick+1) 撞 4ms 下限」 | 详见 §2 |
| mount effect：`readThresholds()`，仅当存在 `th-*` 键时才 `setRows(computeRows(ths))` | 「SSR/CSR value 口径一致 + localStorage 语义保留」（验收 3） | 水合首帧用 th=null（与服务端同口径），挂载后一次性接入本地存储；无 th 键时首帧值已正确，不再产生多余提交（省 1 次 commit） |
| `picks` 改 `useState`，`onPick` 内 `setPicks` 函数式更新 | 「模块级 cache + onPick 只改变量不调 setState，UI 等下次 interval 才被动更新」「模块级 cache 跨请求共享风险」 | 状态必须进 React 才有渲染；模块单例在服务端进程内跨请求共享（潜在串读），useState 天然按组件实例隔离。语义不变：内存计数、刷新归零 |
| `sorted = useMemo(() => [...rows].sort(...), [rows])` | 「useMemo dep=[rows,filter] 必失效 + JSON 深拷贝 300 对象」 | 浅拷贝即可排序（不修改元素）；filter 不再是排序依赖（过滤移至渲染期 hidden 计算） |
| `key={r.id}` 替代 `key={i}` | 「key={index}+排序：React 按位置复用节点，canvas/Chart 不随数据迁移」 | key=id 后排序变化时 React 移动 DOM 节点，Row 实例、canvas、Chart 实例随数据行一起走（§5.3 实测 canvas 从旧位置 294 随行移到顶部） |
| Row 用 `memo` 包裹；受控 `<input value={query} onChange=...>`；过滤用 `hidden` → `display:none` | 「input defaultValue 非受控、filter 是死代码不过滤」 | 输入接通为真实过滤（按 id/name 子串匹配，大小写不敏感）。用 display:none 而非条件卸载，是为了让被过滤行的 Chart 实例不被销毁/重建（保住「全程 new Chart ≤300」）；`Row memo` 使键击只重渲染 hidden 变化的行。过滤不碰 rows 状态，实测不触发任何 compute（§5.2） |
| Chart 生命周期：mount effect 内每 canvas 只 `new Chart` 一次，cleanup `chart.destroy()`；`[row.value]` effect 内 `chart.update("none")` 增量更新 | 「bindChart 内联 ref 回调每次渲染重绑 → already in use 抛错 34.2k」「catch 空吞异常，旧 Chart 永不 destroy」 | 原方案每次渲染生成新 ref 回调，React 先 null 后节点调用，null 分支不 destroy，重绑同 canvas 必撞 chart.js 前置校验。现构造/销毁配对，数据更新走既有实例的 update |
| 图表构造/更新全部经 `enqueueChartJob` 分片：每片一个 `setTimeout(0)` 宏任务、片内墙钟预算 5ms | （首屏长任务根因，报告「单批 61ms」的延伸） | 修复中途实测：300 个 `new Chart` 在一次 passive-effect flush 里同步执行产生 **236ms + 82ms** 两个长任务（A/B：不建图则首屏零长任务）。分片后每片是独立宏任务（实测片耗时 5–6.6ms），浏览器可在片间穿插渲染与输入；选 setTimeout 而非 rAF，是因为 rAF 回调与同帧渲染同属一个任务，叠加后偶发 60–76ms |
| 图表 options：`animation:false, responsive:false, events:[], scales 全隐藏且 ticks.display:false` | 同上（长任务/首屏） | 关动画避免 300 个图表同时启动动画帧；`events:[]` 去掉每 canvas 的 hover 监听；`ticks.display:false` 实测消除了 `_computeLabelSizes`（300 图共 54ms 的文本测量） |
| title effect 改 `dep=[rows]`、去掉 `Math.random()`；scroll 监听注册一次（`[]`）、`passive`、不再读 `offsetHeight` | 「offsetHeight 强制同步布局」「第三个 effect dep=[sorted] 每次渲染重注（抖动非泄漏，报告已自纠）」 | 原 scroll 回调读布局属性触发 forced reflow；现回调只写 ref。title 在水合完成时会被 Next 按 metadata 重置一次，故随 rows 刷新持续重写（实测挂载时写一次会被覆盖回 "Create Next App"） |

### 1.3 `app/perf/page.tsx`

**未修改**（diff 为空）。报告 §三.1 已实证：`await searchParams`（Next 16 动态 API）是
/perf 为 ƒ Dynamic 的真实原因，且这是验收要求保留的语义；该文件无性能/正确性问题。

### 1.4 `app/globals.css`

| 修改 | 对应报告条目 | 根因机制 |
|---|---|---|
| `animation: pulse 1s infinite` 从内联 style 收敛到 `.row` 类；新增 `content-visibility: auto` + `contain-intrinsic-size: auto 32px` | 「300 个元素各自无限 CSS 动画，持续触发合成/绘制」 | 动画功能保留（滚动动画在保留清单内），但 `content-visibility:auto` 让视口外约 270 行跳过布局/绘制，动画开销只落在屏内行；`contain-intrinsic-size` 防止滚动条抖动 |

## §2 定时器架构重新设计（验收 4）

**旧架构的失效机制**：60ms ticker 让 `tick` 无限自增；第二个 effect 无依赖数组，
每次 commit 都新建一个 `setInterval(..., 1000/(tick+1))` 且不清理。随 tick 增大，
延迟趋于 0，被 HTML 规范的嵌套定时器下限钳到 ≈4ms（同一任务链上超过 5 级嵌套的
定时器最小间隔 4ms）；同时 interval 数量随渲染次数线性堆积（实测 60s 存活 103–115
个、clearInterval=0），每个存活器回调都发起 300 次 compute 的 setRows，形成正反馈。

**新架构**：`useEffect([], cleanup)` 内创建**唯一**一个固定周期
`setInterval(8000)`，卸载时 `clearInterval`。设计要点：

1. **规避 4ms 下限**：周期取固定 8000ms，比 4ms 钳制值高 3 个数量级，
   嵌套定时器钳制与本设计无关；周期是常量，不随任何状态递减。
2. **规避 interval 堆积**：effect 依赖为空 → 组件生命周期内只创建一次；
   cleanup 成对出现 → 卸载即清零（实测：运行中 ivAlive=1，SPA 导航离开后
   ivAlive=0、ivCleared=1，§5.4）。dev StrictMode 双调用 effect 也只是
   建→清→建（ivBorn=2、ivAlive=1），不产生泄漏。
3. **后台标签节节流下仍正确**：
   - Chrome 对后台标签的 interval 节流（≥1s，5 分钟后 intensive throttling
     约 1 次/min）只会**推迟**回调，而本设计每次回调都用**当时的**最新输入
     （RAW + 回调触发时读取的 localStorage 阈值）全量重算，`ts=Date.now()`
     取触发时刻——结果不依赖 tick 计数、不依赖上一次触发时间，无漂移累积。
   - `setInterval` 在事件循环中**最多只排队一个待触发回调**，不会为"错过
     的次数"补发，故切回前台时没有补发风暴（旧架构 115 个存活器同时恢复
     4ms 调度才是风暴来源）。
   - 图表更新 job 幂等（向既有实例写入最新值后 `update("none")`），分片队列
     在后台被节流只是延后执行，恢复后写入的仍是最新值，不会重放中间状态。
4. **不重叠**：回调体实测 <1ms（compute 已 O(1) 化），远小于 8000ms 周期，
   不存在回调执行时间超过周期导致的堆积。

周期取 8000ms 的约束来自验收预算「commits ≤ 12」：页面固定开销 4 次提交
（水合 1 + Next 框架 3，基线同样存在），8s 周期在 60s 窗口内触发 7 次、
有 th 键时挂载 effect 再 +1，合计 11–12，留有余量。

## §3 修复前后 60s 实测对照

**方法**（与上轮同一口径）：CDP 连接 HeadlessChrome 153，`Page.addScriptToEvaluateOnNewDocument`
注入埋点（hook `setInterval/clearInterval`、`add/removeEventListener('scroll')`、
`canvas.getContext('2d')`、`Storage.getItem('th-*')`、`Intl.NumberFormat`、
`Error` 构造器、`__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`、
`PerformanceObserver('longtask')`），navigate 起前台可见、不滚动、稳定 60s。
prod=`next start`（:3320），dev=`next dev`（:3310，**localhost**，原因见 §6.3）。
基线=故障现场原样（/tmp/p14 同源副本，行号与上轮报告一致）；修复=本报告四个文件。
compute 调用数：修复前以 thGet（每次 compute 恰读 1 次 localStorage）为精确代理；
修复后 compute 不再读存储，用临时插桩版实测调用模式为「水合 300 + 每 tick 300」，
按实测 tick 数折算（插桩仅多一行计数，不改变调用次数）。

### 3.1 prod（验收以此为准）

| 指标 | 修复前（实测） | 修复后（实测） | 预算 |
|---|---|---|---|
| React commits | 106（报告 118） | **11** | ≤12 ✓ |
| compute 调用 | 738,000（报告 828,600） | **2,400**（300 水合 + 7 tick×300） | ≤4000 ✓ |
| new Chart（ctx2d 计数） | 300 | **300** | ≤300 ✓ |
| Chart 重绑抛错 | 30,600（报告 34,200） | **0** | =0 ✓ |
| 存活 interval（60s 末） | 103（clearInterval=0） | **1**（卸载后 0，§5.4） | 卸载后=0 ✓ |
| scroll 监听（净存活） | 1（add 95/rm 94，抖动） | **1**（add 1/rm 0；卸载后 0） | 卸载后=0 ✓ |
| 长任务（>50ms） | 7 个，max **1264ms**（117/1264/117/625/53/55/52） | **0 个**（连续 3 次 60s 复测均为 0） | <50ms ✓ |
| Intl.NumberFormat 构造 | 30,904 | **4** | — |
| localStorage `th-*` 读取 | 738,000 | **2,400**（挂载 300 + 每 tick 300） | — |
| 水合正确性 | SSR 行文本 `1:35:21 PM` → 水合后被替换为 `1:35:27 PM`（失配实锤）；dev 抛未捕获 `throwOnHydrationMismatch` | **SSR 与水合后文本逐字节相同**；dev 零未捕获异常、零 console.error | #519 不出现 ✓ |
| chart.js 首屏 JS（gzip） | 69,622 B（A/B 差分，§6.1） | **45,450 B** | ≤60KB ✓ |

### 3.2 dev（另列，含 StrictMode 差异成因）

| 指标 | 修复前 dev（实测） | 修复后 dev（实测） | 与 prod 差异成因 |
|---|---|---|---|
| commits | 104（报告 116） | 18 | dev StrictMode 双渲染 + effect 双调用（挂载→卸载→再挂载），提交数增多 |
| compute（thGet 代理） | 699,900（报告 775,800） | 2,700 | 挂载 effect 被 StrictMode 执行 2 次 → 多读 300；余同 prod |
| new Chart | 300 | 300 | 首轮挂载的建图 job 入队后即被 cleanup 取消（cancelled 标记），只有第二轮生效，故不是 600 |
| 存活 interval | 96 | 1（ivBorn=2、ivCleared=1） | StrictMode 建→清→建，cleanup 成对，无泄漏 |
| scroll 监听 | 净 1 | 净 1（add 2/rm 1） | 同上 |
| 长任务 | 98 个，max 2702ms | 0 个 | dev 未压缩代码 + 双渲染放大基线问题；修复后同样为 0 |
| 水合 | 未捕获 `throwOnHydrationMismatch` 异常 | 零异常 | — |

dev 的 `hydrThrow=2` 计数为**误报口径**：那是 React 19 内部控制流异常
（"Hydration Mismatch Exception: This is not a real error…"），在**健康的
首页 `/`** 上同样出现（已实测对照），判别水合失配要用 §3.1 的 SSR 文本比对
与 dev 未捕获异常两个信号，见 §6.2。

### 3.3 prod/dev 差异总因（StrictMode 必须解释的一条）

Next 16 默认 `reactStrictMode: true`，dev 下 React 19 对每个组件做
**双渲染**（render 执行两遍）并对 effect 做**挂载→清理→再挂载**演练；
prod 不做。因此 dev 的 commits、effect 次数、localStorage 读取次数系统性
高于 prod，而 interval/scroll 监听因有 cleanup 不会净增。所有验收预算均以
prod 为准（§3.1），dev 数字仅用于说明行为一致性。

## §4 语义保持验证（验收 3，全部实测）

| 语义 | 验证方法与结果 |
|---|---|
| SSR 仍输出 300 行 | `curl :3320/perf` 实测 HTML 含 `class="row"` ×300、`<canvas>` ×300、pick 按钮 ×300 |
| /perf 仍为 ƒ Dynamic | `next build` 路由表实测 `ƒ /perf`（§8 原文粘贴）；page.tsx 的 `await searchParams` 保留 |
| localStorage 阈值系数语义保留 | 预置 `localStorage.th-5='1000'` 后加载：挂载后下个 tick 首行变为 `304.11`（=m5 基值 0.30411×1000，实测）；mount effect 在挂载后即应用（不等首个 tick） |
| SSR 与 CSR value 口径一致 | 首帧两端均 th=null（系数 1）：SSR HTML 与水合后 DOM 文本逐字节相同（实测 `same:true`）；预置 th 键时 dev 全程零未捕获异常、零 console.error（实测） |
| 输入框真实过滤 | 输入 `metric_1`：可见行 300→**111**（metric_1、metric_10–19、metric_100–199，实测）；清空恢复 300；URL `?q=` 仍作为输入框初值（`useState(filter)`） |
| 过滤不触发全量 compute | 插桩实测：连续 4 次输入（m→me→met→metric_2）期间 `__computeCount` 增量 = **0** |
| 五项功能不削弱 | 300 行列表 ✓（SSR 300 行）；行内图表 ✓（300 canvas 均有 Chart 实例且 canvas 有像素，截图确认）；pick 计数 ✓（点击即更新，§5.1）；输入框 ✓（受控且过滤）；滚动动画 ✓（`.row` 保留 `pulse 1s infinite`，截图可见透明度脉动） |

## §5 交互正确性实测（验收 1）

### 5.1 pick 当次渲染即更新
CDP 执行 `btn.click()` 后，同一交互回合（2 个 rAF 内、远早于下一个 8s tick）
读行文本：`… · pick` → `… · 1pick`（实测 `changed:true`，commits 4→5）。
不再依赖 interval 被动刷新。

### 5.2 过滤
见 §4。键击只产生 1 次 commit（受控 input 的 setQuery），`ctx2d` 恒为 300
（过滤用 display:none，不卸载行、不重建图表）。

### 5.3 排序变化后 canvas 图表数据跟随
预置 `th-5=1000` → 等一个 tick → m5 行（基值 0.30411）以 304.11 升至首位。
实测：新首行 canvas 的 `data-oldpos` 标记 = **294**（排序前 m5 的 DOM 位置），
即 canvas DOM 节点随数据行一起移动（key=id 的直接证据）；全程 `ctx2d=300`
（无重建）、`chartThrows=0`、仅 1 次 commit。图表数据经 `[row.value]` effect
的 `chart.update("none")` 写入既有实例。

### 5.4 卸载清理
`/perf` 水合稳定后，经 `window.next.router.push('/')` SPA 导航离开：
`ivAlive` 1→**0**（ivCleared=1）、scroll 监听 `scrollRm` 0→**1**（净存活 0）。

## §6 对上轮报告的口径修正（约束 3：指出误判并给实测证据）

### 6.1 chart.js 体积口径：163KB 是整个 chunk，不是 chart.js
报告称「chart.js/auto 打入的 chunk 488K raw / 163K gz」——该 chunk 同时含有
**samples.json（≈295KB）**、metrics/dashboard 代码与 chart.js。用与 §1 相同的
A/B 差分法（同代码分别构建含/不含 chart.js 两版，比较对应 chunk）实测：

| 版本 | 含 chart.js chunk | 不含（stub）chunk | chart.js 部分（差分） |
|---|---|---|---|
| 修复前（chart.js/auto） | 496,886 raw / 163,017 gz | 297,382 / 93,395 | **199,504 raw / 69,622 gz** |
| 修复后（具名注册） | 421,798 raw / 139,486 gz | 298,587 / 94,036 | **123,211 raw / 45,450 gz** |

即 chart.js/auto 的真实首屏成本是 ≈68KB gz（不是 163KB），修复后为
**44.4KB gz ≤ 60KB** 达标。报告「无法 tree-shake」的机制判断正确，仅体积
归因口径偏大；samples.json 随客户端 chunk 下发的问题两个版本同样存在
（RAW 被客户端 compute 使用，属功能所需，不在本轮风险清单内）。

### 6.2 「React #519」探针口径：Error 构造器 hook 会在健康页上同样计数
上轮以 hook `window.Error` 构造器、匹配 /hydrat/i 作为 #519 信号。实测该信号
在**完全健康的静态首页 `/`** 上同样出现（prod 与 dev 均复现）：React 19 把
`HydrationMismatchException`、`Suspense Exception` 等作为**内部控制流异常**
抛出并内部捕获（构造即被计数），与页面是否失配无关。判别失配的可靠信号
（本报告采用，双向实测）：
- dev：`Runtime.exceptionThrown` 出现**未捕获** `throwOnHydrationMismatch`
  ——修复前 dev 有、修复后 dev 无；
- prod：SSR 行文本 vs 水合后（无任何状态更新前）行文本比对——修复前
  `1:35:21 PM`→`1:35:27 PM` 被替换，修复后逐字节相同。

### 6.3 环境注记：dev 必须经 localhost 访问
Next 16 dev 默认拦截跨源 dev 资源（`allowedDevOrigins` 未配置时，
`127.0.0.1` 与 `localhost` 被视为不同源），经 `127.0.0.1:3310` 访问时
`/_next/hmr` 被 Block、客户端 JS 不执行，页面永不水合（commits=1、全指标为 0
的假象）。本轮全部 dev 数字均经 **localhost** 测得；基线 dev 复测
（104 commits / 699.9k compute / 96 存活 interval / 长任务 max 2702ms）
与上轮报告同量级，确认上轮 dev 数字有效。

### 6.4 维持上轮已自纠的三条「非问题误判」
scroll 监听净存活恒 1（抖动非泄漏）、Chart 真实存活 300（34.2k 次抛错在
构造器前置校验处，未生成实例）、`export const dynamic` 在客户端组件内无效
——本轮实测与上轮结论一致，不重复展开。

## §7 边界场景自检（约束 4：最可能翻车的 2 个场景）

### 7.1 6 倍 CPU 节流 + 低端设备：单个 `new Chart` 构造不可分割
分片队列按**墙钟** 5ms 预算切片（`performance.now()`），6× 节流下每片自动
只执行约 1/6 的 job 数，单片任务时长仍 ≈5ms，不会放大成长任务；300 图全部
就绪时间从 ≈0.5s 拉长到 ≈3s（可感知、无错误）。**翻车点**：分片无法切割
**单次** `new Chart` 同步调用——本机实测单图 ≈0.7ms（300 图/236ms 未分片
实测推算），6× 节流后 ≈4–5ms 仍安全；但在更弱的设备上若单图构造 >50ms，
长任务预算会被击破。已做的缓解：`animation:false`、`events:[]`、
`ticks.display:false`（实测消除 300 图共 54ms 的 `_computeLabelSizes`）、
`responsive:false`（不读布局）。该场景下 commits/compute 预算不受影响
（次数与时钟无关），风险仅集中在单图构造耗时这一项。

### 7.2 后台标签页 ≥5 分钟后切回（intensive throttling）
Chrome 对后台标签的定时器在 5 分钟后节流到约 1 次/min：期间页面数值停更
（不刷新，但**不产生错误状态**）；切回前台后 `setInterval` 不补发积压
（规范保证最多 1 个待触发回调），下一个 tick 用当时的 localStorage 全量
重算，一次到位，无补发风暴；图表分片队列在后台同样被节流，恢复后按
5ms/片继续，update job 幂等（重复写入同一最新值）。**标注**：5 分钟级
后台节流的具体恢复行为为【推】（依据 HTML 定时器规范与 Chromium 节流策略），
本轮未做 5 分钟实测；已实测支撑的是：卸载清理为零（§5.4）、回调体 <1ms
无重叠、60s 窗口内零长任务。残余风险：若用户在后台期间大量改动 th-*，
切回后首个 tick 一次性应用全部变化（300 次 compute + 300 次 chart.update
分片 ≈ 数十 ms），数值一次跳变——行为正确但可感知。

附：上轮推演的「10 万条数据」场景对本方案**不构成**风险：`sumLog` 首算
O(n) 一次（20k 点实测 ≈0.2ms，10 万线性外推 ≈1ms），WeakMap 缓存后每 tick
O(1)；SSR 首算同量级。过滤为每键击 300 行 `includes`（<1ms），与数据点数
无关（行数恒 300）。

## §8 next build 路由表（原文粘贴）

```
▲ Next.js 16.3.6 (Turbopack)
✓ Running next.config.ts took 81ms

  Creating an optimized production build ...
✓ Compiled successfully in 2.3s
  Skipping validation of types
  Finished TypeScript config validation in 7ms ...
  Collecting page data using 6 workers ...
  Generating static pages using 6 workers (0/5) ...
  Generating static pages using 6 workers (1/5) 
  Generating static pages using 6 workers (2/5) 
  Generating static pages using 6 workers (3/5) 
✓ Generating static pages using 6 workers (5/5) in 299ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
├ ○ /_not-found
└ ƒ /perf


○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

`/perf` 保持 `ƒ (Dynamic)`（动态 API `await searchParams` 驱动，非 force-dynamic）。

## §9 四个文件 diff

### 9.1 `lib/metrics.ts`

```diff
--- /tmp/orig/metrics.ts	2026-10-06 13:55:09.361075525 +0800
+++ lib/metrics.ts	2026-10-06 13:08:46.270333721 +0800
@@ -1,16 +1,31 @@
-// /perf 页面的指标定义：300 个 compute 函数 + 2 万个采样点
-import payload from "./samples.json";
-
-export const RAW = payload.data;
-
-export const METRICS = Array.from({ length: 300 }, (_, i) => ({
-  id: `m${i}`,
-  name: `metric_${i}`,
-  compute: (data: { v: number }[]) => {
-    let s = 0;
-    for (const p of data) s += Math.log(p.v + 1) * Math.sin(i / 97);
-    // TODO 线上偶发报错，先加个兜底
-    const th = typeof localStorage === "undefined" ? null : localStorage.getItem(`th-${i}`);
-    return (s / (data.length || 1)) * (th ? Number(th) : 1);
-  },
-}));
+// /perf 页面的指标定义：300 个 compute 函数 + 2 万个采样点
+import payload from "./samples.json";
+
+export const RAW = payload.data as { v: number }[];
+
+// 聚合结果按数据引用缓存：RAW 在模块生命周期内不变，300 个指标共享
+// 同一个 Σlog(v+1)，不必每个指标、每个 tick 都重算 2 万点。
+const sumLogCache = new WeakMap<{ v: number }[], number>();
+
+function sumLog(data: { v: number }[]): number {
+  let s = sumLogCache.get(data);
+  if (s === undefined) {
+    s = 0;
+    for (const p of data) s += Math.log(p.v + 1);
+    sumLogCache.set(data, s);
+  }
+  return s;
+}
+
+export const METRICS = Array.from({ length: 300 }, (_, i) => {
+  // sin(i/97) 对每个指标是常数，定义时算一次即可
+  const factor = Math.sin(i / 97);
+  return {
+    id: `m${i}`,
+    name: `metric_${i}`,
+    // th 由调用方注入（客户端读 localStorage，服务端传 null）。
+    // compute 不再直接访问浏览器 API，SSR 与 CSR 口径一致。
+    compute: (data: { v: number }[], th: string | null = null) =>
+      (sumLog(data) / (data.length || 1)) * factor * (th ? Number(th) : 1),
+  };
+});
```

### 9.2 `app/perf/dashboard.tsx`

```diff
--- /tmp/orig/dashboard.tsx	2026-10-06 13:55:09.362418728 +0800
+++ app/perf/dashboard.tsx	2026-10-06 13:52:24.601327786 +0800
@@ -1,91 +1,214 @@
-"use client";
-
-import { useCallback, useEffect, useMemo, useRef, useState } from "react";
-import Chart from "chart.js/auto";
-import { METRICS, RAW } from "@/lib/metrics";
-
-export const dynamic = "force-dynamic";
-
-const cache: Record<string, number> = {};
-
-export default function Dashboard({ filter }: { filter: string }) {
-  const [rows, setRows] = useState(
-    METRICS.map((m) => ({ id: m.id, value: m.compute(RAW), ts: Date.now() }))
-  );
-  const [tick, setTick] = useState(0);
-
-  useEffect(() => {
-    setInterval(() => setTick((t) => t + 1), 60);
-  }, []);
-
-  useEffect(() => {
-    const id = setInterval(() => {
-      setRows(
-        METRICS.map((m) => ({ id: m.id, value: m.compute(RAW), ts: Date.now() }))
-      );
-    }, 1000 / (tick + 1));
-  });
-
-  const sorted = useMemo(() => {
-    const c: any = JSON.parse(JSON.stringify(rows));
-    return c.sort((a: any, b: any) => b.value - a.value);
-  }, [rows, filter]);
-
-  useEffect(() => {
-    document.title = `监控 ${sorted.length} ${Math.random()}`;
-    const onScroll = () => {
-      void document.body.offsetHeight;
-    };
-    window.addEventListener("scroll", onScroll);
-    return () => window.removeEventListener("scroll", onScroll);
-  }, [sorted]);
-
-  const onPick = useCallback(
-    (id: string) => {
-      cache[id] = (cache[id] ?? 0) + 1;
-    },
-    [filter]
-  );
-
-  return (
-    <div>
-      <input defaultValue={filter} />
-      {sorted.map((r: any, i: number) => (
-        <Row key={i} row={r} picked={cache[r.id]} onPick={onPick} />
-      ))}
-    </div>
-  );
-}
-
-type RowProps = {
-  row: { id: string; value: number; ts: number };
-  picked?: number;
-  onPick: (id: string) => void;
-};
-
-const Row = ({ row, picked, onPick }: RowProps) => {
-  const fmt = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
-  const label = new Date(row.ts).toLocaleString();
-  const canvasRef = useRef<HTMLCanvasElement | null>(null);
-
-  const bindChart = (el: HTMLCanvasElement | null) => {
-    canvasRef.current = el;
-    if (!el) return;
-    try {
-      new Chart(el, {
-        type: "line",
-        data: { labels: [row.id], datasets: [{ data: [row.value] }] },
-      });
-    } catch {
-      // 忽略重复绑定
-    }
-  };
-
-  return (
-    <div className="row" style={{ animation: "pulse 1s infinite" }}>
-      {fmt.format(row.value)} · {label} · {picked}
-      <button onClick={() => onPick(row.id)}>pick</button>
-      <canvas ref={bindChart} width={80} height={24} />
-    </div>
-  );
-};
+"use client";
+
+import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
+import {
+  CategoryScale,
+  Chart,
+  LinearScale,
+  LineController,
+  LineElement,
+  PointElement,
+} from "chart.js";
+import { METRICS, RAW } from "@/lib/metrics";
+
+// 只注册本页用到的组件，替代 chart.js/auto 的全量注册（可被 tree-shake）
+Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale);
+
+// 固定刷新周期：单一 interval、随组件卸载清理，替代 tick 自增 + 1000/(tick+1)
+const REFRESH_MS = 8000;
+
+// Chart 构造/更新全部经此队列分片执行（每片一个宏任务，浏览器可在片间
+// 穿插渲染与输入处理），避免 300 个图表在同一主线程任务里同步构造
+// （实测未分片时首屏长任务 236ms + 82ms）
+const CHART_JOB_BUDGET_MS = 5;
+const chartJobQueue: Array<() => void> = [];
+let chartFlushScheduled = false;
+
+function flushChartJobs() {
+  const start = performance.now();
+  while (chartJobQueue.length > 0 && performance.now() - start < CHART_JOB_BUDGET_MS) {
+    chartJobQueue.shift()!();
+  }
+  if (chartJobQueue.length > 0) {
+    setTimeout(flushChartJobs, 0);
+  } else {
+    chartFlushScheduled = false;
+  }
+}
+
+function enqueueChartJob(job: () => void) {
+  chartJobQueue.push(job);
+  if (!chartFlushScheduled) {
+    chartFlushScheduled = true;
+    setTimeout(flushChartJobs, 0);
+  }
+}
+
+// 模块级共享，避免每次渲染重建
+const numberFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
+// 显式 locale + 时区：SSR(Node) 与 CSR(浏览器) 的默认 locale/时区可能不同，
+// 不定死会在水合时产生文本不一致（React #519 的来源之一）
+const timeFmt = new Intl.DateTimeFormat("en-US", {
+  timeZone: "UTC",
+  year: "numeric",
+  month: "numeric",
+  day: "numeric",
+  hour: "numeric",
+  minute: "numeric",
+  second: "numeric",
+});
+
+type RowData = { id: string; name: string; value: number; ts: number };
+
+// 首帧（SSR 与水合）专用：th 全 null（系数 1）、ts 固定为 0，
+// 保证服务端与客户端首次渲染输出逐字节一致
+function computeInitialRows(): RowData[] {
+  return METRICS.map((m) => ({ id: m.id, name: m.name, value: m.compute(RAW, null), ts: 0 }));
+}
+
+// 仅在客户端事件上下文（mount effect / interval 回调）中调用
+function readThresholds(): (string | null)[] {
+  return METRICS.map((_, i) => localStorage.getItem(`th-${i}`));
+}
+
+function computeRows(ths: (string | null)[]): RowData[] {
+  const now = Date.now();
+  return METRICS.map((m, i) => ({
+    id: m.id,
+    name: m.name,
+    value: m.compute(RAW, ths[i]),
+    ts: now,
+  }));
+}
+
+export default function Dashboard({ filter }: { filter: string }) {
+  // 惰性初始化：初值只在首次渲染计算一次，不会随重渲染重复求值
+  const [rows, setRows] = useState<RowData[]>(computeInitialRows);
+  const [picks, setPicks] = useState<Record<string, number>>({});
+  const [query, setQuery] = useState(filter);
+  const lastScrollAt = useRef(0);
+
+  // 挂载后接入 localStorage 阈值语义：仅当确实存在 th-* 键时才重算，
+  // 否则首帧（th=null 口径）已是正确值，不再产生多余提交。
+  useEffect(() => {
+    const ths = readThresholds();
+    // eslint-disable-next-line react-hooks/set-state-in-effect -- 水合后一次性同步外部存储（localStorage），是有意的单次级联
+    if (ths.some((th) => th !== null)) setRows(computeRows(ths));
+  }, []);
+
+  // 单一固定周期定时器：创建一次、卸载清理，不随渲染重复注册
+  useEffect(() => {
+    const id = setInterval(() => {
+      setRows(computeRows(readThresholds()));
+    }, REFRESH_MS);
+    return () => clearInterval(id);
+  }, []);
+
+  // 标题随数据刷新持续维护（Next 会在水合完成时按 metadata 重置一次标题，
+  // 只在挂载时写一次会被覆盖）；不再写入 Math.random() 噪声
+  useEffect(() => {
+    document.title = `监控 ${rows.length}`;
+  }, [rows]);
+
+  useEffect(() => {
+    const onScroll = () => {
+      // 保留滚动监听，但不再读 offsetHeight 强制同步布局
+      lastScrollAt.current = Date.now();
+    };
+    window.addEventListener("scroll", onScroll, { passive: true });
+    return () => window.removeEventListener("scroll", onScroll);
+  }, []);
+
+  // rows 每次刷新都是新引用，浅拷贝后排序即可（不再 JSON 深拷贝）
+  const sorted = useMemo(() => [...rows].sort((a, b) => b.value - a.value), [rows]);
+
+  const onPick = useCallback((id: string) => {
+    // setState 触发当次渲染即更新 UI，替代只改模块变量等下次渲染
+    setPicks((p) => ({ ...p, [id]: (p[id] ?? 0) + 1 }));
+  }, []);
+
+  const q = query.trim().toLowerCase();
+
+  return (
+    <div>
+      <input
+        value={query}
+        onChange={(e) => setQuery(e.target.value)}
+        placeholder="过滤指标…"
+      />
+      {sorted.map((r) => (
+        <Row
+          key={r.id}
+          row={r}
+          picked={picks[r.id]}
+          onPick={onPick}
+          hidden={q !== "" && !`${r.id} ${r.name}`.toLowerCase().includes(q)}
+        />
+      ))}
+    </div>
+  );
+}
+
+type RowProps = {
+  row: RowData;
+  picked?: number;
+  onPick: (id: string) => void;
+  hidden: boolean;
+};
+
+const Row = memo(function Row({ row, picked, onPick, hidden }: RowProps) {
+  const canvasRef = useRef<HTMLCanvasElement | null>(null);
+  const chartRef = useRef<Chart<"line"> | null>(null);
+  const valueRef = useRef(row.value);
+
+  // 每个 canvas 只构造一次 Chart（卸载时 destroy），不再每次渲染重绑；
+  // 构造经队列分片，避免 300 个实例挤爆单个主线程任务
+  useEffect(() => {
+    let cancelled = false;
+    enqueueChartJob(() => {
+      if (cancelled) return;
+      const el = canvasRef.current;
+      if (!el) return;
+      const chart = new Chart(el, {
+        type: "line",
+        data: { labels: [row.id], datasets: [{ data: [valueRef.current] }] },
+        options: {
+          animation: false,
+          responsive: false,
+          events: [],
+          scales: {
+            x: { display: false, ticks: { display: false } },
+            y: { display: false, ticks: { display: false } },
+          },
+        },
+      });
+      chartRef.current = chart;
+    });
+    return () => {
+      cancelled = true;
+      chartRef.current?.destroy();
+      chartRef.current = null;
+    };
+  }, [row.id]);
+
+  // 数据随行更新：排序/刷新后复用既有实例，update 而非 new。
+  // 图表尚未由分片任务创建时跳过——创建时会直接采用 valueRef 最新值。
+  useEffect(() => {
+    // 分片任务执行前同步最新值（effect 先于 setTimeout 任务运行）
+    valueRef.current = row.value;
+    enqueueChartJob(() => {
+      const chart = chartRef.current;
+      if (!chart) return;
+      chart.data.datasets[0].data = [row.value];
+      chart.update("none");
+    });
+  }, [row.value]);
+
+  return (
+    <div className="row" style={hidden ? { display: "none" } : undefined}>
+      {numberFmt.format(row.value)} · {timeFmt.format(row.ts)} · {picked}
+      <button onClick={() => onPick(row.id)}>pick</button>
+      <canvas ref={canvasRef} width={80} height={24} />
+    </div>
+  );
+});
```

### 9.3 `app/perf/page.tsx`

未修改（diff 为空）。原因见 §1.3。

### 9.4 `app/globals.css`

```diff
--- /tmp/orig/globals.css	2026-10-06 13:55:09.364523685 +0800
+++ app/globals.css	2026-10-06 12:33:45.353888769 +0800
@@ -55,6 +55,10 @@
   padding: 4px 8px;
   border-bottom: 1px solid rgba(127, 127, 127, 0.2);
   font-variant-numeric: tabular-nums;
+  /* 脉冲动画从内联样式收敛到类，并由 content-visibility 让屏外行跳过渲染 */
+  animation: pulse 1s infinite;
+  content-visibility: auto;
+  contain-intrinsic-size: auto 32px;
 }
 
 @keyframes pulse {
```
