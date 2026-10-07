"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CategoryScale,
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
} from "chart.js";
import {
  METRICS,
  METRIC_COUNT,
  METRIC_INDEX,
  type MetricsFrame,
  type MetricsSnapshot,
} from "@/lib/metrics";

// 只注册本页用到的折线图组件，其余控制器/插件可 tree-shake（替代 chart.js/auto 全量注册）
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale);

export type PerfRow = { id: string; name: string; base: number; ts: number };

// 阈值同步周期：固定 5s。回调幂等（读 300 个阈值、无变化不通知），
// 后台节流只会推迟同步，不会堆积。
const TH_SYNC_MS = 5000;

const FMT = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

// localStorage 阈值系数语义保留：键仍为 th-<i>（i 为指标序号，id 为 m<i>）
function readThresholdByIndex(i: number): number {
  const raw = localStorage.getItem(`th-${i}`);
  const n = raw ? Number(raw) : 1;
  // 损坏值（NaN/0/负数/Infinity）一律视为 1：合成值永远不出现 NaN/Infinity。
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// 时区无关的确定性格式：SSR 与 CSR 对同一 ts 输出同一文本
function fmtTs(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// ---------------------------------------------------------------------------
// 可变数据真源
//
// 关键约束（需求 1）：收到增量帧后"只更新受影响行"，不得每帧重建 300 行结构。
// 做法：300 个 MetricEntry 对象在整个挂载生命周期内引用恒定，base/th/ts/version
// 原地修改；每帧只 bump 30~80 个 entry 的 version，仅这些行通过 useSyncExternalStore
// 收到通知而重渲染。排序由父组件订阅一个单调递增的 orderVersion 后移动 DOM，
// 不重建行对象、不重新 compute。
// ---------------------------------------------------------------------------
class MetricEntry {
  readonly id: string;
  readonly name: string;
  base: number;
  th = 1;
  ts: number;
  version = 0;

  constructor(id: string, name: string, base: number, ts: number) {
    this.id = id;
    this.name = name;
    this.base = base;
    this.ts = ts;
  }

  get value(): number {
    return this.base * this.th;
  }
}

type FrameListener = () => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
// 对齐期间最多缓存这么多帧（1s/帧时即 30s 窗口，远超正常快照 RTT）。
const PENDING_CAP = 30;

class MetricsStore {
  private readonly entries: MetricEntry[];
  // 每行一个监听集合：帧到达时只通知受影响的行。
  private readonly rowListeners: Array<Set<FrameListener>>;
  // 排序版本：任一 entry 的 value 可能影响排序，每批变更 bump 一次，
  // 父组件每帧最多重渲染一次（而不是每改一行一次）。
  private orderListeners = new Set<FrameListener>();
  private orderVersion = 0;
  private seq = 0;

  private es: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private disposed = false;
  private aligning = false;
  private pendingFrames: MetricsFrame[] = [];

  private thresholdTimer: ReturnType<typeof setInterval> | null = null;
  private storageHandler: ((e: StorageEvent) => void) | null = null;

  constructor(initialRows: PerfRow[]) {
    this.entries = initialRows.map(
      (r) => new MetricEntry(r.id, r.name, r.base, r.ts)
    );
    this.rowListeners = Array.from({ length: METRIC_COUNT }, () => new Set());
  }

  // ---- 订阅原语（供 useSyncExternalStore 使用）----
  subscribeRow(index: number, fn: FrameListener): () => void {
    this.rowListeners[index].add(fn);
    return () => this.rowListeners[index].delete(fn);
  }
  subscribeOrder(fn: FrameListener): () => void {
    this.orderListeners.add(fn);
    return () => this.orderListeners.delete(fn);
  }
  getVersion(index: number): number {
    return this.entries[index].version;
  }
  getOrderVersion(): number {
    return this.orderVersion;
  }
  getEntry(index: number): MetricEntry {
    return this.entries[index];
  }

  private notifyRows(changed: ReadonlySet<number>) {
    changed.forEach((i) => this.rowListeners[i].forEach((fn) => fn()));
  }
  private bumpOrder() {
    this.orderVersion += 1;
    this.orderListeners.forEach((fn) => fn());
  }

  // 写单个指标；仅当 base 真正变化才 bump version（幂等帧/快照不产生渲染）。
  private setBase(i: number, v: number, ts: number, changed: Set<number>) {
    const e = this.entries[i];
    if (Number.isFinite(v) && e.base !== v) {
      e.base = v;
      e.ts = ts;
      e.version += 1;
      changed.add(i);
    }
  }

  private applyFrame(frame: MetricsFrame) {
    // 服务端 seq 全局单调：旧帧/重复帧直接丢弃（重连后的重叠帧同理）。
    if (typeof frame.seq !== "number" || frame.seq <= this.seq) return;
    const changed = new Set<number>();
    for (const id of Object.keys(frame.values)) {
      const i = METRIC_INDEX[id];
      if (i === undefined) continue; // 未知 id 防御性忽略
      this.setBase(i, frame.values[id], frame.ts, changed);
    }
    if (changed.size > 0) {
      this.seq = frame.seq;
      this.notifyRows(changed);
      this.bumpOrder();
    } else {
      this.seq = frame.seq;
    }
  }

  // ---- SSE 生命周期 ----
  start() {
    this.connect();
    this.startThresholdSync();
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.es) {
      this.es.onopen = null;
      this.es.onmessage = null;
      this.es.onerror = null;
      this.es.close();
      this.es = null;
    }
    if (this.thresholdTimer !== null) clearInterval(this.thresholdTimer);
    this.thresholdTimer = null;
    if (this.storageHandler) {
      window.removeEventListener("storage", this.storageHandler);
      this.storageHandler = null;
    }
    this.rowListeners.forEach((s) => s.clear());
    this.orderListeners.clear();
  }

  private connect() {
    if (this.disposed || this.es) return;
    const es = new EventSource("/api/metrics");
    this.es = es;
    es.onopen = () => {
      this.reconnectAttempts = 0;
      void this.align();
    };
    es.onmessage = (ev) => {
      let frame: MetricsFrame;
      try {
        frame = JSON.parse(ev.data as string) as MetricsFrame;
      } catch {
        return; // 坏帧忽略，绝不让异常打断连接状态机
      }
      if (this.aligning) {
        // 对齐未完成前缓存帧；快照落地后按 seq 顺序补发，期间 UI 保持旧值，
        // 不写 undefined，也不会因半程状态产生 NaN。
        if (this.pendingFrames.length < PENDING_CAP) this.pendingFrames.push(frame);
      } else {
        this.applyFrame(frame);
      }
    };
    es.onerror = () => {
      // 浏览器自带重连不可靠（且无法在其重连后插入全量对齐），统一自行管理：
      // 关掉旧连接 -> 退避重连 -> onopen 后先拉快照对齐再恢复增量。
      es.onopen = null;
      es.onmessage = null;
      es.onerror = null;
      es.close();
      if (this.es === es) this.es = null;
      if (this.disposed) return;
      this.aligning = false;
      this.pendingFrames = [];
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null || this.disposed) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // （重新）连接建立后的全量对齐：重新 fetch 完整快照，按 seq 坐标补发缓存帧。
  private async align() {
    this.aligning = true;
    this.pendingFrames = [];
    try {
      const res = await fetch("/api/metrics?snapshot=1", { cache: "no-store" });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const snap = (await res.json()) as MetricsSnapshot;
      if (this.disposed || !this.es) return;
      const changed = new Set<number>();
      for (const id of Object.keys(snap.values)) {
        const i = METRIC_INDEX[id];
        if (i === undefined) continue;
        // 快照覆盖全部 300 项，逐项对齐（含服务端重启后的旧值回退场景）。
        this.setBase(i, snap.values[id], snap.ts, changed);
      }
      // 快照定义服务端 epoch：同一服务端重连时 snap.seq >= 本地 seq；
      // 若 snap.seq 更小，说明推流端状态已重置（进程重启/换实例），
      // 必须放弃本地 seq 坐标，否则新纪元的小 seq 帧会被全部误判为旧帧丢弃。
      this.seq = snap.seq;
      // 快照在途期间到达的帧，按 seq 升序补发 seq 更新的那些。
      const pending = this.pendingFrames
        .filter((f) => f.seq > snap.seq)
        .sort((a, b) => a.seq - b.seq);
      this.pendingFrames = [];
      this.aligning = false;
      if (changed.size > 0) {
        this.notifyRows(changed);
        this.bumpOrder();
      }
      for (const f of pending) this.applyFrame(f);
    } catch {
      // 快照失败：退避后整体重连（下一次 onopen 会再次对齐），UI 保持旧值。
      if (this.disposed) return;
      this.aligning = false;
      this.pendingFrames = [];
      if (this.es) {
        this.es.close();
        this.es = null;
      }
      this.scheduleReconnect();
    }
  }

  // ---- 阈值系数（localStorage，每标签页独立存储）----
  // 读完全部 300 个阈值，仅对真正变化的行原地写入并通知；无变化零通知。
  private syncThresholds() {
    const changed = new Set<number>();
    const now = Date.now();
    for (let i = 0; i < METRIC_COUNT; i++) {
      const next = readThresholdByIndex(i);
      const e = this.entries[i];
      if (e.th !== next) {
        e.th = next;
        e.ts = now;
        e.version += 1;
        changed.add(i);
      }
    }
    if (changed.size > 0) {
      this.notifyRows(changed);
      this.bumpOrder(); // th 改变 effective value，排序必须重算
    }
  }

  private startThresholdSync() {
    this.syncThresholds();
    this.thresholdTimer = setInterval(() => this.syncThresholds(), TH_SYNC_MS);
    this.storageHandler = (ev: StorageEvent) => {
      // 跨标签页：只有 th-* 键需要响应；回调幂等，全量重读是安全的。
      if (ev.key === null || ev.key.startsWith("th-")) this.syncThresholds();
    };
    window.addEventListener("storage", this.storageHandler);
  }
}

// ---------------------------------------------------------------------------
// Dashboard：行身份与顺序
//
// 300 行的 DOM/Chart 生命周期与"过滤/排序"完全解耦：
//   - 行始终渲染 300 个（与 SSR 一致），过滤只是对不匹配行加 display:none，
//     因此过滤往返绝不存在"卸载 -> 重新挂载 -> new Chart"的路径；
//   - 排序通过 JSX 顺序变化让 React 移动现有 DOM 节点（key=id），canvas 元素
//     跟随其行移动，Chart 实例与 canvas 的绑定不变。
// 任何操作序列下 new Chart 总数恒为 300（dev StrictMode 双挂载为 300×2 次、
// 存活仍 300，均成对 destroy）。
// ---------------------------------------------------------------------------
export default function Dashboard({
  filter,
  initialRows,
}: {
  filter: string;
  initialRows: PerfRow[];
}) {
  // 数据真源在整个组件生命周期内只创建一次：useState 惰性初始化是 React 官方
  // 允许的"渲染期一次性建对象"入口（区别于 useRef.current 赋值，后者会触发
  // react-hooks/refs 规则）。initialRows 在会话内恒定，store 无需随渲染重建。
  const [store] = useState(() => new MetricsStore(initialRows));
  const [query, setQuery] = useState(filter);
  const [picks, setPicks] = useState<Record<string, number>>({});

  // 订阅排序版本：每帧最多一次父组件提交。服务端快照恒为 0（首帧水合一致）。
  useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeOrder(fn), [store]),
    () => store.getOrderVersion(),
    () => 0
  );

  // 挂载：开 SSE + 阈值同步；卸载：EventSource/interval/监听器全部清零。
  useEffect(() => {
    store.start();
    return () => store.dispose();
  }, [store]);

  // 读取排序版本（useSyncExternalStore 已在上方订阅）：版本不变时 useMemo 命中，
  // 过滤输入不引起数据层变更。
  const orderVersion = store.getOrderVersion();
  const order = useMemo(() => {
    // 引用一次以声明重算依赖：orderVersion 变化时必须重新读取 store 排序。
    void orderVersion;
    const q = query.trim().toLowerCase();
    const visibleIds = q
      ? new Set(
          METRICS.filter(
            (m) =>
              m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
          ).map((m) => m.id)
        )
      : null;
    // 每次 orderVersion 变化只重建这个含 300 个数字的索引数组并排序，
    // 不触碰行数据结构（MetricEntry 引用恒定）。
    const idx = METRICS.map((_, i) => i);
    idx.sort((a, b) => {
      const ea = store.getEntry(a);
      const eb = store.getEntry(b);
      return eb.base * eb.th - ea.base * ea.th;
    });
    return {
      idx,
      visibleIds,
      visibleCount: visibleIds
        ? idx.filter((i) => visibleIds.has(store.getEntry(i).id)).length
        : METRIC_COUNT,
    };
  }, [query, store, orderVersion]);

  useEffect(() => {
    document.title = `监控 ${order.visibleCount}`;
  }, [order.visibleCount]);

  // 滚动视觉反馈：只读 scrollY，越过边界才写 class（保留既有语义）。
  useEffect(() => {
    let scrolled = false;
    const onScroll = () => {
      const next = window.scrollY > 0;
      if (next !== scrolled) {
        scrolled = next;
        document.body.classList.toggle("scrolled", next);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.body.classList.remove("scrolled");
    };
  }, []);

  const onPick = useCallback((id: string) => {
    setPicks((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="filter"
      />
      {order.idx.map((i) => {
        const entry = store.getEntry(i);
        return (
          <Row
            key={entry.id}
            store={store}
            index={i}
            hidden={order.visibleIds ? !order.visibleIds.has(entry.id) : false}
            picked={picks[entry.id]}
            onPick={onPick}
          />
        );
      })}
    </div>
  );
}

// 图表创建调度器：300 个 new Chart 若同步执行会形成长任务，按帧切片（每帧 10ms
// 预算）摊到多帧。令牌模型天然兼容 dev StrictMode 的"子 effect 先于父 effect"
// 与 setup→cleanup→setup，无需父级批次激活：
//   - 每个 Row 挂载时生成一个 token，把创建任务连同 token 放入全局队列；
//   - 卸载/StrictMode 首挂 cleanup 时 token 作废，任务即便之后出队也是空操作；
//   - pump 每帧只执行仍存活 token 的任务；只要队列非空就续排 rAF，
//     另挂 setTimeout 作为后台标签页 rAF 暂停后的回前台保险。
type ChartJob = { token: { alive: boolean }; run: () => void };
const chartWorkQueue: ChartJob[] = [];
let rafPending = false;
let fallbackPending = false;

function pumpChartWork() {
  rafPending = false;
  const start = performance.now();
  while (chartWorkQueue.length > 0 && performance.now() - start < 10) {
    const job = chartWorkQueue.shift()!;
    if (job.token.alive) job.run();
  }
  if (chartWorkQueue.length > 0) {
    rafPending = true;
    requestAnimationFrame(pumpChartWork);
    if (!fallbackPending) {
      fallbackPending = true;
      setTimeout(() => {
        fallbackPending = false;
        if (chartWorkQueue.length > 0 && !rafPending) pumpChartWork();
      }, 250);
    }
  }
}

function scheduleChartWork(job: ChartJob) {
  chartWorkQueue.push(job);
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(pumpChartWork);
  }
}

// 行内迷你折线图保留的最近点数：新值 push、超长出队，原地 mutate chart.data。
const CHART_POINTS = 40;

type RowProps = {
  store: MetricsStore;
  index: number;
  hidden: boolean;
  picked?: number;
  onPick: (id: string) => void;
};

const Row = memo(function Row({ store, index, hidden, picked, onPick }: RowProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart<"line"> | null>(null);
  const pointsRef = useRef<number[]>([]);

  // 订阅"本行"版本：只有自己被增量帧/阈值命中时才重渲染，与其他 299 行无关。
  useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeRow(index, fn), [store, index]),
    () => store.getVersion(index),
    () => 0
  );

  const entry = store.getEntry(index);
  const value = entry.base * entry.th;

  // 生命周期内只 new 一次 Chart（按帧切片调度），卸载时 destroy。
  // 过滤（hidden）与排序都不经过本 effect：依赖数组为空，永不重跑。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    // token 与本 effect 同生命周期：cleanup（含 StrictMode 首挂）即作废，
    // 已入队但未执行的创建任务出队时变为空操作，绝不会给已销毁的 canvas 建图。
    const token = { alive: true };
    // 创建闭包捕获本次挂载渲染的 value；任务最早在下一帧执行，值已就绪，
    // 无需渲染期写 ref（react-hooks/refs 禁止在渲染中更新 ref.current）。
    scheduleChartWork({
      token,
      run: () => {
      pointsRef.current = [value];
      const chart = new Chart(el, {
        type: "line",
        data: { labels: [String(pointsRef.current.length)], datasets: [{ data: [value] }] },
        options: {
          animation: false,
          responsive: false,
          events: [],
          scales: { x: { display: false }, y: { display: false } },
        },
      });
      chartRef.current = chart;
      },
    });
    return () => {
      token.alive = false;
      chartRef.current?.destroy();
      chartRef.current = null;
      pointsRef.current = [];
    };
    // 刻意只在挂载时调度创建一次：value 仅用于首点，后续更新由下方 effect
    // 原地写入；把 value 列入依赖会在每帧重建 Chart，违背需求 2。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 本行 value 变化：原地 mutate 图表数据并 update("none")，
  // 不触碰 Chart 构造函数、不重建 canvas。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return; // 创建任务尚未轮到时跳过；创建时即以当前 value 初始化
    const pts = pointsRef.current;
    pts.push(value);
    if (pts.length > CHART_POINTS) pts.shift();
    const ds = chart.data.datasets[0].data;
    ds.length = 0;
    for (const p of pts) ds.push(p);
    chart.data.labels = pts.map((_, i) => String(i));
    chart.update("none");
  }, [value, entry.version]);

  return (
    <div className="row" style={hidden ? { display: "none" } : undefined}>
      {FMT.format(value)} · {fmtTs(entry.ts)} · {picked ?? 0}
      <button onClick={() => onPick(entry.id)}>pick</button>
      <canvas ref={canvasRef} width={80} height={24} />
    </div>
  );
});
