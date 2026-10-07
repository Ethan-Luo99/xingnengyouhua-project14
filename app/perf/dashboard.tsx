"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CategoryScale,
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
} from "chart.js";
import type { MetricsFrame, MetricsSnapshot } from "@/lib/metrics";

// 只注册本页用到的折线图组件，其余控制器/插件可 tree-shake（替代 chart.js/auto 全量注册）
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale);

export type PerfRow = { id: string; name: string; base: number; ts: number };

type RowState = PerfRow & { th: number };

// 阈值同步周期：固定 5s。远离浏览器 4ms 嵌套定时器下限；
// 回调幂等（读 300 个阈值、无变化不 setState），后台节流只会推迟同步，不会堆积。
const TH_SYNC_MS = 5000;

// 断线重连退避：1s 起步、上限 10s，避免服务端长时间不可用时疯狂重连。
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;

// 行内图表保留的历史点数（环形缓冲）。初始 1 个点，每来一帧 push 一个点，
// 超出后丢弃最旧点；只给 Chart.js 喂定长数组，实例永不重建。
const HISTORY_LEN = 40;

const FMT = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

// localStorage 阈值系数语义保留：键仍为 th-<i>（i 为指标序号，id 为 m<i>）
function readThreshold(id: string): number {
  const raw = localStorage.getItem(`th-${id.slice(1)}`);
  return raw ? Number(raw) : 1;
}

// 图表创建调度器：300 个 new Chart 若在同一 passive-effect 阶段同步执行会形成
// 约 300ms 的单次长任务。这里按帧切片（每帧预算 10ms），把创建摊到多个帧上。
// flush 供组件卸载时同步排空：卸载要求 300 个 Chart 全部 destroy，因此那些
// "排队但尚未 new" 的任务必须立刻取消（cancelled 标记），否则会在已卸载
// canvas 上建图。
const chartWorkQueue: Array<() => void> = [];
let chartPumpScheduled = false;
function pumpChartWork() {
  const start = performance.now();
  while (chartWorkQueue.length > 0 && performance.now() - start < 10) {
    chartWorkQueue.shift()!();
  }
  if (chartWorkQueue.length > 0) {
    requestAnimationFrame(pumpChartWork);
  } else {
    chartPumpScheduled = false;
  }
}
function scheduleChartWork(fn: () => void) {
  chartWorkQueue.push(fn);
  if (!chartPumpScheduled) {
    chartPumpScheduled = true;
    requestAnimationFrame(pumpChartWork);
  }
}

// 时区无关的确定性格式：SSR 与 CSR 对同一 ts 输出同一文本（toLocaleString 随时区漂移）
function fmtTs(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// 只读自检钩子（验收用，不参与任何渲染逻辑）：
//   window.__perfChartStats() -> { created, destroyed, canvases, liveCharts }
// created 累计 new Chart 次数（任何过滤/排序往返后必须恒等于 300）；
// destroyed 累计 destroy 次数；liveCharts 为当前仍挂在 canvas 上的实例数。
const chartStats = { created: 0, destroyed: 0 };
if (typeof window !== "undefined") {
  (window as unknown as { __perfChartStats?: () => unknown }).__perfChartStats = () => ({
    created: chartStats.created,
    destroyed: chartStats.destroyed,
    canvases: document.querySelectorAll(".rows canvas").length,
    liveCharts: [...document.querySelectorAll<HTMLCanvasElement>(".rows canvas")].filter(
      (canvas) => Chart.getChart(canvas)
    ).length,
  });
}

type ConnState = "connecting" | "live" | "reconnecting";

// 校验推流数值：任何非法值（NaN/undefined/非 number）都不进状态，
// 保证断线、坏帧、半连接等任何时序下 UI 都不出现 NaN/undefined。
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export default function Dashboard({
  filter,
  initialRows,
}: {
  filter: string;
  initialRows: PerfRow[];
}) {
  // 初值 th=1：SSR 与 CSR 首帧口径一致；真实阈值挂载后由 sync 应用。
  // rows 数组的顺序永不改变（增量更新只做"切片一次 + 定点替换"），
  // 因此 id 为 m<i> 的行永远位于下标 i，行的 DOM/Chart 实例也可永久常驻。
  const [rows, setRows] = useState<RowState[]>(() =>
    initialRows.map((r) => ({ ...r, th: 1 }))
  );
  const [query, setQuery] = useState(filter);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [conn, setConn] = useState<ConnState>("connecting");

  // ---- SSE 订阅：增量应用 / 断线重连 / 重连后全量对齐，全部收敛在这一个 effect ----
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let generation = 0; // 每次（重）连接自增：使途中过期连接的帧/快照回调失效
    let backoff = RECONNECT_MIN_MS;
    // 对齐闸门：连接建立后先拉全量快照，快照落地前丢弃一切增量帧。
    // 首连也走一遍：SSR 之后服务端可能已被其他标签页推着走了若干帧，
    // 统一状态机比"首连信任 SSR"更稳，且对齐期间界面显示 SSR 的合法值。
    let aligning = true;

    const applySnapshot = (snap: MetricsSnapshot) => {
      const values = snap.values;
      // 全量对齐允许全量遍历（每 300 行重建对象仅发生在重连时刻，不在帧路径）。
      // th 必须沿用本地：服务端只推 base 绝对值，阈值系数从不属于推流口径。
      setRows((prev) =>
        prev.map((r) => {
          const v = values[r.id];
          return isFiniteNumber(v) ? { ...r, base: v, ts: snap.ts || r.ts } : r;
        })
      );
    };

    const applyFrame = (frame: MetricsFrame) => {
      const values = frame.values;
      const ids = Object.keys(values);
      if (ids.length === 0) return;
      setRows((prev) => {
        let next = prev; // 延迟到确有合法更新时才复制一次数组（不在无变化时制造提交）
        for (const id of ids) {
          const v = values[id];
          if (!isFiniteNumber(v)) continue;
          // m<i> 与数组下标的稳定映射（顺序不变式），命中不到则跳过，绝不写脏数据
          const i = Number(id.slice(1));
          const old = next[i];
          if (!old || old.id !== id) continue;
          if (next === prev) next = prev.slice();
          next[i] = { ...old, base: v, ts: frame.ts };
        }
        return next;
      });
    };

    const align = (gen: number, source: EventSource) => {
      // 重新 fetch 一次完整快照：no-store 保证不被浏览器/CDN 缓存成旧值
      fetch("/api/metrics?snapshot=1", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`snapshot ${r.status}`))))
        .then((snap: MetricsSnapshot) => {
          if (disposed || gen !== generation) return; // 已卸载或已被更新的连接取代
          applySnapshot(snap);
          aligning = false; // 快照落地后才放行增量帧
          backoff = RECONNECT_MIN_MS;
          setConn("live");
        })
        .catch(() => {
          if (disposed || gen !== generation) return;
          // 快照失败等价于连接不可用：关掉重来，走退避重连 + 再次全量对齐
          source.close();
          if (!reconnectTimer) scheduleReconnect();
        });
    };

    const scheduleReconnect = () => {
      aligning = true; // 重连成功后第一时间必须重新全量对齐
      setConn((c) => (c === "reconnecting" ? c : "reconnecting"));
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };

    const connect = () => {
      if (disposed) return;
      reconnectTimer = null;
      const gen = ++generation;
      const source = new EventSource("/api/metrics");
      es = source;

      source.onopen = () => {
        if (disposed || gen !== generation) return;
        setConn((c) => (c === "live" ? c : "connecting"));
        align(gen, source);
      };

      source.addEventListener("frame", (ev) => {
        if (disposed || gen !== generation || aligning) return;
        let frame: MetricsFrame;
        try {
          frame = JSON.parse((ev as MessageEvent<string>).data);
        } catch {
          return; // 坏帧丢弃，不污染状态
        }
        if (!frame || !frame.values || !isFiniteNumber(frame.ts)) return;
        applyFrame(frame);
      });

      // onerror 后浏览器自身也会重连，但我们需要"重连成功后第一帧前全量对齐"，
      // 该保证无法挂在原生自动重连上，因此显式 close + 自控重连状态机。
      source.onerror = () => {
        if (disposed || gen !== generation) return;
        source.close();
        // onerror 在不同浏览器/失败阶段可能触发多次；已排过重连就不再叠加定时器
        if (!reconnectTimer) scheduleReconnect();
      };
    };

    connect();

    return () => {
      // 卸载清理：关 EventSource、清退避定时器、让所有在途回调失效。
      // 300 个 Chart 的 destroy 在各 Row 自己的卸载清理里完成。
      disposed = true;
      generation++;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      es = null;
    };
  }, []);

  // 阈值同步：挂载时一次 + 固定周期 + 跨标签页 storage 事件。
  // 先读完全部阈值、确认有变化才 setRows，稳态下零提交。
  useEffect(() => {
    let current = rows.map((r) => r.th);
    const sync = () => {
      let changed = false;
      const next = current.map((th, i) => {
        const thNow = readThreshold(rows[i].id);
        if (thNow !== th) changed = true;
        return thNow;
      });
      if (!changed) return;
      current = next;
      const now = Date.now();
      setRows((prev) => prev.map((r, i) => ({ ...r, th: next[i], ts: now })));
    };
    sync();
    const id = setInterval(sync, TH_SYNC_MS);
    window.addEventListener("storage", sync);
    return () => {
      clearInterval(id);
      window.removeEventListener("storage", sync);
    };
    // rows 仅由本 effect 更新 th，initialRows 在会话内不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 过滤 + 排序不产出"行数组重排"，只产出两套与 rows 下标对齐的视图参数：
  //   order[i]  —— 该行在 flex 容器里的视觉次序（隐藏行给一个靠后的中性值即可）
  //   hidden[i] —— 是否 display:none
  // 这样无论过滤/排序如何往返，300 个 DOM 节点与 Chart 实例都原地不动。
  // 排序本身是纯数组读写，不触发任何 compute。
  const order = useMemo(() => {
    const q = query.trim().toLowerCase();
    const indexed = rows
      .map((r, i) => ({ i, score: r.base * r.th, match: q ? r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) : true }))
      .sort((a, b) => b.score - a.score);
    const orderArr = new Array<number>(rows.length);
    const hiddenArr = new Array<boolean>(rows.length);
    let visibleRank = 0;
    for (const item of indexed) {
      if (item.match) {
        orderArr[item.i] = visibleRank++;
        hiddenArr[item.i] = false;
      } else {
        // 隐藏行仍参与 order 布局但 display:none，给稳定大值避免与可见行抢位
        orderArr[item.i] = rows.length + item.i;
        hiddenArr[item.i] = true;
      }
    }
    return { order: orderArr, hidden: hiddenArr, count: visibleRank };
  }, [rows, query]);

  useEffect(() => {
    document.title = `监控 ${order.count}`;
  }, [order.count]);

  // 滚动视觉反馈：只读 scrollY（非布局属性，不触发强制回流），越过边界才写 class
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

  const connText =
    conn === "live" ? "● live" : conn === "reconnecting" ? "● reconnecting…" : "● connecting…";

  return (
    <div className="dashboard">
      <div className="toolbar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter"
        />
        <span className={`conn conn-${conn}`} title="SSE 连接状态">
          {connText}
        </span>
      </div>
      {/* 300 行永久挂载：过滤切 display:none，排序写 flex order，
          DOM 节点与 Chart 实例在任何过滤/排序往返中都不销毁、不移动重建 */}
      <div className="rows">
        {rows.map((r, i) => (
          <Row
            key={r.id}
            row={r}
            picked={picks[r.id]}
            onPick={onPick}
            order={order.order[i]}
            hidden={order.hidden[i]}
          />
        ))}
      </div>
    </div>
  );
}

type RowProps = {
  row: RowState;
  picked?: number;
  onPick: (id: string) => void;
  order: number;
  hidden: boolean;
};

const Row = memo(function Row({ row, picked, onPick, order, hidden }: RowProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart<"line"> | null>(null);
  const value = row.base * row.th;
  // 行内图表历史环形缓冲：生命周期等于行本身（行永不卸载）。
  // 初始为空，由下方"数值 effect"唯一追加；Chart 若延迟创建，创建时直接
  // 读这两个 ref 即可拿到此前已积累的历史，不丢点、也不重复建图。
  const historyRef = useRef<number[]>([]);
  const labelsRef = useRef<string[]>([]);

  // 每个 canvas 生命周期内只 new 一次 Chart（按帧切片调度），卸载时 destroy。
  // 初值取自 historyRef：同一组件内 effect 按声明顺序执行，下方的 value effect
  // 紧随其后（同步 passive 阶段）就会把首点推入 history，而建图发生在之后的
  // rAF，因此建图瞬间首点必然已在；排队期间到达的帧同样不会丢。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    let cancelled = false;
    scheduleChartWork(() => {
      if (cancelled) return;
      const chart = new Chart(el, {
        type: "line",
        data: {
          labels: [...labelsRef.current],
          datasets: [{ data: [...historyRef.current] }],
        },
        options: {
          animation: false,
          responsive: false,
          events: [],
          scales: { x: { display: false }, y: { display: false } },
        },
      });
      chartRef.current = chart;
      chartStats.created++;
    });
    return () => {
      // 卸载路径：排队任务作废 + 已建实例 destroy。Dashboard 卸载时 300 个
      // Row 同时卸载，这里保证 300 个 Chart（含尚未创建的）一个不漏地清掉。
      cancelled = true;
      if (chartRef.current) {
        chartRef.current.destroy();
        chartStats.destroyed++;
      }
      chartRef.current = null;
    };
  }, []);

  // 数值变化时原地 push 历史并 update("none")：不 new Chart、不动 canvas。
  // 阈值（th）或推流（base）任一变化都会改变 value，两路共享同一合成口径。
  useEffect(() => {
    const hist = historyRef.current;
    const labels = labelsRef.current;
    hist.push(value);
    labels.push(String(labels.length));
    if (hist.length > HISTORY_LEN) {
      hist.shift();
      labels.shift();
    }
    const chart = chartRef.current;
    if (!chart) return; // 仍在创建队列中：建图时会读到已积累的 history
    // 拷贝后赋给 chart，再继续在 ref 数组上 push，避免 Chart 持有被原地改写的数组
    chart.data.labels = [...labels];
    chart.data.datasets[0].data = [...hist];
    chart.update("none");
  }, [value]);

  return (
    <div className="row" style={{ order, display: hidden ? "none" : undefined }}>
      {FMT.format(value)} · {fmtTs(row.ts)} · {picked ?? 0}
      <button onClick={() => onPick(row.id)}>pick</button>
      <canvas ref={canvasRef} width={80} height={24} />
    </div>
  );
});
