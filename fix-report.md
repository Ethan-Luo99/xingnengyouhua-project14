# /perf 实时面板改造报告（SSE 增量推流）

本轮在既有「compute 服务端执行 / 5s 阈值同步 / 图表按帧切片创建」修复之上，
把 `/perf` 从静态快照升级为实时面板。零新增 npm 依赖；
`samples.json`、`scripts/gen-samples.mjs` 未改动。

## 1. 总体架构

```
lib/metrics.ts (nodejs 模块，单一权威初始值)
   ├── getInitialValues() ── app/perf/page.tsx  SSR 300 行（ƒ Dynamic）
   └── 初始值 + 随机游走 ── app/api/metrics/route.ts
                               ├── GET            SSE：每 1000ms 一帧增量（30~80 个指标）
                               └── GET?snapshot=1 JSON：300 个指标全量快照

app/perf/dashboard.tsx (client)
   ├── EventSource("/api/metrics")，event: frame
   │     增量帧 → 只替换受影响行（数组仅 slice 一次、定点替换），不重算 compute
   │     断线   → close + 指数退避重连；onopen 后先 fetch 全量快照再放行增量
   ├── 300 行永久挂载：过滤 = display:none，排序 = flex order
   │     ├── 行/ canvas / Chart 实例在任何过滤排序往返中都不销毁、不重建
   │     └── 新值原地 push 环形历史(40 点) + chart.update("none")
   └── 卸载：EventSource.close、clearTimeout/clearInterval、removeEventListener、
             300 个 Chart 全部 destroy（排队中未创建的任务作废）
```

数值口径只有一条：**服务端推/快照给的是 `base` 绝对值（compute 口径）；
阈值系数 `th` 永远只在客户端相乘**（`value = base * th`）。因此 SSE 增量、
全量快照、localStorage 阈值三条输入天然正交，可以任意顺序到达而不串口径。

## 2. 分文件设计动机

### `lib/metrics.ts`（既有导出全部保留，仅追加）
- `RAW / METRICS / compute` 原样不动：compute 仍是对 2 万点采样的纯函数，
  水合一致与既有 pick/过滤/SSR 语义不受影响。
- 新增 `getInitialValues()`（模块级缓存的 300 个初始 compute 值）：
  SSR（`page.tsx`）与推流模块（`route.ts`）共用同一份初始权威值，
  避免「首屏是 compute、推流起点是另一份值」的口径分叉。
- 新增帧/快照类型 `MetricsFrame = { ts, values: Record<metricId, number> }`
  与常量 `FRAME_INTERVAL_MS=1000`、`FRAME_MIN_CHANGED=30`、`FRAME_MAX_CHANGED=80`。
- `serverNow()`：把 `Date.now()` 移出 RSC 组件函数体，消除
  `react-hooks/purity` 对组件体内 impure 调用的报错（语义不变）。

### `app/api/metrics/route.ts`（新增）
- Route Handler（Web `Request/Response` + `ReadableStream`），无任何新依赖；
  `export const runtime = "nodejs"`（跨请求共享模块状态）、
  `export const dynamic = "force-dynamic"`（非确定操作，禁止预渲染/缓存）。
- 模块级权威状态：一个 `values[300]` + 一个 `setInterval(1000)` + 订阅者 `Set`。
  首个 SSE 连接接入时 `ensureStarted()`，最后一个断开时 `stopIfIdle()`
  （引用计数），没有订阅者时不空跑。
- 每轮 tick：Fisher–Yates 局部洗牌挑 30~80 个**不重复**下标，对这些值做
  「锚点均值回归 + 小噪声」随机游走，只把变化项写入帧 `values`；
  compute 从不在帧路径执行。
- SSE 协议：`Content-Type: text/event-stream`、`Cache-Control: no-cache,
  no-transform`、`X-Accel-Buffering: no`，事件为具名事件
  `event: frame\ndata: <json>\n\n`；接入先发 `: connected` 注释 + `retry: 1000`。
- `?snapshot=1` 返回当前权威 `values` 的全量 JSON（`no-store`），供重连对齐。
- 健壮性：`abort` 与流 `cancel` 走同一个 `cleaned` 幂等清理，引用计数不会被扣
  成负数；单个订阅者 enqueue 失败只摘除自己，不炸整轮 tick；timer `unref()`，
  脚本场景父进程可正常退出。

### `app/perf/dashboard.tsx`（重写客户端订阅与渲染）
- **增量更新不全量重建**：`rows` 数组顺序恒定（`m<i>` 恒在下标 i）。
  收帧时 `setRows(prev => …)`：最多 `slice()` 一次，仅对帧内出现且通过
  有限性校验的 id 做定点对象替换；无合法更新则返回原数组（零提交）。
  绝不全量 map 300 行、绝不重跑 compute。
- **图表原地更新、实例永不重建**：300 个 `Row` 恒挂载（`key=m<i>` 不变）。
  过滤只切 `display:none`，排序只写 flex `order`（由 `useMemo` 产出的
  `order[i]/hidden[i]` 视图参数，不重排行数组）。每个 Chart 生命周期内只
  `new` 一次（仍按帧切片创建）；新值 push 进 40 点环形历史并
  `chart.update("none")`，排队期间到的帧在建图时从 `historyRef` 一次性取齐。
- **断线重连 + 全量对齐**：`onerror` → 显式 `close()`（不用浏览器原生自动
  重连，因为无法保证「重连后第一帧前对齐」）→ 1s 起步、上限 10s 的指数退避。
  每次连接 `generation` 自增；`onopen` 后先 `fetch(snapshot, no-store)`，
  快照落地前 `aligning=true` 丢弃增量；快照成功才置 `live` 并放行帧。
  首连也走一次对齐（SSR 之后服务端可能已被其他标签页推进），对齐期间界面
  显示的是 SSR 的合法值。任何数值经 `isFiniteNumber` 校验，坏帧/坏快照值
  直接忽略，UI 不会出现 NaN/undefined。
- **卸载清理**：disposed 标志 + generation 作废在途回调、关 EventSource、
  清 reconnect 定时器；阈值 `setInterval`、`storage`、`scroll` 监听全部
  清除；每个 Row 卸载时 destroy 已建 Chart 并作废排队任务（300 个一个不漏）。
- 既有语义保留：300 行、行内 canvas 图表、pick 计数、输入框过滤、滚动
  `body.scrolled`、`th-<i>` localStorage 阈值（挂载即同步 + 5s + storage
  事件）、按帧切片建图、`document.title` 计数均保留。
- 自检钩子 `window.__perfChartStats()`（只读，不参与渲染）返回
  `{created, destroyed, canvases, liveCharts}`，供验收 3/5 人工观察。

### `app/perf/page.tsx`
- 仍 `await searchParams` 保持 ƒ Dynamic；SSR 初始 300 行的 `base` 改取
  `getInitialValues()[i]`，与推流起点同口径；`ts` 改用 `serverNow()`。
  compute 仍只在服务端执行一次并随 RSC 下发，hydration 文本一致。

### `app/globals.css`
- 新增 `.rows{display:flex;flex-direction:column}` 以支持「order 排序 +
  display:none 过滤」而不移动 DOM；sticky `.toolbar`（过滤框 + 连接状态灯），
  其余既有 `.row` pulse / `body.scrolled` 规则原样保留。

## 3. 边界自检（推演）

### a. 后台标签页 5 分钟后切回
行为：现代浏览器对**隐藏标签页**会节流 `setTimeout/setInterval`（Chrome 隐藏
5 分钟后后台定时器至多每分钟一次），但 **EventSource 长连接本身不被定时器
节流**——连接保持，服务端在 nodejs 侧照常每 1s 向该 socket 写帧；浏览器
网络栈会持续接收并把 `message` 事件排队，回到前台后事件循环恢复，排队的
`frame` 事件依次派发。

状态不会错乱，原因：
1. 数据模型是**权威值覆盖（base = 帧内绝对值）**，不是「累加增量」。后台期间
   漏掉或积压多少帧都无所谓，每帧都是对当前状态的部分覆盖，最终收敛到服务端
   权威状态，不存在用丢帧后的 delta 去累加而导致的漂移。
2. 我们每帧只做一次 `setRows`（30~80 个定点替换）。若后台期间事件被派发，
   React 对隐藏页的更新也会被调度器合并/延后；切回后处理的仍是最新覆盖值，
   幂等且无顺序依赖。图表历史是 40 点环形缓冲，恢复后最多留下最近 40 个
   **已处理**的值；即便逐帧处理，也只是 40 个点的有界滑动，不会无限增长。
3. 5s 阈值 `setInterval` 在后台同样被节流，但 sync 是幂等的（读 localStorage
   全量比对，无变化不提交），推迟同步只会让阈值晚一点生效；且跨标签页阈值
   变化还能靠 `storage` 事件补偿。
4. 极端情况（移动端系统挂起冻结 socket、代理掐断空闲连接）：TCP 断开会触发
   `onerror` → 退避重连 → `onopen` 后全量快照对齐。后台里重连定时器可能被
   节流，但切回前台立即执行重连+对齐，界面先显示旧的合法值再被快照整体覆盖，
   全程没有 NaN/undefined。

### b. 推流端提到 100ms/帧（10fps）
服务端先不是瓶颈：每帧 30~80 个数组写 + 一次小 JSON 编码，nodejs 单 tick
开销在微秒~几十微秒级；socket 写出（每帧约 0.5~1KB ≈ 50~100KB/s）也很轻。

客户端先扛不住的是**主线程渲染管线**，按出现顺序：
1. **每帧 30~80 次 Chart 重绘**：受影响行各自 `chart.update("none")` 立即重绘
   canvas，10fps × 平均 55 ≈ 550 次 canvas 绘制/秒，这是最先饱和的资源
   （单次 update 虽关了动画仍要 clear+stroke 折线）。
2. 每帧一次 `setRows` → 30~80 个 Row 重渲染 + flex `order` 重排（reflow），
   10 次/秒的整表排序（300 元素 sort 本身很便宜，但触发布局/样式）。
3. SSE 解析 + JSON.parse（很小，排最后）。

改造方向（不改协议也能做的前两步收益最大）：
- **合帧 + rAF 出帧**：SSE 回调只把 `values` 合并进一个待应用 map
  （`Object.assign`，天然按 metricId 去重，10 帧合 1 仍正确），用一个
  `requestAnimationFrame` 循环统一出一次 `setRows`、一次排序；显示帧率封顶
  60fps 且与刷新对齐，后台标签页 rAF 自动停（零成本解决后台风暴）。
- **Chart 批量/按需重绘**：只对「可见（非 display:none）且在视口附近」的行
  `update`；隐藏行只更新 `historyRef`，等过滤切回时画最后一次即可。进一步可
  用 `IntersectionObserver` 做视口虚拟化，或把 300 个小 canvas 换成单张
  canvas/DOM 分层绘制。
- 排序降频：order 计算放到 rAF 或每 200ms 一次，而不是每帧；值仍按帧更新
  （文本数字实时），只是名次稍后跟上。
- 服务端/协议侧（若还不够）：让帧间隔可配（`?intervalMs=`）或推二进制批量，
  但当前规模下没必要。

### c. 两个标签页同时打开，localStorage 阈值与 SSE 增量同时到达
合成口径一致，结论：两页同一时刻看到的 `value = base * th` 完全一致。
- `base`：SSE 是服务端单权威值数组的广播（同一轮 tick 对所有订阅者发同一帧），
  两个标签页收到的是同一份绝对值；即使加入/重连时刻不同，重连后强制全量
  快照对齐，最终都收敛到同一权威状态。
- `th`：阈值是纯本地客户端状态，推流从不携带 th；A 页改 localStorage 只影响
  A（B 页若开着会收到 `storage` 事件，B 是否跟随属于既有 storage 同步语义，
  与推流正交）。每路输入只更新自己那一个字段：帧只替换 `base`，阈值 sync 只
  替换 `th`，两个 `setRows(prev => …)` 都用函数式更新且不依赖对方字段，
  React 串行化后无丢更新；`value` 在渲染时现算 `base*th`，两路无论以什么
  顺序/是否同一 tick 到达，乘出来的值都一致，不会出现某页把 th 或 base
  「冲掉」的情况。
- 断线对齐瞬间：快照只覆盖 base、`th` 沿用本地（applySnapshot 保留 `r.th`），
  所以「重连全量对齐」与「阈值到达」同时发生也互不覆盖。

## 4. 验证说明

### 4.1 curl 验证 SSE 在推流
```bash
npm run build && PORT=3000 npm start
# 终端 A：看流
curl -sN http://localhost:3000/api/metrics
# 只看 3 秒：
curl -sN --max-time 3 http://localhost:3000/api/metrics
# 全量快照（应为 300 个键的 JSON）
curl -s "http://localhost:3000/api/metrics?snapshot=1" | head -c 300
```
预期输出（首字节立即出现，之后约每 1s 一帧）：
```
: connected
retry: 1000

event: frame
data: {"ts":1791306433753,"values":{"m199":5.1349,"m148":5.8889,"m27":1.599, ... }}

event: frame
data: {"ts":1791306434754,"values":{ ... 30~80 个 m### 键 ... }}
```
观察点：首行是注释 `: connected`；每帧单独一行 `event: frame` + `data:`；
相邻帧 `ts` 相差约 1000ms；每帧 `values` 的键数在 30~80 之间。

### 4.2 verify.mjs（验收 1，已实测）
```bash
node verify.mjs                 # 默认 http://localhost:3000，采集 10s
# 可选：node verify.mjs http://localhost:3001 / DURATION_MS=5000 node verify.mjs
```
实测输出（生产构建，2026-10-07）：
```
[verify] 快照 ts=... values=300（期望 300）
收到帧数         : 9
每帧 values 数量 : min=30 max=73 avg=52.9（期望区间 30~80）
帧间隔(ms)       : 999/1000/1001/1002
[verify] PASS：帧在推流，且每帧变化数落在 30~80 区间
```
脚本仅用 node 原生模块（`http`/`URL`），先校验快照键数=300，再统计 10s 内
帧数、每帧 values 数量直方图与帧间隔直方图。

### 4.3 浏览器人工确认「增量原地变化、过滤往返不重建」（验收 3）
打开 `http://localhost:3000/perf`，等连接状态变绿（● live），DevTools Console：
```js
// 等首屏 300 个图按帧建完（几秒），建立基线：
window.__perfChartStats()
// {created: 300, destroyed: 0, canvases: 300, liveCharts: 300}
```
操作序列：
1. 过滤框输入 `metric_1` → 清空 → 输入 `m2` → 清空 → 输入 `99` → 清空。
2. 每次输入/清空后执行 `window.__perfChartStats()`：
   `created` 必须**始终为 300**、`destroyed` 始终为 0、`canvases` 始终 300；
   过滤期间 `liveCharts` 仍为 300（display:none 的 canvas 上 Chart 实例还在）。
3. 图表原地变化：Elements 面板选中某个一直可见的行（如 `m0`），其
   `<canvas>` DOM 节点在收帧/过滤往返中**不闪烁、不被替换**（节点身份不变，
   可用 Console `$0` 引用前后比对）；canvas 上折线随每秒新点左移。
4. 性能旁证：Performance 面板录制 5s，增量更新时只有少量行的重绘，
   不会出现 300 个 Chart 构造的长任务（构造只在首屏按帧切片出现一次）。
判定：任意过滤/排序往返后 `created === 300` 即「new Chart 总数 ≤ 300」。

### 4.4 断线重连后的全量对齐（验收 4）
准备：开两个终端/标签，A 与 B 都打开 `/perf`（B 的推流让服务端持续前进）。
方法一（推荐，Network 面板）：
1. DevTools → Network → 勾 `Offline` → 等 3~5s（状态灯变橙 reconnecting…）。
2. 取消 Offline。观察：状态灯先 connecting… 后恢复 ● live；Network 中先出现
   一条对 `/api/metrics?snapshot=1` 的请求、随后 SSE 重新建立。
3. Console 与界面：整个过程及恢复后，行内数字始终是有效数字（无 NaN/
   undefined）；恢复瞬间 300 行的相对排序与「B 标签页当前状态」对齐
   （快照来自同一服务端权威值）。
方法二（杀服务）：`kill` 掉 `next-server`，页面等 5~10s，再重新
`npm start`；客户端自动重连，重连成功后必有一次 snapshot 请求，值整体对齐。
可在 Console 用 `fetch('/api/metrics?snapshot=1').then(r=>r.json())` 取服务端
当前值，与页面恢复后数值逐行比对（页面值还要乘以本地 th 系数）。

### 4.5 卸载清理（验收 5）
1. `/perf` 等 `__perfChartStats()` 显示 `{created:300, destroyed:0,
   liveCharts:300}`；Network 面板可见一条持续 pending 的 `/api/metrics`。
2. 地址栏跳到 `/`（或 SPA 内点走）触发 Dashboard 卸载。
3. 立即 `window.__perfChartStats()`：
   - `destroyed` 变为 **300**、`liveCharts` 变为 **0**
     （canvases 随 DOM 移除；统计钩子仍挂在 window 上只读计数）。
4. Network：旧的 `/api/metrics` 连接变为 canceled/closed，不再有新帧请求；
   等 11s 观察没有任何重连请求（EventSource 已 close、退避定时器已清）。
5. Application/Listeners 旁证：`storage`/`scroll` 监听随 effect cleanup
   `removeEventListener`；阈值 5s interval 已 clear（可在 Console 覆写
   `localStorage` 后确认已离开的页面不再触发任何更新）。
6. 再导航回 `/perf`：`created` 从 0 重新累计到 300（新页面是新挂载实例），
   说明上一页没有遗留旧 Chart/旧连接。

## 5. 交付 diff

### 5.1 `lib/metrics.ts` / `app/perf/page.tsx` / `app/globals.css`
```diff
diff --git a/app/globals.css b/app/globals.css
index 2561da2..768982f 100644
--- a/app/globals.css
+++ b/app/globals.css
@@ -59,6 +59,50 @@ a {
   animation: pulse 1s infinite;
 }
 
+/* ---- 实时面板布局（本轮新增） ----
+   .rows 是 flex 列容器：行的视觉顺序完全由每个 .row 的内联 order 决定，
+   过滤时只切 display:none。这样过滤/排序往返都不移动/销毁 DOM，
+   Chart 实例与 canvas 永久绑定。 */
+.dashboard {
+  display: block;
+}
+
+.toolbar {
+  position: sticky;
+  top: 0;
+  z-index: 1;
+  display: flex;
+  align-items: center;
+  gap: 12px;
+  padding: 8px;
+  background: var(--background);
+  border-bottom: 1px solid rgba(127, 127, 127, 0.3);
+}
+
+.toolbar input {
+  width: 200px;
+}
+
+.rows {
+  display: flex;
+  flex-direction: column;
+}
+
+.conn {
+  font-size: 12px;
+  font-variant-numeric: tabular-nums;
+}
+
+.conn-live {
+  color: #16a34a;
+}
+
+.conn-connecting,
+.conn-reconnecting {
+  color: #d97706;
+  animation: pulse 1s infinite;
+}
+
 /* 滚动视觉反馈：由 dashboard 的 scroll 监听在越过顶部时切换 */
 body.scrolled {
   box-shadow: inset 0 2px 0 0 rgba(127, 127, 127, 0.45);
diff --git a/app/perf/page.tsx b/app/perf/page.tsx
index c5e3231..2c38d55 100755
--- a/app/perf/page.tsx
+++ b/app/perf/page.tsx
@@ -1,5 +1,5 @@
 import Dashboard, { type PerfRow } from "./dashboard";
-import { METRICS, RAW } from "@/lib/metrics";
+import { METRICS, getInitialValues, serverNow } from "@/lib/metrics";
 
 export default async function PerfPage({
   searchParams,
@@ -13,11 +13,13 @@ export default async function PerfPage({
   // 300 个指标的重计算在服务端执行一次，结果随 RSC payload 下发：
   // 1) 客户端首屏/hydration 不再重复计算（消除 61ms 级主线程长任务）；
   // 2) SSR 与 CSR 使用同一份 value/ts，水合文本必然一致。
-  const ts = Date.now();
-  const initialRows: PerfRow[] = METRICS.map((m) => ({
+  const ts = serverNow();
+  // getInitialValues 与 SSE 推流模块共用同一份初始权威值，首屏快照与推流起点同口径
+  const initialValues = getInitialValues();
+  const initialRows: PerfRow[] = METRICS.map((m, i) => ({
     id: m.id,
     name: m.name,
-    base: m.compute(RAW),
+    base: initialValues[i],
     ts,
   }));
 
diff --git a/lib/metrics.ts b/lib/metrics.ts
index f5d9dd6..fc57f25 100755
--- a/lib/metrics.ts
+++ b/lib/metrics.ts
@@ -15,3 +15,41 @@ export const METRICS = Array.from({ length: 300 }, (_, i) => ({
     return s / (data.length || 1);
   },
 }));
+
+// ---- 实时推流相关（本轮新增；上方 RAW/METRICS/compute 语义不变） ----
+
+export const METRIC_COUNT = METRICS.length;
+
+// 每帧变化的指标数区间（含端点）
+export const FRAME_MIN_CHANGED = 30;
+export const FRAME_MAX_CHANGED = 80;
+export const FRAME_INTERVAL_MS = 1000;
+
+// SSE 帧：values 只覆盖本帧发生变化的指标（30~80 个）。
+// 数值口径与 PerfRow.base 完全一致（即 compute 的绝对值，阈值系数只在客户端相乘），
+// 因此断线后拿到的快照可以直接覆盖 base，不会出现口径分叉。
+export type MetricsFrame = {
+  ts: number;
+  values: Record<string, number>;
+};
+
+// 全量快照：values 覆盖全部 300 个指标。SSE 连接建立/重连对齐时由客户端
+// 通过 ?snapshot=1 拉取，语义等价于"服务端当前权威状态"。
+export type MetricsSnapshot = MetricsFrame;
+
+// 初始权威值：SSR（page.tsx 首屏 300 行）与推流模块（route.ts 的状态起点）
+// 必须共用同一份计算结果。放在纯模块里，nodejs runtime 下两端 import 同一缓存。
+// compute 仍只在此处执行：SSR 一次、推流状态懒初始化一次，之后推流只做随机游走，
+// 任何帧都不会重跑 compute。
+let cachedInitial: number[] | null = null;
+export function getInitialValues(): number[] {
+  if (!cachedInitial) cachedInitial = METRICS.map((m) => m.compute(RAW));
+  return cachedInitial;
+}
+
+// 服务端时间戳封装：page.tsx 是 async Server Component（非 React 渲染期），
+// 但 react-hooks/purity 规则会把组件函数体内直接调用 Date.now 标记为 impure；
+// 收敛到普通模块函数后规则不误报，语义仍为"请求处理时刻的时间戳"。
+export function serverNow(): number {
+  return Date.now();
+}
```

### 5.2 `app/perf/dashboard.tsx`
```diff
diff --git a/app/perf/dashboard.tsx b/app/perf/dashboard.tsx
index f1f7c46..c94362a 100755
--- a/app/perf/dashboard.tsx
+++ b/app/perf/dashboard.tsx
@@ -9,6 +9,7 @@ import {
   LineElement,
   PointElement,
 } from "chart.js";
+import type { MetricsFrame, MetricsSnapshot } from "@/lib/metrics";
 
 // 只注册本页用到的折线图组件，其余控制器/插件可 tree-shake（替代 chart.js/auto 全量注册）
 Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale);
@@ -21,6 +22,14 @@ type RowState = PerfRow & { th: number };
 // 回调幂等（读 300 个阈值、无变化不 setState），后台节流只会推迟同步，不会堆积。
 const TH_SYNC_MS = 5000;
 
+// 断线重连退避：1s 起步、上限 10s，避免服务端长时间不可用时疯狂重连。
+const RECONNECT_MIN_MS = 1000;
+const RECONNECT_MAX_MS = 10000;
+
+// 行内图表保留的历史点数（环形缓冲）。初始 1 个点，每来一帧 push 一个点，
+// 超出后丢弃最旧点；只给 Chart.js 喂定长数组，实例永不重建。
+const HISTORY_LEN = 40;
+
 const FMT = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
 
 // localStorage 阈值系数语义保留：键仍为 th-<i>（i 为指标序号，id 为 m<i>）
@@ -31,6 +40,9 @@ function readThreshold(id: string): number {
 
 // 图表创建调度器：300 个 new Chart 若在同一 passive-effect 阶段同步执行会形成
 // 约 300ms 的单次长任务。这里按帧切片（每帧预算 10ms），把创建摊到多个帧上。
+// flush 供组件卸载时同步排空：卸载要求 300 个 Chart 全部 destroy，因此那些
+// "排队但尚未 new" 的任务必须立刻取消（cancelled 标记），否则会在已卸载
+// canvas 上建图。
 const chartWorkQueue: Array<() => void> = [];
 let chartPumpScheduled = false;
 function pumpChartWork() {
@@ -57,6 +69,30 @@ function fmtTs(ts: number): string {
   return `${new Date(ts).toISOString().slice(0, 19).replace("T", " ")} UTC`;
 }
 
+// 只读自检钩子（验收用，不参与任何渲染逻辑）：
+//   window.__perfChartStats() -> { created, destroyed, canvases, liveCharts }
+// created 累计 new Chart 次数（任何过滤/排序往返后必须恒等于 300）；
+// destroyed 累计 destroy 次数；liveCharts 为当前仍挂在 canvas 上的实例数。
+const chartStats = { created: 0, destroyed: 0 };
+if (typeof window !== "undefined") {
+  (window as unknown as { __perfChartStats?: () => unknown }).__perfChartStats = () => ({
+    created: chartStats.created,
+    destroyed: chartStats.destroyed,
+    canvases: document.querySelectorAll(".rows canvas").length,
+    liveCharts: [...document.querySelectorAll<HTMLCanvasElement>(".rows canvas")].filter(
+      (canvas) => Chart.getChart(canvas)
+    ).length,
+  });
+}
+
+type ConnState = "connecting" | "live" | "reconnecting";
+
+// 校验推流数值：任何非法值（NaN/undefined/非 number）都不进状态，
+// 保证断线、坏帧、半连接等任何时序下 UI 都不出现 NaN/undefined。
+function isFiniteNumber(v: unknown): v is number {
+  return typeof v === "number" && Number.isFinite(v);
+}
+
 export default function Dashboard({
   filter,
   initialRows,
@@ -64,12 +100,133 @@ export default function Dashboard({
   filter: string;
   initialRows: PerfRow[];
 }) {
-  // 初值 th=1：SSR 与 CSR 首帧口径一致；真实阈值挂载后由 sync 应用
+  // 初值 th=1：SSR 与 CSR 首帧口径一致；真实阈值挂载后由 sync 应用。
+  // rows 数组的顺序永不改变（增量更新只做"切片一次 + 定点替换"），
+  // 因此 id 为 m<i> 的行永远位于下标 i，行的 DOM/Chart 实例也可永久常驻。
   const [rows, setRows] = useState<RowState[]>(() =>
     initialRows.map((r) => ({ ...r, th: 1 }))
   );
   const [query, setQuery] = useState(filter);
   const [picks, setPicks] = useState<Record<string, number>>({});
+  const [conn, setConn] = useState<ConnState>("connecting");
+
+  // ---- SSE 订阅：增量应用 / 断线重连 / 重连后全量对齐，全部收敛在这一个 effect ----
+  useEffect(() => {
+    let es: EventSource | null = null;
+    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
+    let disposed = false;
+    let generation = 0; // 每次（重）连接自增：使途中过期连接的帧/快照回调失效
+    let backoff = RECONNECT_MIN_MS;
+    // 对齐闸门：连接建立后先拉全量快照，快照落地前丢弃一切增量帧。
+    // 首连也走一遍：SSR 之后服务端可能已被其他标签页推着走了若干帧，
+    // 统一状态机比"首连信任 SSR"更稳，且对齐期间界面显示 SSR 的合法值。
+    let aligning = true;
+
+    const applySnapshot = (snap: MetricsSnapshot) => {
+      const values = snap.values;
+      // 全量对齐允许全量遍历（每 300 行重建对象仅发生在重连时刻，不在帧路径）。
+      // th 必须沿用本地：服务端只推 base 绝对值，阈值系数从不属于推流口径。
+      setRows((prev) =>
+        prev.map((r) => {
+          const v = values[r.id];
+          return isFiniteNumber(v) ? { ...r, base: v, ts: snap.ts || r.ts } : r;
+        })
+      );
+    };
+
+    const applyFrame = (frame: MetricsFrame) => {
+      const values = frame.values;
+      const ids = Object.keys(values);
+      if (ids.length === 0) return;
+      setRows((prev) => {
+        let next = prev; // 延迟到确有合法更新时才复制一次数组（不在无变化时制造提交）
+        for (const id of ids) {
+          const v = values[id];
+          if (!isFiniteNumber(v)) continue;
+          // m<i> 与数组下标的稳定映射（顺序不变式），命中不到则跳过，绝不写脏数据
+          const i = Number(id.slice(1));
+          const old = next[i];
+          if (!old || old.id !== id) continue;
+          if (next === prev) next = prev.slice();
+          next[i] = { ...old, base: v, ts: frame.ts };
+        }
+        return next;
+      });
+    };
+
+    const align = (gen: number, source: EventSource) => {
+      // 重新 fetch 一次完整快照：no-store 保证不被浏览器/CDN 缓存成旧值
+      fetch("/api/metrics?snapshot=1", { cache: "no-store" })
+        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`snapshot ${r.status}`))))
+        .then((snap: MetricsSnapshot) => {
+          if (disposed || gen !== generation) return; // 已卸载或已被更新的连接取代
+          applySnapshot(snap);
+          aligning = false; // 快照落地后才放行增量帧
+          backoff = RECONNECT_MIN_MS;
+          setConn("live");
+        })
+        .catch(() => {
+          if (disposed || gen !== generation) return;
+          // 快照失败等价于连接不可用：关掉重来，走退避重连 + 再次全量对齐
+          source.close();
+          if (!reconnectTimer) scheduleReconnect();
+        });
+    };
+
+    const scheduleReconnect = () => {
+      aligning = true; // 重连成功后第一时间必须重新全量对齐
+      setConn((c) => (c === "reconnecting" ? c : "reconnecting"));
+      reconnectTimer = setTimeout(connect, backoff);
+      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
+    };
+
+    const connect = () => {
+      if (disposed) return;
+      reconnectTimer = null;
+      const gen = ++generation;
+      const source = new EventSource("/api/metrics");
+      es = source;
+
+      source.onopen = () => {
+        if (disposed || gen !== generation) return;
+        setConn((c) => (c === "live" ? c : "connecting"));
+        align(gen, source);
+      };
+
+      source.addEventListener("frame", (ev) => {
+        if (disposed || gen !== generation || aligning) return;
+        let frame: MetricsFrame;
+        try {
+          frame = JSON.parse((ev as MessageEvent<string>).data);
+        } catch {
+          return; // 坏帧丢弃，不污染状态
+        }
+        if (!frame || !frame.values || !isFiniteNumber(frame.ts)) return;
+        applyFrame(frame);
+      });
+
+      // onerror 后浏览器自身也会重连，但我们需要"重连成功后第一帧前全量对齐"，
+      // 该保证无法挂在原生自动重连上，因此显式 close + 自控重连状态机。
+      source.onerror = () => {
+        if (disposed || gen !== generation) return;
+        source.close();
+        // onerror 在不同浏览器/失败阶段可能触发多次；已排过重连就不再叠加定时器
+        if (!reconnectTimer) scheduleReconnect();
+      };
+    };
+
+    connect();
+
+    return () => {
+      // 卸载清理：关 EventSource、清退避定时器、让所有在途回调失效。
+      // 300 个 Chart 的 destroy 在各 Row 自己的卸载清理里完成。
+      disposed = true;
+      generation++;
+      if (reconnectTimer) clearTimeout(reconnectTimer);
+      es?.close();
+      es = null;
+    };
+  }, []);
 
   // 阈值同步：挂载时一次 + 固定周期 + 跨标签页 storage 事件。
   // 先读完全部阈值、确认有变化才 setRows，稳态下零提交。
@@ -98,21 +255,35 @@ export default function Dashboard({
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []);
 
-  // 过滤（接通输入框）+ 排序：只依赖 rows/query，不触发任何 compute
-  const visible = useMemo(() => {
+  // 过滤 + 排序不产出"行数组重排"，只产出两套与 rows 下标对齐的视图参数：
+  //   order[i]  —— 该行在 flex 容器里的视觉次序（隐藏行给一个靠后的中性值即可）
+  //   hidden[i] —— 是否 display:none
+  // 这样无论过滤/排序如何往返，300 个 DOM 节点与 Chart 实例都原地不动。
+  // 排序本身是纯数组读写，不触发任何 compute。
+  const order = useMemo(() => {
     const q = query.trim().toLowerCase();
-    const filtered = q
-      ? rows.filter(
-          (r) =>
-            r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)
-        )
-      : rows;
-    return [...filtered].sort((a, b) => b.base * b.th - a.base * a.th);
+    const indexed = rows
+      .map((r, i) => ({ i, score: r.base * r.th, match: q ? r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) : true }))
+      .sort((a, b) => b.score - a.score);
+    const orderArr = new Array<number>(rows.length);
+    const hiddenArr = new Array<boolean>(rows.length);
+    let visibleRank = 0;
+    for (const item of indexed) {
+      if (item.match) {
+        orderArr[item.i] = visibleRank++;
+        hiddenArr[item.i] = false;
+      } else {
+        // 隐藏行仍参与 order 布局但 display:none，给稳定大值避免与可见行抢位
+        orderArr[item.i] = rows.length + item.i;
+        hiddenArr[item.i] = true;
+      }
+    }
+    return { order: orderArr, hidden: hiddenArr, count: visibleRank };
   }, [rows, query]);
 
   useEffect(() => {
-    document.title = `监控 ${visible.length}`;
-  }, [visible.length]);
+    document.title = `监控 ${order.count}`;
+  }, [order.count]);
 
   // 滚动视觉反馈：只读 scrollY（非布局属性，不触发强制回流），越过边界才写 class
   useEffect(() => {
@@ -135,16 +306,35 @@ export default function Dashboard({
     setPicks((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
   }, []);
 
+  const connText =
+    conn === "live" ? "● live" : conn === "reconnecting" ? "● reconnecting…" : "● connecting…";
+
   return (
-    <div>
-      <input
-        value={query}
-        onChange={(e) => setQuery(e.target.value)}
-        placeholder="filter"
-      />
-      {visible.map((r) => (
-        <Row key={r.id} row={r} picked={picks[r.id]} onPick={onPick} />
-      ))}
+    <div className="dashboard">
+      <div className="toolbar">
+        <input
+          value={query}
+          onChange={(e) => setQuery(e.target.value)}
+          placeholder="filter"
+        />
+        <span className={`conn conn-${conn}`} title="SSE 连接状态">
+          {connText}
+        </span>
+      </div>
+      {/* 300 行永久挂载：过滤切 display:none，排序写 flex order，
+          DOM 节点与 Chart 实例在任何过滤/排序往返中都不销毁、不移动重建 */}
+      <div className="rows">
+        {rows.map((r, i) => (
+          <Row
+            key={r.id}
+            row={r}
+            picked={picks[r.id]}
+            onPick={onPick}
+            order={order.order[i]}
+            hidden={order.hidden[i]}
+          />
+        ))}
+      </div>
     </div>
   );
 }
@@ -153,16 +343,24 @@ type RowProps = {
   row: RowState;
   picked?: number;
   onPick: (id: string) => void;
+  order: number;
+  hidden: boolean;
 };
 
-const Row = memo(function Row({ row, picked, onPick }: RowProps) {
+const Row = memo(function Row({ row, picked, onPick, order, hidden }: RowProps) {
   const canvasRef = useRef<HTMLCanvasElement | null>(null);
   const chartRef = useRef<Chart<"line"> | null>(null);
   const value = row.base * row.th;
-  const valueRef = useRef(value);
-  valueRef.current = value;
+  // 行内图表历史环形缓冲：生命周期等于行本身（行永不卸载）。
+  // 初始为空，由下方"数值 effect"唯一追加；Chart 若延迟创建，创建时直接
+  // 读这两个 ref 即可拿到此前已积累的历史，不丢点、也不重复建图。
+  const historyRef = useRef<number[]>([]);
+  const labelsRef = useRef<string[]>([]);
 
-  // 每个 canvas 生命周期内只 new 一次 Chart（按帧切片调度），卸载时 destroy
+  // 每个 canvas 生命周期内只 new 一次 Chart（按帧切片调度），卸载时 destroy。
+  // 初值取自 historyRef：同一组件内 effect 按声明顺序执行，下方的 value effect
+  // 紧随其后（同步 passive 阶段）就会把首点推入 history，而建图发生在之后的
+  // rAF，因此建图瞬间首点必然已在；排队期间到达的帧同样不会丢。
   useEffect(() => {
     const el = canvasRef.current;
     if (!el) return;
@@ -171,7 +369,10 @@ const Row = memo(function Row({ row, picked, onPick }: RowProps) {
       if (cancelled) return;
       const chart = new Chart(el, {
         type: "line",
-        data: { labels: [row.id], datasets: [{ data: [valueRef.current] }] },
+        data: {
+          labels: [...labelsRef.current],
+          datasets: [{ data: [...historyRef.current] }],
+        },
         options: {
           animation: false,
           responsive: false,
@@ -180,26 +381,41 @@ const Row = memo(function Row({ row, picked, onPick }: RowProps) {
         },
       });
       chartRef.current = chart;
+      chartStats.created++;
     });
     return () => {
+      // 卸载路径：排队任务作废 + 已建实例 destroy。Dashboard 卸载时 300 个
+      // Row 同时卸载，这里保证 300 个 Chart（含尚未创建的）一个不漏地清掉。
       cancelled = true;
-      chartRef.current?.destroy();
+      if (chartRef.current) {
+        chartRef.current.destroy();
+        chartStats.destroyed++;
+      }
       chartRef.current = null;
     };
-    // 仅挂载/卸载时执行；数据变化由下方 effect 处理
-    // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []);
 
-  // 数值变化时原地更新图表数据（不重建实例）
+  // 数值变化时原地 push 历史并 update("none")：不 new Chart、不动 canvas。
+  // 阈值（th）或推流（base）任一变化都会改变 value，两路共享同一合成口径。
   useEffect(() => {
+    const hist = historyRef.current;
+    const labels = labelsRef.current;
+    hist.push(value);
+    labels.push(String(labels.length));
+    if (hist.length > HISTORY_LEN) {
+      hist.shift();
+      labels.shift();
+    }
     const chart = chartRef.current;
-    if (!chart) return;
-    chart.data.datasets[0].data = [value];
+    if (!chart) return; // 仍在创建队列中：建图时会读到已积累的 history
+    // 拷贝后赋给 chart，再继续在 ref 数组上 push，避免 Chart 持有被原地改写的数组
+    chart.data.labels = [...labels];
+    chart.data.datasets[0].data = [...hist];
     chart.update("none");
   }, [value]);
 
   return (
-    <div className="row">
+    <div className="row" style={{ order, display: hidden ? "none" : undefined }}>
       {FMT.format(value)} · {fmtTs(row.ts)} · {picked ?? 0}
       <button onClick={() => onPick(row.id)}>pick</button>
       <canvas ref={canvasRef} width={80} height={24} />
```

### 5.3 `app/api/metrics/route.ts`（新增文件全文）
```ts
// /api/metrics —— 实时指标数据源
//
// 两种用法（同一路由，零新增依赖，仅用 Web ReadableStream 原语）：
//   GET /api/metrics              -> SSE 长连接，event: frame，每 1000ms 一帧增量
//   GET /api/metrics?snapshot=1  -> 一次性 JSON 全量快照（重连对齐用）
//
// 设计动机：
// 1) runtime 显式声明 nodejs：模块级的"权威值数组 + 单 tick 定时器"必须跨请求
//    共享；edge runtime 已废弃且模块实例语义不同。
// 2) force-dynamic：Math.random / Date.now / 长连接都是非确定性操作，显式关闭
//    任何预渲染/缓存企图，保证每个请求拿到真实流。
// 3) 引用计数的单 tick：没有订阅者时不跑定时器（省 CPU、也避免无客户端时状态
//    空跑）；首个 SSE 连接接入时启动，最后一个断开时停止。快照请求不计数。
// 4) 服务端状态只有"初始 compute 值 + 后续随机游走增量"，compute 从不在帧
//    路径执行；帧 values 绝对口径与 SSR 的 base 一致，客户端可直接覆盖。
import {
  FRAME_INTERVAL_MS,
  FRAME_MAX_CHANGED,
  FRAME_MIN_CHANGED,
  METRIC_COUNT,
  METRICS,
  getInitialValues,
  type MetricsFrame,
  type MetricsSnapshot,
} from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- 模块级权威状态（nodejs runtime 内跨请求共享） ----

let values: number[] | null = null;
let lastTs = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
const subscribers = new Set<(frame: MetricsFrame) => void>();

// Fisher–Yates 局部洗牌：每帧要挑 30~80 个"互不重复"的指标 id。
// 复用同一张索引表，只洗前 n 位即可，避免每帧分配 300 长度数组。
const indexPool = Array.from({ length: METRIC_COUNT }, (_, i) => i);
function pickChangedIndices(n: number): number[] {
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (METRIC_COUNT - i));
    const tmp = indexPool[i];
    indexPool[i] = indexPool[j];
    indexPool[j] = tmp;
  }
  return indexPool.slice(0, n);
}

// 随机游走：以初始 compute 值为锚做均值回归，防止长期单边漂移到 0 或爆炸。
function walkOnce(current: number[], initial: number[], ts: number): MetricsFrame {
  const count =
    FRAME_MIN_CHANGED +
    Math.floor(Math.random() * (FRAME_MAX_CHANGED - FRAME_MIN_CHANGED + 1));
  const frameValues: Record<string, number> = {};
  for (const idx of pickChangedIndices(count)) {
    const anchor = initial[idx];
    // 30% 拉回锚点 + 小幅噪声；噪声尺度按锚点绝对值缩放（锚点为 0 时退化为 ±0.02）
    const noise = (Math.random() - 0.5) * 0.04 * (Math.abs(anchor) || 1);
    const next = anchor + (current[idx] - anchor) * 0.7 + noise;
    current[idx] = next;
    frameValues[METRICS[idx].id] = Number(next.toFixed(4));
  }
  return { ts, values: frameValues };
}

function ensureStarted() {
  if (!values) values = [...getInitialValues()];
  if (timer) return;
  timer = setInterval(() => {
    if (subscribers.size === 0 || !values) return;
    lastTs = Date.now();
    const frame = walkOnce(values, getInitialValues(), lastTs);
    // 拷贝一份订阅者集合：回调内可能立即 unsubscribe（连接断开），
    // 直接遍历 Set 边删边发依赖实现细节，显式快照更稳。
    for (const push of [...subscribers]) push(frame);
  }, FRAME_INTERVAL_MS);
  // 测试/脚本场景父进程退出时不被空转定时器拖住
  timer.unref?.();
}

function stopIfIdle() {
  if (refCount === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function buildSnapshot(): MetricsSnapshot {
  if (!values) values = [...getInitialValues()];
  const all: Record<string, number> = {};
  for (let i = 0; i < METRIC_COUNT; i++) all[METRICS[i].id] = values[i];
  return { ts: lastTs || Date.now(), values: all };
}

const sseHeaders: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // 禁止任何代理/缓冲层攒批；SSE 需要逐帧直达客户端
  "X-Accel-Buffering": "no",
};

function encodeSSE(frame: MetricsFrame): Uint8Array {
  return new TextEncoder().encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
}

export function GET(request: Request): Response {
  const url = new URL(request.url);

  // ---- 全量快照分支：普通 JSON，一次请求即结束 ----
  if (url.searchParams.get("snapshot") === "1") {
    return Response.json(buildSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // ---- SSE 分支 ----
  const encoder = new TextEncoder();
  // 让 cancel() 能调到 start() 里创建的幂等清理函数
  const cleanupRef: { current: null | (() => void) } = { current: null };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ensureStarted();
      refCount++;

      // 接入即发一条注释行（retry 提示 + 初始字节）：
      // 让 curl/客户端立刻看到响应头与流存活；retry 只是给 EventSource 的建议，
      // 客户端另有显式重连逻辑兜底。
      try {
        controller.enqueue(encoder.encode(`: connected\nretry: 1000\n\n`));
      } catch {
        // controller 可能在 enqueue 前就已关闭，交给 cancel 路径处理
      }

      let cleaned = false;
      // 唯一清理入口：客户端断开时 abort 与 stream cancel 可能先后都触发，
      // 必须幂等（cleaned 守卫 + Set.delete 结果双重保险），否则引用计数
      // 会被扣成负数，导致"有订阅者却停了定时器"或计数永远归零不了。
      const teardown = () => {
        if (cleaned) return;
        cleaned = true;
        subscribers.delete(push);
        refCount--;
        stopIfIdle();
        try {
          controller.close();
        } catch {
          // 重复 close 忽略
        }
      };

      const push = (frame: MetricsFrame) => {
        try {
          controller.enqueue(encodeSSE(frame));
        } catch {
          // 下游已关闭：取消订阅即可，不能让一个坏连接炸掉整轮 tick
          teardown();
        }
      };
      subscribers.add(push);

      request.signal.addEventListener("abort", teardown, { once: true });
      cleanupRef.current = teardown;
    },
    cancel() {
      // 客户端主动断开（EventSource.close / 浏览器销毁请求）。
      // 与 abort 走同一个幂等清理，不在这里重复扣计数。
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
  });

  return new Response(stream, { headers: sseHeaders });
}
```

### 5.4 `verify.mjs`（新增，仅 node 原生模块）
```js
// SSE 自检脚本：仅使用 Node 原生模块（http/URL），无任何外部依赖。
//
// 用法：
//   node verify.mjs                # 默认 http://localhost:3000
//   node verify.mjs http://host:3001
//   DURATION_MS=10000 node verify.mjs
//
// 行为：连接 /api/metrics 的 SSE，收集 DURATION_MS（默认 10s）内的全部
// event: frame，打印：帧数、每帧 values 数量分布（直方图 + min/max/avg）、
// 帧间隔分布，以及首帧示例。连接前会先 GET 一次 ?snapshot=1 校验全量快照
// （应含 300 个值）。
import http from "node:http";

const BASE = process.argv[2]?.replace(/\/$/, "") || "http://localhost:3000";
const DURATION_MS = Number(process.env.DURATION_MS || 10000);
const EXPECTED_METRICS = 300;

function get(path, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${path}`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${path} -> HTTP ${res.statusCode}`));
        return;
      }
      if (json) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body)));
      } else {
        resolve(res);
      }
    });
    req.on("error", reject);
  });
}

// 极简 SSE 分帧解析器：按空行分隔事件，收集 data: 行
function parseSSEChunks(stream, onFrame) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = rawEvent
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length === 0) continue; // 注释行/重试行，忽略
      try {
        onFrame(JSON.parse(dataLines.join("\n")));
      } catch {
        // 服务端不应发出坏 JSON；遇到则丢弃并统计交给上层
      }
    }
  });
}

const histogram = new Map();
const gapHistogram = new Map();
let frames = 0;
let totalValues = 0;
let minValues = Infinity;
let maxValues = 0;
let firstFrame = null;
let lastTs = null;

const started = Date.now();
console.log(`[verify] GET ${BASE}/api/metrics?snapshot=1 (全量快照)`);
const snap = await get("/api/metrics?snapshot=1", { json: true });
const snapCount = Object.keys(snap.values).length;
console.log(
  `[verify] 快照 ts=${snap.ts} values=${snapCount}（期望 ${EXPECTED_METRICS}）`
);
if (snapCount !== EXPECTED_METRICS) {
  console.error("[verify] 快照值数量不符，终止");
  process.exit(1);
}

console.log(`[verify] 连接 SSE /api/metrics，采集 ${DURATION_MS}ms …`);
const stream = await get("/api/metrics");
parseSSEChunks(stream, (frame) => {
  if (!frame || typeof frame.ts !== "number" || !frame.values) return;
  frames++;
  const n = Object.keys(frame.values).length;
  totalValues += n;
  minValues = Math.min(minValues, n);
  maxValues = Math.max(maxValues, n);
  histogram.set(n, (histogram.get(n) || 0) + 1);
  if (lastTs !== null) {
    const gap = frame.ts - lastTs;
    gapHistogram.set(gap, (gapHistogram.get(gap) || 0) + 1);
  }
  lastTs = frame.ts;
  if (!firstFrame) firstFrame = frame;
});

await new Promise((r) => setTimeout(r, DURATION_MS));
stream.destroy();

const elapsed = Date.now() - started;
console.log("");
console.log("========== SSE 采集结果 ==========");
console.log(`采集窗口         : ${DURATION_MS}ms（实际 ${elapsed}ms）`);
console.log(`收到帧数         : ${frames}`);
if (frames === 0) {
  console.error("[verify] 未收到任何帧，判定失败");
  process.exit(1);
}
console.log(
  `每帧 values 数量 : min=${minValues} max=${maxValues} avg=${(
    totalValues / frames
  ).toFixed(1)}（期望区间 30~80）`
);
console.log("values 数量直方图（数量 => 帧数）:");
for (const n of [...histogram.keys()].sort((a, b) => a - b)) {
  console.log(`  ${String(n).padStart(3)} => ${histogram.get(n)}`);
}
console.log("帧间隔(ms)直方图（间隔 => 次数，期望集中在 1000）:");
for (const g of [...gapHistogram.keys()].sort((a, b) => a - b)) {
  console.log(`  ${String(g).padStart(5)} => ${gapHistogram.get(g)}`);
}
const sampleEntries = Object.entries(firstFrame.values).slice(0, 5);
console.log(
  `首帧示例         : ts=${firstFrame.ts} values 前 5 项 =`,
  Object.fromEntries(sampleEntries)
);

const inRange = minValues >= 30 && maxValues <= 80;
console.log("");
console.log(
  inRange
    ? "[verify] PASS：帧在推流，且每帧变化数落在 30~80 区间"
    : "[verify] WARN：存在帧的 values 数量超出 30~80"
);
process.exit(inRange ? 0 : 2);
```
