# /perf 实时面板改造交付报告（第三轮）

修改/新增文件（仅本轮允许范围）：

- `lib/metrics.ts`（修改）：抽出共享类型、`METRIC_INDEX`、`INITIAL_BASES`、`buildInitialSnapshot`、帧常量。
- `app/api/metrics/route.ts`（新增）：SSE 推流 + 全量快照，同一 Route Handler，仅用 Web 标准 `ReadableStream`/`setInterval`，零新依赖。
- `app/perf/dashboard.tsx`（修改）：可变 store、按行订阅、增量更新、SSE 重连对齐、过滤不卸载、Chart 令牌式按帧创建与原地更新。
- `app/perf/page.tsx`（修改）：SSR 初值改为与推流端同源；新增一个到首页的 `next/link`（供 SPA 卸载验证）。
- `app/globals.css`：无需改动（既有样式与滚动/pulse 语义沿用），本轮实际未改。
- `verify.mjs`（新增，验收辅助）：仅用 Node 原生 `http`/`https` 连 SSE，打印 10s 帧数与每帧 values 数量分布。

未新增依赖；`samples.json`、`scripts/gen-samples.mjs`、`next.config.ts`、`tsconfig.json` 未改；
类型检查保持开启，无任何 `as any` 逃逸（仅测试脚本外）。

实测环境：Next 16.3.6（Turbopack）+ React 19.2.8 + chart.js 4.5.1 + Node 24，
headless Chromium（Playwright 自带 chrome-headless-shell 153，经 CDP 驱动）。

---

## 一、总体架构

数据真源分两层，且 SSR/推流/客户端三者同源：

```
samples.json
   └─(compute, 服务端)─► INITIAL_BASES (lib/metrics.ts)
                              │
        ┌─────────────────────┼────────────────────────┐
        ▼                     ▼                        ▼
 page.tsx (SSR)      route.ts 模块状态 bases       dashboard MetricsStore
 buildInitialSnapshot  随机游走，seq 单调            300 个恒定引用的 MetricEntry
 → initialRows 下发     GET /api/metrics 增量帧      订阅 SSE/快照，原地改 base/th
                       GET ?snapshot=1 全量快照
```

- **同源**：`page.tsx` 的 300 个初值与推流端 `bases` 初值都来自 `INITIAL_BASES`，
  因此首屏（SSR）显示的就是推流世界 `seq=0` 的同一组值，首帧 SSE 前无跳变。
- **可变真源**：`MetricsStore` 持有 300 个 `MetricEntry`，对象引用在整个挂载生命周期内恒定；
  `base/th/ts/version` 原地修改。这是"不全量重建 300 行结构"的基础。

---

## 二、SSE 数据源（app/api/metrics/route.ts）

- 同一路由两种用法：
  - `GET /api/metrics`：`text/event-stream`，每 `TICK_MS`（默认 1000）一帧，
    帧 `{seq, ts, values}`，`values` 只含本帧 30~80 个**不同**的变化指标（随机不重复抽样 + 小幅随机游走）。
  - `GET /api/metrics?snapshot=1`：`application/json`，一次性全量 300 项，供首连/重连对齐。
- 推流状态（`bases/seq`）是**模块级单例**：所有连接共享同一条随机游走序列，
  这样"重连后快照"与"断线期间错过的增量"处在**同一个 seq 坐标系**，客户端按 seq 去重即可严格对齐。
- ticker 按订阅者引用计数懒启动/停止，无连接时零 CPU；写入失败（对端关闭）即退订。
- `request.signal` 监听 `abort`，客户端断开时 `controller.close()` 并清理订阅与心跳。
- 首包发注释行 `: connected` 立即冲刷；另有 15s `: ping` 心跳兜底防代理静默掐流。
- `export const dynamic = "force-dynamic"`：该路由依赖运行时随机状态，禁止预渲染。
- `METRICS_TICK_MS` 环境变量仅用于自检 b 的 100ms 压测（默认 1000，不设置即契约值）。

---

## 三、客户端增量更新（dashboard.tsx）

### 1. 只更新受影响行，不全量重建 / 不全量 compute

- 300 个 `MetricEntry` 引用恒定；一帧到达时只对 `values` 中 30~80 个 id 调 `setBase`，
  原地改 `base/ts` 并 `version+1`，收集到 `changed: Set<number>`。
- 每行用 `useSyncExternalStore(subscribeRow(i), getVersion(i))` 只订阅**本行版本**：
  只有被帧命中的 30~80 行收到通知而重渲染，其余 210+ 行 `memo` 命中、零渲染。
- 排序由父组件订阅一个单调递增的 `orderVersion`（每批只 bump 一次）：
  每帧父组件最多提交一次，重建的只是一个含 300 个数字的索引数组并排序，
  **不重建行数据结构，也不调用任何 compute**。
- `compute` 全在服务端；客户端稳态 compute 调用 = 0。

### 2. 图表跟随且不销毁重建（new Chart 总数恒为 300）

- 300 行**始终渲染**（与 SSR 一致，水合无差异），过滤只是给不匹配行加 `display:none`，
  从 DOM/Chart 生命周期里彻底移除了"过滤→卸载→重挂→new Chart"的路径。
- 排序通过 JSX 顺序变化（`key={id}`）让 React **移动现有 DOM 节点**，
  canvas 随其行移动，Chart 与 canvas 的绑定不变。
- 每个 Row 生命周期内只 `new Chart` 一次；值变化时原地
  `chart.data.datasets[0].data = pts`（保留最近 40 点的滑动窗口）+ `chart.update("none")`，
  不触碰构造函数。
- 图表创建用**令牌(token)+全局队列**按帧切片（每帧 10ms 预算）：
  - Row 挂载时生成 `token` 并入队创建任务；cleanup（含 dev StrictMode 首挂）令 token 失效，
    已入队未执行的任务出队即空操作，绝不会给已销毁 canvas 建图；
  - 该模型不依赖 React 父子 effect 执行顺序（实测"子 effect 先于父 effect"），
    也不依赖易失的布尔锁；另挂 250ms `setTimeout` 作为后台标签页 rAF 暂停后回前台的兜底。
  - 任何过滤/排序/重连/阈值序列下 new Chart 总数 ≤ 300。

### 3. 断线重连 + 全量对齐，期间无 NaN/undefined

状态机（自行管理，不依赖浏览器内置重连，因为要在重连后强制插入全量对齐）：

1. `onopen`：重置退避计数并 `align()`——置 `aligning=true`，`fetch('/api/metrics?snapshot=1')`。
2. 对齐在途期间到达的增量帧进 `pendingFrames`（上限 30），**不写 UI**（UI 保持旧值，绝不会 undefined）。
3. 快照返回后：逐项 `setBase` 覆盖全部 300 项（含值回退），并**把本地 `seq` 直接采用快照 seq**。
4. 再按 seq 升序补发 `pendingFrames` 中 `seq > snap.seq` 的帧，然后恢复增量通道。
5. `onerror`：关闭旧 EventSource，指数退避（1s 起，上限 30s）重连；快照失败也走退避重连。

两个关键正确性点：

- **快照定义 epoch**：同一服务端重连 `snap.seq ≥ 本地 seq`；若 `snap.seq` 更小，
  说明推流端状态已重置（进程重启/换实例）。此时必须放弃本地 seq 坐标（直接采用 `snap.seq`），
  否则新纪元的小 seq 帧会被 `seq <= localSeq` 全部误判为旧帧而永久丢弃。实测专门覆盖了
  "杀掉服务端（seq 归零）再重启"的场景。
- 所有写入都经 `Number.isFinite` 校验；阈值损坏（NaN/0/负/Infinity）一律按 1 处理，
  因此任意时刻显示值都是有限数，不会出现 NaN/Infinity。

### 4. 卸载清理（需求 4）

`store.dispose()` 对称清理：关闭 EventSource（并摘掉三个 handler）、`clearTimeout` 重连定时器、
`clearInterval` 阈值定时器、`removeEventListener('storage')`、清空所有行/排序监听集合。
300 个 Chart 由各自 Row 的 effect cleanup `chart.destroy()`。实测经 SPA 导航（next/link）验证
真实 React 卸载后：EventSource 关闭、interval=0、scroll/storage 监听=0、300 canvas 全部移除。

### 5. 保留的既有语义

300 行、行内迷你折线、pick 计数（`useState`+函数式更新）、受控输入框过滤（name/id 子串）、
滚动 `scrolled` class 与 pulse 动画、localStorage 阈值系数（键仍为 `th-<i>`，挂载即同步 +
5s interval + 跨标签 `storage` 事件）、SSR 300 行、`/perf` 因 `await searchParams` 仍为 ƒ Dynamic。

---

## 四、边界自检 a/b/c（含实测）

### a. 后台标签页 5 分钟后切回

**浏览器侧帧行为**：后台标签页中 `requestAnimationFrame` 被暂停，
`setInterval` 被浏览器按"后台节流"逐级降级（Chrome 约 1 次/分钟，嵌套链更长时更稀疏）。
SSE 连接本身保持打开，服务端仍 1s 推一帧；EventSource 在后台仍会接收并派发 message，
但：

- 数据层 `applyFrame` 照跑（它不依赖 rAF），`base/seq` 持续被更新；
- React 的调度在后台会被推迟/合批，行文本与图表的重绘延后，但**不会丢失数据**——
  每帧都按 seq 落到 store，错过的渲染只是"中间态"，最终态由最新 entry 值决定；
- 图表的按帧创建 pump 在 rAF 暂停时挂起，但有 250ms setTimeout 兜底链；回前台后
  rAF 恢复，未完成的创建/更新立刻续跑。

**状态会不会错乱：不会**，原因：

1. seq 单调去重，后台期间无论渲染节流与否，store 里每个 entry 始终是"最后到达帧"的权威值，
   不存在中间态污染；
2. 阈值 interval 回调幂等（读 300 个 `th-i`、无变化不通知），被节流只推迟同步、不产生重复/堆积；
3. 回前台不需要任何"补算"——没有基于定时器计数的状态，渲染恢复后读到的就是最新 store。

**实测**：CDP `Page.setWebLifecycleState('frozen')` 冻结 15s 后恢复：
冻结期间与恢复后 NaN/undefined/Infinity 行 = 0，可见行 = 300，绑定图表 = 300，首行值随帧继续前进。
5 分钟只在程度上更极端（interval 更稀疏），结论不变。

### b. 推流端提到 100ms/帧

**哪里先扛不住**：不是数据处理（每帧只改 30~80 个 entry、按行订阅，O(变化数)），
而是**父组件的排序重渲染 + 300 行 React 协调 + 命中行的 chart.js `update()` 的主线程开销**。
100ms 即 10 帧/s，每帧父组件都要跑一次 300 元素排序并重走 300 个 `Row` 的协调（即便多数 memo 命中，
reconciliation 本身有成本），命中行还要 chart.update。headless 实测 6s 稳态：
3 个 ≥50ms 长任务，max 111ms，累计 ~258ms；数据仍正确（0 NaN、300 图表在、首行约 9 次/6s 更新），
但已经开始掉帧（10 帧/s 的更新节奏与 ~60fps 绘制不协调）。

**怎么改（按收益排序）**：

1. **排序降频/解耦**：orderVersion 的通知用 rAF 或 100~200ms 节流合批，
   数据仍逐帧落 store，但"重排序 + 父组件提交"最多每 100ms 一次（甚至在 tab 不可见时暂停）。
2. **虚拟化长列表**：只挂载视口内 ~几十个 Row（含其 Chart），用 transform 定位而非渲染 300 行，
   把协调与图表更新量从 300 降到可见数；过滤/排序只改可见窗口。
3. **图表更新合批**：同一帧内多个 value 变化只在一次 rAF 里统一 `update('none')`，
   或对离屏/不可见行跳过 `chart.update`（`display:none` 行本就不需要画）。
4. 更彻底：Web Worker 内维护 store 与排序，主线程只接收"可见窗口 + 顺序"的快照，
   SSE 解析与排序完全移出主线程。

### c. 两个标签页同时打开 /perf，localStorage 阈值与 SSE 增量同时到达

**合成口径仍一致**。effective value 的唯一公式是 `value = base × th`：

- `base` 来自该标签页自己的 SSE 会话，两标签页连的是同一模块级推流状态（同一 seq 世界），
  即使短暂帧序不同，最终都收敛到同一 seq 的同一组 base；
- `th` 来自每个标签页各自的 localStorage（同源共享存储），`storage` 事件只在"其他"标签页派发，
  使另一标签页即时同步；本标签页自己写入则由自身逻辑/5s 同步兜底；
- 两者在**同一处**合成（entry.value = base*th），不存在双写竞争：SSE 帧只写 `base`，
  阈值同步只写 `th`，互不覆盖；排序读取的是合成后的稳定值。
- 损坏阈值归一化为 1，且写入都过 finite 校验，所以并发下也不会出现 NaN。

**实测**：标签2 `localStorage.th-7=1000`，标签1 经真实跨标签 `storage` 事件同步：
两侧 m7 同以 `base×1000 ≈ 589.5` 置顶且数值一致；随后 3s SSE 继续更新其他行，
两侧顶部行同步变化，全程无 NaN。唯一的"时间差"只是 `storage` 事件到达前的短暂窗口
（本标签页写入是即时的，对端是事件即达），属正常异步，最终一致。

---

## 五、硬性验收（1~2 实测，3~5 方法 + 实测记录）

### 验收 1：`node verify.mjs`（仅 Node 原生模块）—— 实测通过

```
$ node verify.mjs http://127.0.0.1:3210
已连接 http://127.0.0.1:3210/api/metrics（status=200, text/event-stream; charset=utf-8）

采集时长: 10058ms（期望约 10000ms）
注释帧（connected/ping）: 1
坏帧数: 0
数据帧总数: 9
每帧 values 数量: min=31 max=71 avg=47.8
数量分布（每桶 10）:
  30-39: 2 帧
  40-49: 4 帧
  50-59: 1 帧
  60-69: 1 帧
  70-79: 1 帧
seq 区间: 1..9，非连续跳变 0 处
契约校验: 每帧 30~80 个变化指标 -> PASS
```

另核对快照坐标：SSE 流末帧 `seq=13` 后立即 `curl ?snapshot=1`，快照 `seq=13`，同坐标对齐。

### 验收 2：`npm run build`（类型校验开启，未关闭任何检查）—— 实测通过

```
▲ Next.js 16.3.6 (Turbopack)
✓ Compiled successfully
  Running TypeScript ... Finished TypeScript ...
✓ Generating static pages ...

Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/metrics
└ ƒ /perf

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

`/api/metrics` 与 `/perf` 均为 ƒ Dynamic。`next.config.ts`/`tsconfig.json` 未改；
`npx tsc --noEmit` 与 `npx eslint`（本轮 5 个文件）均 0 error。

### 验收 3：new Chart ≤ 300（含过滤往返序列）—— 实测通过

CDP 包装 `HTMLCanvasElement.prototype.getContext('2d')` 统计 Chart 建上下文次数（每实例 1 次）：

- 加载建图完成后：**300**；
- 连续观察 2.5s（多帧增量）后：**300**；
- 输入 `metric_31` → 1 行 → 清空恢复 300 行后：**300**；
- 断线重连 + 快照全量对齐后：**300**。

**人工复现方法**（无需 CDP）：
1. 打开 DevTools Console；
2. 粘贴一次性计数器：
   ```js
   (() => { let n = 0; const o = HTMLCanvasElement.prototype.getContext;
     HTMLCanvasElement.prototype.getContext = function (t, ...a) {
       if (t === "2d") console.count("new chart 2d ctx");
       return o.call(this, t, ...a); };
   })();
   ```
   （`console.count` 会随每个 Chart 构造打印一次序号，稳态应停在 300。）
3. 操作序列：等待 300 图画完 → 在过滤框输入 `metric_31` → 清空 → 输入别的子串再清空 → 等待实时帧；
4. 观察点：序号**只在建图阶段增长到 300**，过滤往返与实时更新过程中不再增加；
   图表线条随数值在原 canvas 内变化（不是闪烁/重建）。

### 验收 4：断线重连后的全量对齐 —— 实测通过

人工复现方法（任选其一）：

- **Network 面板法**：DevTools → Network 把 throttling 切到 **Offline**，等 2~3s
  （面板里 `/api/metrics` 变红/重连），再切回 **No throttling**；观察 Console/Network：
  会出现一次新的 `metrics` EventSource 请求紧跟一次 `metrics?snapshot=1` 请求；
  期间页面所有行仍是旧的有效数字（无 NaN/空白），对齐后数值平滑更新。
- **服务重启法（更严格，覆盖 seq 纪元重置）**：`fuser -k <port>/tcp` 杀掉服务再 `npm run start`，
  客户端自动重连并拉快照对齐。

实测（杀服务端 seq 归零再重启）：重连后 EventSource 打开数 1→3、快照请求 1→2、ctxGets 恒 300、
断线期间与恢复后 NaN 行 = 0，且恢复后继续收到增量（首行值在对齐后继续逐秒变化）。

可在 Console 用下面片段辅助计数（重连后应看到 `snapshot` 递增）：
```js
const f = window.fetch;
window.fetch = (u, o) => (String(u).includes("snapshot=1") && console.count("snapshot"), f(u, o));
```

### 验收 5：卸载清理 —— 实测通过

人工复现：在 `/perf` 等待建图完成后，点击页面顶部的 **← Home** 链接（`next/link`，客户端导航，
React 会真实卸载 Dashboard）。在 Console 预置：
```js
let es = 0, iv = 0;
const ES = EventSource;
EventSource = class extends ES { constructor(...a){ super(...a); es++; }
  close(){ es--; console.log("EventSource alive:", es); super.close(); } };
const si = setInterval, ci = clearInterval, live = new Set();
setInterval = (fn, ms) => { const id = si(fn, ms); live.add(id); iv++; return id; };
clearInterval = (id) => { live.delete(id); iv = live.size; return ci(id); };
```
点击 Home 后：Network 面板中 `/api/metrics` 连接关闭、无重连；Console 显示 EventSource 存活 0；
`live.size === 0`（阈值 interval 被清）；返回 `/perf` 才会重新建连/建图。
300 个 Chart 的 `destroy()` 在各 Row 的 effect cleanup 中执行（DevTools Performance/内存里
canvas 与 chart 实例随卸载释放；dev StrictMode 下还能观察到首挂 300 个被成对 destroy）。

实测（CDP，SPA 导航到 `/`）：`esAlive 1→0、esClosed=1、interval 1→0、scroll/storage 1→0、
DOM .row 300→0、canvas 300→0`。

---

## 六、验证说明（他人拿到代码后）

### 0) 启动

```bash
npm ci            # 依赖（chart.js/next/react 已在 package.json，无新增依赖）
npm run build
PORT=3210 npm run start
```

### A. 用 curl 验证 SSE 在推流

增量流（应每秒收到一行 `data: {...}`，首行为 `: connected` 注释，Ctrl-C 结束）：

```bash
curl -N http://localhost:3210/api/metrics
```

预期输出样例（截取）：

```
: connected

data: {"seq":1,"ts":1791301421001,"values":{"m3":0.1825,"m17":1.0311, ... 30~80 个键 ... }}

data: {"seq":2,"ts":1791301422002,"values":{"m3":0.2014,"m40":2.4202, ... }}
```

- 每帧都是合法 JSON，形如 `{"seq":N,"ts":...,"values":{...}}`，`seq` 逐帧 +1；
- 用管道快速统计每帧 values 数量（应在 30~80）：
  ```bash
  curl -sN http://localhost:3210/api/metrics | grep '^data:' | while read -r l; do
    echo "$l" | sed 's/^data: //' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("values =", Object.keys(JSON.parse(s).values).length))'
  done
  ```

全量快照（一次性返回，覆盖全部 300 个指标）：

```bash
curl -s 'http://localhost:3210/api/metrics?snapshot=1' | head -c 300; echo
```

预期：`{"seq":N,"ts":...,"values":{"m0":...,"m1":...,... }}`，`Object.keys(values).length === 300`。

验收脚本（10s 帧数 + 数量分布 + 契约判定，纯 Node 原生模块）：

```bash
node verify.mjs http://localhost:3210
```

### B. 浏览器人工确认"增量时图表原地变化、过滤往返不重建"

1. 打开 `http://localhost:3210/perf`，等待约 1~2s 让 300 个迷你图画完。
2. 打开 DevTools → Console，粘贴验收 3 的 `getContext` 计数器，回车（先不要操作）。
3. **确认图表原地变化**：盯住任意几行的 canvas——每秒数值文本更新时，折线在**同一个框里**
   向左生长/波动（最近 40 点滑窗），没有白屏闪烁、没有重新布局；行的上下顺序会随数值变化平滑重排。
   计数器在这一过程中**保持 300 不增长**。
4. **确认过滤往返不重建**：在过滤框输入 `metric_31`，列表只剩 1 行（其余行 `display:none`）；
   再清空，300 行回来。整个过程计数器**始终为 300**（没有新的 `getContext('2d')`），
   回来的行仍是原来的 canvas 与图表实例，历史折线点还在。
5. 可反复输入不同子串、快速往返、结合实时帧观察：计数器永不超过 300，页面无 NaN。
6. **重连对齐**：按验收 4 用 Network Offline 切换或重启服务端，观察 `metrics?snapshot=1`
   在重连后被请求一次，期间无数值空白/NaN。
7. **卸载**：点顶部 ↔ Home 客户端导航后，Network 里 SSE 连接关闭、不再有帧请求。

---

## 七、五个文件的 diff（每处注明设计动机）

> 说明：本轮 `app/globals.css` 无需修改，故无 diff（既有 `.row` pulse 与 `body.scrolled` 语义直接复用）。
> 下列为相对第二轮交付基线的改动要点；完整代码以工作区文件为准。

### `lib/metrics.ts`（修改）

- 新增 `METRIC_COUNT` 常量：服务端推流与客户端 store 共用同一数量口径，避免魔法数。
- 新增 `METRIC_INDEX`（id→序号的只读映射）：帧到达时 O(1) 定位行，杜绝每帧 `find`。
- 新增 `INITIAL_BASES`：把"静态 samples.json 的基线"显式导出，让 SSR 初值与推流端初值同源。
- 新增 `MetricsFrame`/`MetricsSnapshot` 类型与 `FRAME_MIN/FRAME_MAX`：推流端与客户端共用帧契约。
- 新增 `buildInitialSnapshot()`：SSR 首屏快照（seq=0、全量、单一 ts），把唯一的非纯 `Date.now()`
  从组件渲染体收敛进模块函数，满足 React 19 `react-hooks/purity`，且让页面 ts 与推流世界同构。
- `compute` 仍为不触碰 localStorage/Date 的纯函数，语义不变。

### `app/api/metrics/route.ts`（新增）

- Route Handler `GET`，用 Web 标准 `ReadableStream<Uint8Array>` 返回 `text/event-stream`；
  无任何第三方依赖。`dynamic = "force-dynamic"` 防止预渲染/缓存。
- 模块级 `bases/seq` 单例 + 订阅者集合：所有连接共享同一随机游走与同一 seq 坐标（为重连对齐奠基）；
  ticker 引用计数懒启停；每帧随机 30~80 个不重复指标做小幅游走，只广播变化项。
- `?snapshot=1` 分支返回全量 JSON（`no-store`），供首连/重连对齐。
- `request.signal` 的 `abort` 与写入异常都走同一条退订/关闭路径；首包注释冲刷 + 15s 心跳。
- 响应头 `Cache-Control: no-store, no-transform`、`Connection: keep-alive`。

### `app/perf/dashboard.tsx`（修改，核心）

- 新增 `MetricEntry` 与 `MetricsStore`：恒定引用的可变真源；按行监听 + 排序版本监听；
  增量帧只改 30~80 个 entry 并仅通知这些行；阈值同步沿用"挂载即同步 + 5s interval + storage 事件"，
  但改为原地改 entry、无变化零通知。
- SSE 自管状态机：`onopen→align（拉快照）`、对齐期缓存增量并按 seq 补发、`onerror→指数退避重连`；
  快照把本地 seq 重置为快照 seq（处理推流端纪元重置）；finite 校验 + 阈值归一化杜绝 NaN。
- Dashboard：store 用 `useState` 惰性初始化（渲染期一次性建对象的合法入口，规避 refs 规则）；
  300 行恒渲染，过滤用 `display:none`，排序移动 DOM；`useMemo` 只重建 300 索引数组。
- Row：`useSyncExternalStore` 订阅本行版本；Chart 一生一次，值变化原地改 `data` 并 `update('none')`
  （40 点滑窗）；创建任务改为**令牌 + 全局按帧队列**，兼容子/父 effect 顺序与 StrictMode，
  并加 setTimeout 兜底后台 rAF 暂停；卸载 destroy。
- 卸载 effect 对称清理 EventSource/重连 timer/阈值 interval/storage 监听/监听集合。

### `app/perf/page.tsx`（修改）

- 初值改用 `buildInitialSnapshot()`：与推流端同源、组件体内不直接 `Date.now()`；
  仍 `await searchParams` 保持 ƒ Dynamic；仍下发 300 行 `initialRows`（客户端零 compute）。
- 新增到首页的 `next/link`：提供客户端导航出口，用于真实 React 卸载验证（不影响任何既有语义）。

### `verify.mjs`（新增）

- 仅 `node:http`/`node:https`/`URL`：连接 SSE，按 `\n\n` 切事件、解析 `data:` 行，
  10s（可用 `DURATION_MS` 覆盖）内统计帧数、每帧 values 数量 min/max/avg、分桶分布、seq 连续性，
  并对 30~80 契约做 PASS/FAIL 退出码判定。支持参数/`BASE_URL` 指定地址。

### `app/globals.css`

- 无改动（本轮需求不需要新增样式；过滤直接用内联 `display:none`，滚动/pulse 沿用现有 class）。
