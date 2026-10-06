# /perf 修复交付报告（第二轮）

修复对象：`lib/metrics.ts`、`app/perf/dashboard.tsx`、`app/perf/page.tsx`、`app/globals.css`（仅这四个文件）。
未新增依赖；`samples.json` 与 `scripts/gen-samples.mjs` 未改动；300 行列表、行内图表、pick 计数、输入框、滚动动画全部保留。

**实测环境**：Next 16.3.6 + React 19.2.8 + chart.js 4.5.1，headless Chromium（playwright chromium_headless_shell-1243），CDP 埋点口径与上轮完全一致（`onCommitFiberRoot` 计 commits、`getContext('2d')` 计 new Chart、包装 `setInterval/clearInterval`、包装 scroll `add/removeEventListener`、`th-*` getItem 计数、`PerformanceObserver` longtask）。prod=`next start`（:3120），dev=`next dev`（localhost:3110）。
注：上轮端口 3010/3020 被上一会话残留的服务进程占用（且 3020 服务的是另一份代码），本轮全部改用 3120/3110 自有实例；另发现 Next 16 dev 对 `127.0.0.1` 源有 `allowedDevOrigins` 限制会拒绝水合，dev 一律用 `localhost` 访问。

---

## 一、修复前后 60s 实测对照表

前台可见、不滚动、从 navigate 起算 60s，prod 构建（`next build` + `next start`）：

| 指标 | 修复前 prod | 修复后 prod | 预算 | 判定 |
|---|---|---|---|---|
| React commits | 111 | **4** | ≤12 | ✅ |
| compute 调用（客户端） | 774,600（=thGet） | **0**（thGet 3,600 为阈值读取） | ≤4,000 | ✅ |
| new Chart（ctx2d） | 300 | **300** | ≤300 | ✅ |
| Chart 重绑抛错 | 32,100 | **0** | =0 | ✅ |
| 存活 interval（60s 末） | 108（clearInterval=0） | **1**（唯一阈值同步器） | 卸载后=0 | ✅ |
| scroll 监听净存活 | 1（add 100/remove 99） | **1**（add 1/remove 0） | 卸载后=0 | ✅ |
| 单次最长主线程任务 | 1,088ms（另 316/275/53/54ms） | **无 ≥50ms 长任务**（longtasks=[]） | <50ms | ✅ |
| Intl.NumberFormat 构造 | 32,404 | **4** | — | ✅ |
| hydration 报错 | React #418（复现见 §五） | **0** | 零报错 | ✅ |
| chart.js chunk（首屏 JS） | 496,886 raw / 163,017 gzip | **125,861 raw / 44,777 gzip** | gzip ≤60KB | ✅ |
| SSR 输出行数 | 300 行 / 300 canvas | **300 行 / 300 canvas** | =300 | ✅ |

dev 模式对照（同窗口，供参考，不作验收）：

| 指标 | 修复前 dev | 修复后 dev | dev/prod 差异成因 |
|---|---|---|---|
| commits | 105 | 10 | StrictMode 双挂载：mount→cleanup→mount，effect 各跑两次，水合+挂载同步产生约 2× 提交 |
| thGet | 730,800 | 3,900 | 修复后 dev 挂载同步跑 2 次（600）+ 11 个周期×300=3,900；prod 为 300+11×300=3,600 |
| interval 创建/存活 | 98/98 | 2/**1** | StrictMode 下第一个 interval 被 cleanup（clearInterval 生效），存活恒 1 |
| new Chart | 300 | 300 | 帧切片调度的首次创建在 cleanup 时被 cancelled 标记跳过，实际创建仍 300 |
| 长任务 | 98 个（max 713ms） | 1 个 52ms | dev 未压缩 React+源码映射开销；prod 为 0 |

StrictMode 双渲染说明：dev 下 React 19 StrictMode 对每个组件执行 render×2、effect setup→cleanup→setup。本方案所有 effect 均幂等且有对称 cleanup，因此双挂载不产生额外存活资源（interval/监听/图表全部成对回收），仅计数器上体现为 ivBorn=2、scrollAdd=2、thGet 多 300。

## 二、交互正确性实测（prod 构建，探针版与交付代码仅差只读探针）

| 验收项 | 实测结果 | 判定 |
|---|---|---|
| hydration | `hydrErrs=0`，DOM 300 行，图表 300 个；SSR 与 CSR 的 value/ts 文本同源（服务端 props 下发），构造上一致 | ✅ |
| pick 当次渲染更新 | 点击后 0ms（同一事件循环微任务内）文本 `· 0`→`· 1`，连点 3 次→`· 3`，commitsDelta=2（修复前同任务内 commitsDelta=0，要等下个 interval 被动刷新） | ✅ |
| 排序后图表跟随 | `localStorage['th-7']=1000` → 5s 同步周期内 `metric_7` 升至首位；逐行比对 300/300 个 canvas：`chart.data.datasets[0].data[0]` 格式化后与行显示值全部一致（mismatch=0）；`new Chart` 总数=300、重绑抛错=0 | ✅ |
| 过滤不触发全量 compute | 输入 `metric_31` → 列表实时变为 1 行，computeDelta=0、thGetDelta=0；清空恢复 300 行 | ✅ |
| 卸载清理 | SPA 导航离开 /perf 后：存活 interval=0、scroll 监听=0、300/300 个 Chart 实例已 destroy | ✅ |

## 三、定时器架构重新设计（验收点 4）

**旧架构**：60ms ticker `setTick` 无限自增 → 无依赖数组的 `useEffect` 每次提交后新建 `setInterval(1000/(tick+1))` 且不清理。tick→∞ 时延迟→0，被浏览器嵌套定时器 4ms 下限钳制；interval 随渲染线性堆积（实测 60s 存活 108 个），每个回调再触发 300 次 compute（单批 61ms），形成正反馈。

**新架构**（`app/perf/dashboard.tsx` 阈值同步 effect）：

- **单个固定 5000ms `setInterval`**，挂载时创建、卸载时 `clearInterval`（对称 cleanup），另监听 `storage` 事件处理跨标签页阈值变更。interval 数量恒为 1，与渲染次数解耦——这是堆积的根因修复（旧代码 interval 数≈渲染数）。
- **4ms 下限规避**：延迟是常量 5s，不派生自任何自增状态，数量级远离嵌套定时器钳制区间（HTML 标准对 1000ms 内嵌套超 5 层的定时器才施加 4ms 下限）；不存在"延迟趋于 0"的数学结构。
- **后台节流正确性**：回调幂等——读 300 个 `th-i` 阈值，与当前值逐一比较，无变化则不 `setState`（稳态零提交）。阈值的真源是 localStorage 而非定时器触发次数，因此后台标签页把定时器钳到 ≥1s（5 分钟后嵌套链 1/min）只会推迟同步、不会丢失或重复状态；浏览器对 interval 只保留一个 pending 回调，恢复前台后下一次触发即按最新 localStorage 全量对齐，无追赶风暴、无队列堆积。

## 四、逐条风险对照（修改 ↔ 上轮报告 22 条）

| 报告条目 | 修复位置 | 根因机制与修法 |
|---|---|---|
| 无依赖 useEffect 建 interval 不清理 | dashboard.tsx 阈值同步 effect | 每次提交重跑 effect 且永不 clearInterval → 单 interval + cleanup，见 §三 |
| `1000/(tick+1)` 延迟→0 | 同上 | tick 自增正反馈 → 固定 5s，删除 tick state |
| 非惰性 useState 初值每次渲染求值 | page.tsx + dashboard.tsx | `useState(expr)` 的 expr 每次渲染都求值并被丢弃 → 300 个 compute 移到服务端（page.tsx），结果经 RSC props 下发，客户端 0 次 compute |
| useMemo dep=[rows,filter] 必失效 + JSON 深拷贝 | dashboard.tsx `visible` | rows 每次新引用 → dep 改 `[rows,query]`，浅拷贝 `[...filtered].sort`，稳态 rows 不变 memo 不再失效 |
| setRows 全量替换 | dashboard.tsx `sync` | 每回调重建 300 对象 → 先比对、仅阈值变化才 setRows；数据静态时稳态零更新 |
| key={i}+排序 | dashboard.tsx | 位置 key 导致复用错位 → `key={row.id}`，排序时 DOM 节点随数据移动 |
| bindChart 内联 ref 回调 | Row useEffect | ref 回调每次渲染换新引用→旧 Chart 不销毁→重绑撞 "already in use" → 挂载 effect 内创建一次、cleanup `chart.destroy()`；创建按帧切片（每帧 10ms 预算）消除 295ms 单次长任务 |
| catch 空吞异常 | Row | 重绑抛错被吞 → 不存在重绑路径，try/catch 删除 |
| Intl.NumberFormat 每次渲染新建 | 模块级 `FMT` 单例 | 实测 32,404→4 次/60s |
| `void document.body.offsetHeight` 强制回流 | scroll effect | scroll 回调读布局属性→强制同步布局 → 只读 `window.scrollY`（非布局属性），越界才写 `body.scrolled` class |
| 第三 effect dep=[sorted] 每次重跑 | title effect | sorted 每次新引用 → dep 改 `[visible.length]`，仅行数变化时写 title（去掉无意义的 `Math.random()` 后缀） |
| 300 元素 pulse 动画 | globals.css `.row` | 保留功能：内联 style 移入 class；opacity 动画不触发布局，实测修复后 60s 零长任务 |
| `chart.js/auto` 无法 tree-shake | dashboard.tsx 头部 | auto 入口副作用式全量注册 → 命名导入仅注册 LineController/LineElement/PointElement/LinearScale/CategoryScale，chunk 163,017→44,777 gzip |
| `export dynamic`（误判条目） | dashboard.tsx | 上轮已证实客户端组件内 Route Segment Config 无效 → 删除死代码；/perf 仍 ƒ（见 §六路由表） |
| scroll 监听"泄漏"（误判条目） | — | 复测确认上轮结论：旧代码 cleanup 成对执行净存活恒 1，非泄漏；新实现 add/remove 同样对称 |
| Chart 34,500 实例（误判条目） | — | 复测确认：34,200 次在构造前置校验 throw，未生成实例；新实现零重绑 |
| `typeof localStorage` 兜底 | metrics.ts | 掩盖"渲染期依赖浏览器存储" → compute 纯化（不碰 localStorage），阈值读取移至客户端 effect，SSR/CSR 首帧同用 th=1 |
| `ts: Date.now()` 水合不一致 | page.tsx + `fmtTs` | SSR 与客户端取值时刻不同 → ts 由服务端统一盖章随 props 下发；格式化改 `toISOString`（UTC），消除 toLocaleString 的时区漂移，两端文本构造性一致 |
| 模块级 cache + pick 不触发渲染 | dashboard.tsx `picks` state | 只改模块变量不 setState → `useState`+`useCallback`（函数式更新，引用稳定），Row 用 `memo` 避免全表重渲染 |
| `<input defaultValue>` 死过滤 | dashboard.tsx | 非受控且无过滤逻辑 → 受控 input + `visible` memo 真实过滤（匹配 name/id 子串），过滤不触发 compute（实测 computeDelta=0） |
| compute 闭包内读 localStorage | metrics.ts | 每指标每批 1 次同步 Storage 读（实测 774,600 次/60s）→ compute 纯化，客户端 compute 调用降为 0 |
| `await searchParams`（语义条目） | page.tsx | 保留——这是 /perf 为 ƒ Dynamic 的真实原因，语义不变 |

## 五、对上轮报告的修正（含实测证据）

1. **#519 → 实为 #418，且触发有条件**。上轮称"prod 抛 React #519 HydrationMismatchException"。本轮实测：React 19.2.8 prod 对文本失配抛的是 **Minified React error #418**（"Hydration failed because the initial UI does not match..."，经 `window.onerror` 捕获），且仅当 SSR 时刻与水合时刻跨 1 秒边界（`toLocaleString` 秒位不同）才触发；本地同秒完成时静默。证据：客户端冻结 `Date.now()=1111111111111` 后加载，首个 commit 行文本变为 `3/18/2005, 9:58:31 AM`（客户端值覆盖 SSR 文本），同时捕获 `winerr: Minified React error #418`。React 19 对文本失配走 recoverable 路径，Next 的 `onRecoverableError` 不在控制台输出，故常规观察不可见。结论（存在水合 bug）不变，错误码与触发条件以上述实测为准。修复后 ts 来自服务端 props，失配在构造上消除，实测 `hydrErrs=0`。
2. 上轮两条"非问题误判"（scroll 监听净存活恒 1、34,200 次 Chart 构造未真实例化）本轮复测确认无误判，未按"泄漏"过度修复。

## 六、next build 路由表（最终构建实测粘贴）

```
Route (app)
┌ ○ /
├ ○ /_not-found
└ ƒ /perf

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

/perf 保持 ƒ Dynamic（真因：`page.tsx` await 动态 API `searchParams`）。SSR 实测：`/perf` 输出 300 行/300 canvas；`/perf?q=metric_31` 输出 1 行（过滤在服务端同样生效）。

## 七、自检：最可能翻车的 2 个边界场景

1. **10 万条采样数据**：compute 全部移到服务端后，单请求 SSR 计算 300×10⁵ 次 log/sin，按 20k 点实测 61ms 线性外推约 **305ms/请求**，高并发下 Node 单线程 CPU 排队、热请求延迟恶化（客户端不受影响，compute=0）。本轮未做服务端缓存（`initialRows` 对静态 samples.json 其实可缓存），若数据量上调应优先加缓存或流式分段计算。
2. **6 倍 CPU 节流**：300 个 `new Chart` 按帧切片（每帧墙钟预算 10ms），6× 节流下每帧实际只能完成约 1/6 工作量，全部创建完约需 2.7s（60fps 下 ~160 帧），期间图表渐次出现但单帧任务仍 <50ms（预算按墙钟控制，与 CPU 减速无关）。次生风险：后台标签页 rAF 完全暂停，图表创建会挂起至回前台——后台不可见时无渲染需求，可接受；阈值同步 interval 被节流同理，语义由幂等回调保证（§三）。

## 八、四个文件的完整 diff

（与故障原件 `/tmp/p14-orig/` 对比；原件即 `/mnt/g/gsb/project14/main` 对应文件的逐字节副本）

### lib/metrics.ts
--- /tmp/p14-orig/metrics.ts	2026-10-03 23:24:54.488000762 +0800
+++ lib/metrics.ts	2026-10-04 02:53:15.564717517 +0800
@@ -1,16 +1,17 @@
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
+export const RAW = payload.data;
+
+// compute 保持纯函数：不触碰 localStorage / Date 等环境状态，
+// 因此服务端与客户端对同一 data 必然得到同一结果（水合一致）。
+// localStorage 阈值系数在客户端由 dashboard 单独读取并相乘（见 dashboard.tsx）。
+export const METRICS = Array.from({ length: 300 }, (_, i) => ({
+  id: `m${i}`,
+  name: `metric_${i}`,
+  compute: (data: { v: number }[]) => {
+    let s = 0;
+    for (const p of data) s += Math.log(p.v + 1) * Math.sin(i / 97);
+    return s / (data.length || 1);
+  },
+}));

### app/perf/page.tsx
--- /tmp/p14-orig/page.tsx	2026-10-03 23:24:54.488032476 +0800
+++ app/perf/page.tsx	2026-10-04 02:53:29.529918244 +0800
@@ -1,16 +1,30 @@
-import Dashboard from "./dashboard";
-
-export default async function PerfPage({
-  searchParams,
-}: {
-  searchParams: Promise<{ q?: string | string[] }>;
-}) {
-  const params = await searchParams;
-  const filter = typeof params.q === "string" ? params.q : "";
-  return (
-    <main>
-      <h1>Metrics Dashboard</h1>
-      <Dashboard filter={filter} />
-    </main>
-  );
-}
+import Dashboard, { type PerfRow } from "./dashboard";
+import { METRICS, RAW } from "@/lib/metrics";
+
+export default async function PerfPage({
+  searchParams,
+}: {
+  searchParams: Promise<{ q?: string | string[] }>;
+}) {
+  // await 动态 API（searchParams 为 Promise），本页保持请求期动态渲染（ƒ Dynamic）
+  const params = await searchParams;
+  const filter = typeof params.q === "string" ? params.q : "";
+
+  // 300 个指标的重计算在服务端执行一次，结果随 RSC payload 下发：
+  // 1) 客户端首屏/hydration 不再重复计算（消除 61ms 级主线程长任务）；
+  // 2) SSR 与 CSR 使用同一份 value/ts，水合文本必然一致。
+  const ts = Date.now();
+  const initialRows: PerfRow[] = METRICS.map((m) => ({
+    id: m.id,
+    name: m.name,
+    base: m.compute(RAW),
+    ts,
+  }));
+
+  return (
+    <main>
+      <h1>Metrics Dashboard</h1>
+      <Dashboard filter={filter} initialRows={initialRows} />
+    </main>
+  );
+}

### app/perf/dashboard.tsx
--- /tmp/p14-orig/dashboard.tsx	2026-10-03 23:24:54.488020028 +0800
+++ app/perf/dashboard.tsx	2026-10-04 03:12:06.611849293 +0800
@@ -1,91 +1,208 @@
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
+
+// 只注册本页用到的折线图组件，其余控制器/插件可 tree-shake（替代 chart.js/auto 全量注册）
+Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale);
+
+export type PerfRow = { id: string; name: string; base: number; ts: number };
+
+type RowState = PerfRow & { th: number };
+
+// 阈值同步周期：固定 5s。远离浏览器 4ms 嵌套定时器下限；
+// 回调幂等（读 300 个阈值、无变化不 setState），后台节流只会推迟同步，不会堆积。
+const TH_SYNC_MS = 5000;
+
+const FMT = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
+
+// localStorage 阈值系数语义保留：键仍为 th-<i>（i 为指标序号，id 为 m<i>）
+function readThreshold(id: string): number {
+  const raw = localStorage.getItem(`th-${id.slice(1)}`);
+  return raw ? Number(raw) : 1;
+}
+
+// 图表创建调度器：300 个 new Chart 若在同一 passive-effect 阶段同步执行会形成
+// 约 300ms 的单次长任务。这里按帧切片（每帧预算 10ms），把创建摊到多个帧上。
+const chartWorkQueue: Array<() => void> = [];
+let chartPumpScheduled = false;
+function pumpChartWork() {
+  const start = performance.now();
+  while (chartWorkQueue.length > 0 && performance.now() - start < 10) {
+    chartWorkQueue.shift()!();
+  }
+  if (chartWorkQueue.length > 0) {
+    requestAnimationFrame(pumpChartWork);
+  } else {
+    chartPumpScheduled = false;
+  }
+}
+function scheduleChartWork(fn: () => void) {
+  chartWorkQueue.push(fn);
+  if (!chartPumpScheduled) {
+    chartPumpScheduled = true;
+    requestAnimationFrame(pumpChartWork);
+  }
+}
+
+// 时区无关的确定性格式：SSR 与 CSR 对同一 ts 输出同一文本（toLocaleString 随时区漂移）
+function fmtTs(ts: number): string {
+  return `${new Date(ts).toISOString().slice(0, 19).replace("T", " ")} UTC`;
+}
+
+export default function Dashboard({
+  filter,
+  initialRows,
+}: {
+  filter: string;
+  initialRows: PerfRow[];
+}) {
+  // 初值 th=1：SSR 与 CSR 首帧口径一致；真实阈值挂载后由 sync 应用
+  const [rows, setRows] = useState<RowState[]>(() =>
+    initialRows.map((r) => ({ ...r, th: 1 }))
+  );
+  const [query, setQuery] = useState(filter);
+  const [picks, setPicks] = useState<Record<string, number>>({});
+
+  // 阈值同步：挂载时一次 + 固定周期 + 跨标签页 storage 事件。
+  // 先读完全部阈值、确认有变化才 setRows，稳态下零提交。
+  useEffect(() => {
+    let current = rows.map((r) => r.th);
+    const sync = () => {
+      let changed = false;
+      const next = current.map((th, i) => {
+        const thNow = readThreshold(rows[i].id);
+        if (thNow !== th) changed = true;
+        return thNow;
+      });
+      if (!changed) return;
+      current = next;
+      const now = Date.now();
+      setRows((prev) => prev.map((r, i) => ({ ...r, th: next[i], ts: now })));
+    };
+    sync();
+    const id = setInterval(sync, TH_SYNC_MS);
+    window.addEventListener("storage", sync);
+    return () => {
+      clearInterval(id);
+      window.removeEventListener("storage", sync);
+    };
+    // rows 仅由本 effect 更新 th，initialRows 在会话内不变
+    // eslint-disable-next-line react-hooks/exhaustive-deps
+  }, []);
+
+  // 过滤（接通输入框）+ 排序：只依赖 rows/query，不触发任何 compute
+  const visible = useMemo(() => {
+    const q = query.trim().toLowerCase();
+    const filtered = q
+      ? rows.filter(
+          (r) =>
+            r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)
+        )
+      : rows;
+    return [...filtered].sort((a, b) => b.base * b.th - a.base * a.th);
+  }, [rows, query]);
+
+  useEffect(() => {
+    document.title = `监控 ${visible.length}`;
+  }, [visible.length]);
+
+  // 滚动视觉反馈：只读 scrollY（非布局属性，不触发强制回流），越过边界才写 class
+  useEffect(() => {
+    let scrolled = false;
+    const onScroll = () => {
+      const next = window.scrollY > 0;
+      if (next !== scrolled) {
+        scrolled = next;
+        document.body.classList.toggle("scrolled", next);
+      }
+    };
+    window.addEventListener("scroll", onScroll, { passive: true });
+    return () => {
+      window.removeEventListener("scroll", onScroll);
+      document.body.classList.remove("scrolled");
+    };
+  }, []);
+
+  const onPick = useCallback((id: string) => {
+    setPicks((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
+  }, []);
+
+  return (
+    <div>
+      <input
+        value={query}
+        onChange={(e) => setQuery(e.target.value)}
+        placeholder="filter"
+      />
+      {visible.map((r) => (
+        <Row key={r.id} row={r} picked={picks[r.id]} onPick={onPick} />
+      ))}
+    </div>
+  );
+}
+
+type RowProps = {
+  row: RowState;
+  picked?: number;
+  onPick: (id: string) => void;
+};
+
+const Row = memo(function Row({ row, picked, onPick }: RowProps) {
+  const canvasRef = useRef<HTMLCanvasElement | null>(null);
+  const chartRef = useRef<Chart<"line"> | null>(null);
+  const value = row.base * row.th;
+  const valueRef = useRef(value);
+  valueRef.current = value;
+
+  // 每个 canvas 生命周期内只 new 一次 Chart（按帧切片调度），卸载时 destroy
+  useEffect(() => {
+    const el = canvasRef.current;
+    if (!el) return;
+    let cancelled = false;
+    scheduleChartWork(() => {
+      if (cancelled) return;
+      const chart = new Chart(el, {
+        type: "line",
+        data: { labels: [row.id], datasets: [{ data: [valueRef.current] }] },
+        options: {
+          animation: false,
+          responsive: false,
+          events: [],
+          scales: { x: { display: false }, y: { display: false } },
+        },
+      });
+      chartRef.current = chart;
+    });
+    return () => {
+      cancelled = true;
+      chartRef.current?.destroy();
+      chartRef.current = null;
+    };
+    // 仅挂载/卸载时执行；数据变化由下方 effect 处理
+    // eslint-disable-next-line react-hooks/exhaustive-deps
+  }, []);
+
+  // 数值变化时原地更新图表数据（不重建实例）
+  useEffect(() => {
+    const chart = chartRef.current;
+    if (!chart) return;
+    chart.data.datasets[0].data = [value];
+    chart.update("none");
+  }, [value]);
+
+  return (
+    <div className="row">
+      {FMT.format(value)} · {fmtTs(row.ts)} · {picked ?? 0}
+      <button onClick={() => onPick(row.id)}>pick</button>
+      <canvas ref={canvasRef} width={80} height={24} />
+    </div>
+  );
+});

### app/globals.css
--- /tmp/p14-orig/globals.css	2026-10-03 23:24:54.488045319 +0800
+++ app/globals.css	2026-10-04 02:54:52.863974413 +0800
@@ -55,6 +55,13 @@
   padding: 4px 8px;
   border-bottom: 1px solid rgba(127, 127, 127, 0.2);
   font-variant-numeric: tabular-nums;
+  /* 行脉冲动画（原内联 style，移入 class；opacity 动画不触发布局） */
+  animation: pulse 1s infinite;
+}
+
+/* 滚动视觉反馈：由 dashboard 的 scroll 监听在越过顶部时切换 */
+body.scrolled {
+  box-shadow: inset 0 2px 0 0 rgba(127, 127, 127, 0.45);
 }
 
 @keyframes pulse {
