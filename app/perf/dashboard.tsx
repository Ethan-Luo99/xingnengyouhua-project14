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

// 只注册本页用到的折线图组件，其余控制器/插件可 tree-shake（替代 chart.js/auto 全量注册）
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale);

export type PerfRow = { id: string; name: string; base: number; ts: number };

type RowState = PerfRow & { th: number };

// 阈值同步周期：固定 5s。远离浏览器 4ms 嵌套定时器下限；
// 回调幂等（读 300 个阈值、无变化不 setState），后台节流只会推迟同步，不会堆积。
const TH_SYNC_MS = 5000;

const FMT = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

// localStorage 阈值系数语义保留：键仍为 th-<i>（i 为指标序号，id 为 m<i>）
function readThreshold(id: string): number {
  const raw = localStorage.getItem(`th-${id.slice(1)}`);
  return raw ? Number(raw) : 1;
}

// 图表创建调度器：300 个 new Chart 若在同一 passive-effect 阶段同步执行会形成
// 约 300ms 的单次长任务。这里按帧切片（每帧预算 10ms），把创建摊到多个帧上。
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

export default function Dashboard({
  filter,
  initialRows,
}: {
  filter: string;
  initialRows: PerfRow[];
}) {
  // 初值 th=1：SSR 与 CSR 首帧口径一致；真实阈值挂载后由 sync 应用
  const [rows, setRows] = useState<RowState[]>(() =>
    initialRows.map((r) => ({ ...r, th: 1 }))
  );
  const [query, setQuery] = useState(filter);
  const [picks, setPicks] = useState<Record<string, number>>({});

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

  // 过滤（接通输入框）+ 排序：只依赖 rows/query，不触发任何 compute
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)
        )
      : rows;
    return [...filtered].sort((a, b) => b.base * b.th - a.base * a.th);
  }, [rows, query]);

  useEffect(() => {
    document.title = `监控 ${visible.length}`;
  }, [visible.length]);

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

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="filter"
      />
      {visible.map((r) => (
        <Row key={r.id} row={r} picked={picks[r.id]} onPick={onPick} />
      ))}
    </div>
  );
}

type RowProps = {
  row: RowState;
  picked?: number;
  onPick: (id: string) => void;
};

const Row = memo(function Row({ row, picked, onPick }: RowProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart<"line"> | null>(null);
  const value = row.base * row.th;
  const valueRef = useRef(value);
  valueRef.current = value;

  // 每个 canvas 生命周期内只 new 一次 Chart（按帧切片调度），卸载时 destroy
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    let cancelled = false;
    scheduleChartWork(() => {
      if (cancelled) return;
      const chart = new Chart(el, {
        type: "line",
        data: { labels: [row.id], datasets: [{ data: [valueRef.current] }] },
        options: {
          animation: false,
          responsive: false,
          events: [],
          scales: { x: { display: false }, y: { display: false } },
        },
      });
      chartRef.current = chart;
    });
    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // 仅挂载/卸载时执行；数据变化由下方 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数值变化时原地更新图表数据（不重建实例）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.data.datasets[0].data = [value];
    chart.update("none");
  }, [value]);

  return (
    <div className="row">
      {FMT.format(value)} · {fmtTs(row.ts)} · {picked ?? 0}
      <button onClick={() => onPick(row.id)}>pick</button>
      <canvas ref={canvasRef} width={80} height={24} />
    </div>
  );
});
