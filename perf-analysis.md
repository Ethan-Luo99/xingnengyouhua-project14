# /perf 报障代码理解报告

分析对象（真实故障现场，只读）：`/mnt/g/gsb/project14/main` 下
`lib/metrics.ts`、`app/perf/dashboard.tsx`、`app/perf/page.tsx`。
下文行号均对应该目录文件。标注约定：【推】=由代码+框架语义推出；【测】=本次实测；
【待】=未完全核实。实测环境：Next 16.3.6 + React 19.2.8 + chart.js 4.5.1，
源码复制到 `/tmp/p14`（原现场未改动），headless Chromium 153 经 CDP 埋点，
dev=:3010、prod(`next start`)=:3020。

## 一、执行流还原与量化

**SSR（一次 `/perf?q=…` 请求）**【推+测】
- `page.tsx:8` await 动态 `searchParams`（Next 16 中为 Promise），故该页按需动态渲染。
- 服务端渲染 Dashboard 1 次：`useState` 初值表达式 `dashboard.tsx:12-14` 在服务端
  求值 1 次 → compute 调用 300（【测】首请求服务端日志 application-code≈191ms，
  冷请求总 1.19s、热请求 0.068s；HTML 300 行/300 canvas）。
- 服务端 `typeof localStorage==="undefined"` 为真（【测】Node 24 `typeof localStorage`
  =undefined），不读 localStorage。
- 300 行各渲染 1 个 `<canvas>` 与 Intl/时间文本；SSR 不执行 useEffect、不 new Chart
  （Chart 类虽被打进 SSR chunk【测】，但仅在 ref 回调里构造，ref 不于服务端触发）。

**客户端 hydration 起算**（关键计数，均【测】）
- 首次 interval 触发前（ivBorn=0 窗口）compute 次数：prod **300**、dev **600**
  （dev 双渲染：【测】组件体 28 次/3s、useState 实参 map 求值 8400 次/3s）。
- 即非惰性 `useState(expr)` 的 `expr` 每次渲染都求值，仅首值被采用【测·插桩】。

**60 秒稳定运行实测**（【测】CDP 埋点；prod=生产构建，dev=开发模式）

| 指标 | prod(:3020) | dev(:3010) | 说明 |
|---|---|---|---|
| React commits | 118 | 116 | onCommitFiberRoot 累计 |
| compute 调用（=thGet） | 828,600 | 775,800 | 每次 compute 恰读 1 次 localStorage |
| 成功 new Chart（ctx2d） | 300 | 300 | getContext('2d') 计数 |
| Chart 重绑抛错（被 catch） | 34,200 | 31,500 | "Canvas is already in use" |
| 累计创建 interval | 115 | 107 | |
| 存活 interval | 115 | 107 | clearInterval=0 |
| scroll 监听 add/remove | 107/106 | 100/99 | **净存活恒为 1** |
| Intl.NumberFormat 构造 | 34,504 | 63,006 | Row 每次渲染新建 |

算式【推】：compute 总数 = 初值/重渲染被丢弃的 map（每次 Dashboard 渲染 300）
＋ 每个 interval 回调 setRows 的 300。interval 创建数 ≈ Dashboard 渲染数（第二个
effect 无依赖数组，每次提交都重跑一次），1 + N 随时间线性增长。首屏 hydration 渲染
1 次=300（prod）；dev 双渲染=600。单批 300×20000 点实测 **61ms**（>3 帧预算）。

## 二、风险清单表

| 位置 | 类型 | 根因机制（框架语义） | 触发频率 | 单次代价 | 影响面 | 置信度 |
|---|---|---|---|---|---|---|
| dashboard.tsx:21-27 第二个 useEffect 无依赖数组 | 性能 | 无 dep 数组=每次 commit 后执行；回调内 `setInterval` 且未 return cleanup，旧定时器不回收，且每次 setRows→渲染→再建，正反馈 | 每次渲染 | 每器常驻+回调内 300 compute≈61ms | TBT/INP/内存/掉帧 | 高【测】 |
| dashboard.tsx:26 `1000/(tick+1)` | 性能/正确性 | tick 由 60ms 定时器无限自增，新建 interval 的延迟趋于 0，受浏览器嵌套定时器下限≈4ms 钳制（HTML 标准） | 每渲染 | 理论上限≈250 回调/s | CPU/掉帧 | 高【推+测】 |
| dashboard.tsx:12-14 非惰性 useState 初值 | 性能 | `useState(expr)` 的 expr 是普通实参，JS 每次渲染都求值，React 仅保留首次值；300×20000 计算被反复丢弃 | 每次 Dashboard 渲染 | ≈61ms | TBT/INP | 高【测·插桩】 |
| dashboard.tsx:29-32 useMemo dep=[rows,filter] | 性能 | rows 每次 setRows 都是新数组引用，memo 每次失效；内部 JSON 深拷贝 300 对象再 sort | 每次 rows 更新 | 实测≈3.5ms + sort | 掉帧 | 高【测】 |
| dashboard.tsx:22-25 setRows 全量替换 | 性能/正确性 | 每回调重建 300 对象并整表 setState，React 对全列表协调 | ≈24 次/s【测】 | 61ms+协调 | INP/掉帧/数值跳变 | 高 |
| dashboard.tsx:53 key={i}+排序 | 性能/正确性 | key 为位置索引，排序后 React 按 key 复用位置节点，把"新数据"当 props 更新而非移动；Row 内 useRef/canvas 不随数据迁移 | 每次 rows 更新 | 300 行重协调 | 闪烁/INP | 高【推】 |
| dashboard.tsx:71-82 bindChart 内联 ref 回调 | 性能 | 每次 Row 渲染生成新函数；React 对变化的 ref 先以 null 调用旧回调再以节点调用新回调；null 分支不 destroy，重绑同 canvas 触发 chart.js "already in use" | 每次 Row 渲染 | 300 行；34.2k 抛错 | CPU/内存(Chart 泄漏) | 高【测】 |
| dashboard.tsx:75-81 catch 空吞异常 | 正确性(掩盖) | 重绑失败被静默吞掉，图表永不更新且 Chart 实例不销毁（chart.js 仍挂 resize 监听/animator） | 每次重绑 | Error 构造+栈 | 内存/掩盖 bug | 高【测】 |
| dashboard.tsx:67 new Intl.NumberFormat 每次渲染新建 | 性能 | 该构造在组件体内，未 memo，34.5k 次/60s | 每次 Row 渲染 | 中 | CPU | 高【测】 |
| dashboard.tsx:37 `void document.body.offsetHeight` | 性能 | 在 scroll 监听中读布局属性，强制同步布局/强制回流（layout thrashing）；滚动事件高频 | 每 scroll 帧 | 强制 reflow | 滚动掉帧/闪烁 | 高【推】 |
| dashboard.tsx:34-41 第三个 useEffect dep=[sorted] | 性能 | sorted 每次渲染为新引用，effect 每次重跑：写 title(Math.random)+注销/重注 scroll；实测净监听数恒 1（remove 生效，非泄漏） | 每次渲染 | add/remove+回流 | 掉帧 | 高【测】 |
| dashboard.tsx:85 `animation:pulse 1s infinite` | 性能 | 300 个元素各自无限 CSS 动画，持续触发合成/绘制 | 恒定 | 300 元素持续 paint | 持续 GPU/掉帧 | 高【推】 |
| dashboard.tsx:4 import "chart.js/auto" | 性能(首屏) | auto 入口 `Chart.register(...registerables)` 注册全部控制器/组件，无法 tree-shake；打入主 chunk | 一次 | chunk 488K(raw)/163K(gz) | FCP/TBT/带宽 | 高【测】 |
| dashboard.tsx:7 export dynamic（在 "use client" 文件） | 非问题误判 | Route Segment Config 仅在 page/layout/route 模块被读取；客户端组件内导出不影响服务端路由（构建产物里仅作客户端模块导出存在） | — | — | — | 高【测 A/B】 |
| scroll 监听器"泄漏数百个" | 非问题误判 | cleanup（:40）正常成对执行，实测净存活恒为 1；反复 add/remove 是抖动但非堆积 | — | — | — | 高【测】 |
| Chart 构造 34,500 个实例 | 非问题误判 | 34,200 次在 chart.js 构造器前置校验处 throw，未生成实例；真实存活 Chart=300（ctx2d=300） | — | — | — | 高【测源码+埋点】 |
| metrics.ts:13 typeof localStorage 兜底 | 正确性 bug(掩盖) | SSR 下隐藏"服务端无 localStorage"；服务端 th=null→系数1；客户端读 th-i，两端口径不同导致水合值差异 | 每次 compute | — | 正确性/水合 | 高【测】 |
| dashboard.tsx:13/24 ts:Date.now() | 正确性 bug | SSR 与客户端取值时刻不同，水合文本必不一致；实测 prod 抛 React #519 HydrationMismatchException | 首屏 | 水合失败→客户端重渲 | 闪烁/正确性 | 高【测】 |
| dashboard.tsx:9 模块级 cache + :43-48 onPick | 正确性 bug | pick 只改模块变量不调 setState，渲染不会因此发生；UI 仅在下次 interval 渲染时被动反映。实测点击后文本在下次提交才更新 | 点击 | — | 交互正确性 | 高【测】 |
| dashboard.tsx:52 `<input defaultValue={filter}/>` | 正确性/非问题辨析 | 非受控输入：filter prop 变化不会回写已挂载输入；输入本身不触发任何过滤（filter 仅作 memo/回调依赖，无过滤逻辑） | 输入时 | — | 功能缺失 | 高【推】 |
| metrics.ts:9-15 compute 闭包内读 localStorage | 性能/正确性 | 每指标每批 1 次同步 Storage 读取，实测 828.6k 次/60s；同步 IPC/解析开销 | 极高 | 单次小、累计大 | CPU/掉帧 | 高【测】 |
| page.tsx:8 await searchParams | 非性能问题(语义) | 这是 /perf 被标 ƒ Dynamic 的真实原因（动态 API），非 force-dynamic【测 A/B：删 force-dynamic 仍 ƒ；去掉 await searchParams 变 ○】 | 每请求 | — | SSR/缓存 | 高【测】 |

## 三、技术细节问答

1. **force-dynamic 是否生效 / Dynamic 真因**：不生效。Route Segment Config 只从
   page/layout/route 段模块读取，dashboard.tsx 顶部是 `"use client"`（:1），其导出
   不参与服务端段配置。【测 A/B】仅删 :7 后 build 仍为 `ƒ /perf`；再把 page.tsx 的
   `await searchParams` 去掉则变 `○ /perf`。真实原因是 `app/perf/page.tsx:6-8` 使用了
   动态 API（Next 16 的 `searchParams` 是 Promise，await 即强制请求期动态渲染）。

2. **useState 初值水合时是否重算 / 是否相同**：会重新计算。【测·插桩】非惰性
   `useState(expr)` 的 `expr` 是普通函数实参，组件每次渲染都对其求值，React 只采用
   首次返回值；prod 首个 interval 前恰好 300 次 compute、dev 双渲染 600 次。两端 value
   理论同口径：数据来自固定 LCG 的 samples.json（20k 点，确定性），服务端 th=null、
   客户端 localStorage 无 `th-i` 键时也为 null，数值相同；但 **ts:Date.now()**
   （dashboard.tsx:13）两端时刻不同。差异最终体现在每行 `new Date(row.ts).toLocaleString()`
   （:68）渲染出的时间文本节点（SSR HTML 为服务端时刻，如 `10/3/2026, 3:27:05 AM`）。
   【测】prod 控制台/异常出现 React #519 `HydrationMismatchException`，水合回退为
   客户端重绘——对应"打开即闪一次"。

3. **typeof localStorage 兜底掩盖了什么**：metrics.ts:13 用它区分服务端/客户端。服务端
   Node（【测】v24 `typeof localStorage` 为 undefined）走 th=null→乘数 1；客户端走
   `localStorage.getItem('th-'+i)`。掩盖的是"该计算本不应在渲染期依赖浏览器存储/不应在
   服务端执行"这一事实，使服务端静默用系数 1 而客户端按本地存储取系数，两端口径分叉。
   若用户设过 `th-i`，首屏数值还会在水合后改变。【测 A/B】删除该兜底直接
   `localStorage.getItem` 后，SSR 抛 `localStorage is not defined`，`/perf` 返回 500、
   0 行；即当前页面能 SSR 全靠这个判断"兜底"。

4. **bindChart 为何每次渲染被调用 / 返回 undefined 的后果**：:71 的 ref 回调在 Row
   每次渲染时都是新函数引用。React 对 ref 回调按引用比较：引用变化时先用 `null` 调用
   旧回调、再用节点调用新回调（卸载也以 null 调用）。React 19 语义：ref 回调若返回
   非 undefined 函数，该返回值被当作 cleanup（替代旧的立即清理）；返回其它非函数值会
   告警。这里箭头函数体内有 if/try，无返回语句→返回 **undefined**，即"没有 cleanup"。
   后果：旧 Chart 永不 destroy；canvas 被 chart.js 内部 `instances` 登记后，新回调再
   `new Chart(el)` 命中前置 `existingChart` 直接 throw（构造器 :5651 附近），try/catch
   吞掉。【测】300 canvas 成功一次（ctx2d=300），其后 34,200 次重绑全部抛错。

5. **sorted useMemo 为何必然失效 / 频率**：依赖是 `[rows, filter]`（:32）。setRows
   （:23）每次都产生全新数组引用，rows 每次 interval 更新都变 → memo 每次重算，内部还
   JSON 深拷贝+sort（:30-31）。filter 是服务端 prop，仅随 URL/searchParams 变化（同一
   页面会话内通常 0 次）；rows 实测≈每秒数十次（60s 累计触发对应数百次渲染）。故瓶颈
   频率由 rows 决定，filter 几乎不变。【测】60s commits prod 118、dev 116。

6. **无依赖 useEffect 的 interval 存活数 / 延迟极限 / 真实刷新率**：:21-27 无 dep 数组
   →每次 Dashboard 提交后都执行，且回调不返回清理函数，故每个 setInterval 永久存活。
   【测】60s 存活=创建数：prod 115、dev 107（clearInterval=0），随时间线性增长，约
   ≈Dashboard 渲染次数。延迟 `1000/(tick+1)`：tick→∞ 时趋于 **0**；但 Chromium 对
   嵌套/激进定时器钳到下限 **4ms**（标准 1000ms 内超过 5 次后的嵌套定时器）。故单器
   理论上限 250 次/s，且 115 个存活器叠加。受主线程被 61ms 重算占满，实际状态更新被
   合并，真实有效行刷新≈1.4–2 次 commit/s（60s/118），单次 compute 批已超一帧。

7. **key={index}+排序：复用还是重建**：React 按 key 匹配。key 是位置 i 而非数据 id，
   排序变化后位置 i 上仍是同一 key，故 React **复用**该 DOM/Fiber 节点，仅用新 props
   触发 Row 更新（表现为内容跳动，而不是把节点移动到正确位置）。对 Row 内部：useRef
   （:69）保持同一对象、canvas 元素（:88）保持同一 DOM 节点、其上已构造的 Chart 实例
   保持不变（所以 bindChart 重绑同 canvas 必撞"already in use"）；而 row.value 变了
   图表数据却不会更新（没有 chart.update 调用）。

8. **offsetHeight 触发的阶段 / 监听器存活数**：:37 读取 `document.body.offsetHeight`
   属于读布局属性（layout-reading property）。若此前有未刷新的样式/结构变更，浏览器为
   返回正确值必须先完成样式计算与布局（reflow），即强制同步布局（forced synchronous
   layout）；放在 scroll 高频回调里造成布局抖动，滚动时整页重排闪烁。该监听由
   :34-41 effect 管理，dep=[sorted] 每次渲染重注，但 :40 的 cleanup 正确移除旧监听。
   【测】add=107/remove=106（差 1 为当前存活），同一时刻 **净存活恒为 1 个**——是每次
   滚动都强制回流的问题，不是监听器堆积问题。

9. **模块级 cache 并发 / pick 是否更新 UI**：`cache`（:9）是模块级单例。服务端若该模块
   进入 Node 运行时，跨请求共享同一对象，存在跨请求/跨用户数据串读风险（本页 cache 仅在
   客户端事件中写，且客户端组件模块在浏览器内，故服务端不写它；但同进程若多请求复用
   已污染状态无隔离——【待】此项目未见服务端写路径，影响主要是潜在而非现行）。客户端
   点击 pick（:43-48）只执行 `cache[id]++`，**没有 setState**，React 不会因此重渲染，
   所以点击当下 UI 不变；要等下一次 interval 的 setRows 触发渲染时，`:54` 重新读
   `cache[r.id]` 才被动显示。【测】点击后 0ms 仍无数值更新，下一次提交后才出现 `1`。

10. **chart.js/auto 首屏影响 / tree-shake / SSR 是否执行**：`chart.js/auto`
    （:4）在其入口执行 `Chart.register(...registerables)`，副作用式注册全部控制器、
    元素、刻度、插件，打包器无法静态判定用不到而删除，故**不能 tree-shake**，全部进入
    引用它的 chunk。【测】该 chunk 488K 原始 / 163K gzip，随 /perf 首屏客户端 JS 下发，
    抬高 FCP/TBT。SSR 阶段模块代码会被求值（【测】"Canvas is already in use" 字符串与
    register 逻辑确实进入 `.next/server/chunks/ssr` chunk），但 `new Chart` 只在客户端
    ref 回调里发生，服务端不构造图表实例。

## 四、边界推演、歧义与自检

**(a) 场景推演**
- **数据 0 条**【推】：metrics.ts:11 循环 0 次 s=0，:14 分母 `(0||1)`→value 恒 0；
  但 :13 的 localStorage 读取在循环外，仍每指标 1 次→每批仍 300 次读取；仍 300 行、
  300 图、全部定时器/重渲染照旧。即"空数据"几乎不缓解性能问题。
- **数据 10 万条**【推，按 20k 实测线性外推】：单批 300×10⁵ 次 log/sin，约
  61ms×5≈**305ms/批**；SSR 单次同步 compute 同量级，:12 深拷贝只拷 300 行不受影响。
  samples.json 当前固定 20k，需改生成器方可复现。
- **后台 5 分钟再切回**【推+标准】：不可见标签定时器被节流（嵌套激进定时器 5 分钟后
  约 1 次/min）；期间 interval 仍随少量渲染缓慢累积，切回前台所有存活器恢复 4ms 调度，
  形成渲染/回流突发，数值一次跳多档。真实突发量级【待】。
- **6× 节流下输入**【推+测】：输入框是非受控（:52 defaultValue），按键本身不触发
  React；但主线程被 ~61ms（节流下≈366ms）的 compute 批与定时器占满，按键事件/合成
  排队→INP 恶化、打字延迟。
- **连续 100 个 /perf 请求**【测+推】：该页 ƒ Dynamic，每请求都服务端重算 300 compute
  （热请求 wall 0.068s、冷 1.19s，应用代码实测 ~191ms）；RAW/METRICS 为模块单例只解析
  一次，METRICS 不被修改；cache 无服务端写路径，故无现行跨请求串写，但 CPU 为瓶颈、
  并发会排队。
- **两个标签页**【推】：各自独立 JS 模块实例，内存态 `cache` 不共享；localStorage 同源
  共享，`th-i` 互相影响 compute 结果。
- **刷新后 pick**【推+测】：pick 只存内存 cache，刷新即归零；localStorage 中 th 持久化。
- **CDN 缓存 + filter**【推】：filter 来自 `?q`（searchParams），URL 变化触发动态 SSR；
  手输不进 URL、不更新 filter、不过滤。若 CDN 缓存了某 q 的 HTML，会把该首屏输入值
  与服务端时间文本一并缓存；实际缓存指令头【待】未测。

**(b) 优化前必须澄清的歧义（附本报告假设）**
1. "300 个 compute 被反复调用"指定义数、单次批次数还是累计调用？——三者分别为
   300、300/批、82.86 万/60s；本报告按三量分列。
2. filter 是外部参数还是用户输入？——代码二者分离：filter 来自服务端 searchParams，
   输入框非受控且不过滤；假设报障"打字"主要是输入延迟，过滤失效另计。
3. 实时性目标（秒级/分钟级）与可接受刷新粒度——未给，本报告只陈述现状不评判轮询必要性。
4. "稳定运行 60s"是否含 hydration、是否允许滚动/后台——假设前台可见、不滚动、从
   navigate 起算。
5. 计数口径取 dev 还是 prod——两者差异大（dev StrictMode 双渲染：初值 600 vs 300），
   本报告均测，以 prod 为主、dev 并列。

**(c) 最可能错的判断（≤5）**
1. "有效刷新≈1.4–2 commit/s"基于 headless-shell（无真实合成/可见调度、无滚动），桌面
   Chrome 前台可能更高，存在低估风险。
2. 4ms 下限与 250 次/s 上限：现场是 1 个 60ms ticker＋大量延迟各异的独立 interval，
   嵌套计数与具体 Chrome 节流策略未逐器刻画，真实触发分布可能偏离。
3. 后台节流阈值（5 分钟后 1 次/min）主要针对嵌套链，多个独立 setInterval 的恢复突发量
   未实测，可能高估或低估切回瞬间负载。
4. SSR 多请求的模块 cache 风险判为"潜在非现行"：客户端组件模块确会在服务端被求值并
   创建 cache 对象，只是 onPick 不在服务端跑；若框架/HMR 另有写路径，此结论会变弱。
5. 水合首要失配点判为时间文本：测试用干净 profile（无 th-i），value 两端一致；真实用户
   若设过 th-i，value 文本节点同样失配，首要差异节点会改变。

> 实测方法：CDP `Page.addScriptToEvaluateOnNewDocument` 注入计数（包装 setInterval、
> addEventListener、canvas.getContext、Storage.getItem、console.error，并安装
> React DevTools hook 计 onCommitFiberRoot）；采样点输出存活数与分布。A/B 构建与删
> 兜底实验均只在 `/tmp/p14` 临时副本进行，原现场 `/mnt/g/gsb/project14/main` 与本
> 工作目录三个文件未做任何修改（仅新增本报告）。
