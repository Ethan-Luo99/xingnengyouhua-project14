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
import { METRICS, RAW } from "@/lib/metrics";

// 只注册本页用到的组件，替代 chart.js/auto 的全量注册（可被 tree-shake）
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale);

// 固定刷新周期：单一 interval、随组件卸载清理，替代 tick 自增 + 1000/(tick+1)
const REFRESH_MS = 8000;

// Chart 构造/更新全部经此队列分片执行（每片一个宏任务，浏览器可在片间
// 穿插渲染与输入处理），避免 300 个图表在同一主线程任务里同步构造
// （实测未分片时首屏长任务 236ms + 82ms）
const CHART_JOB_BUDGET_MS = 5;
const chartJobQueue: Array<() => void> = [];
let chartFlushScheduled = false;

function flushChartJobs() {
  const start = performance.now();
  while (chartJobQueue.length > 0 && performance.now() - start < CHART_JOB_BUDGET_MS) {
    chartJobQueue.shift()!();
  }
  if (chartJobQueue.length > 0) {
    setTimeout(flushChartJobs, 0);
  } else {
    chartFlushScheduled = false;
  }
}

function enqueueChartJob(job: () => void) {
  chartJobQueue.push(job);
  if (!chartFlushScheduled) {
    chartFlushScheduled = true;
    setTimeout(flushChartJobs, 0);
  }
}

// 模块级共享，避免每次渲染重建
const numberFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
// 显式 locale + 时区：SSR(Node) 与 CSR(浏览器) 的默认 locale/时区可能不同，
// 不定死会在水合时产生文本不一致（React #519 的来源之一）
const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

type RowData = { id: string; name: string; value: number; ts: number };

// 首帧（SSR 与水合）专用：th 全 null（系数 1）、ts 固定为 0，
// 保证服务端与客户端首次渲染输出逐字节一致
function computeInitialRows(): RowData[] {
  return METRICS.map((m) => ({ id: m.id, name: m.name, value: m.compute(RAW, null), ts: 0 }));
}

// 仅在客户端事件上下文（mount effect / interval 回调）中调用
function readThresholds(): (string | null)[] {
  return METRICS.map((_, i) => localStorage.getItem(`th-${i}`));
}

function computeRows(ths: (string | null)[]): RowData[] {
  const now = Date.now();
  return METRICS.map((m, i) => ({
    id: m.id,
    name: m.name,
    value: m.compute(RAW, ths[i]),
    ts: now,
  }));
}

export default function Dashboard({ filter }: { filter: string }) {
  // 惰性初始化：初值只在首次渲染计算一次，不会随重渲染重复求值
  const [rows, setRows] = useState<RowData[]>(computeInitialRows);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [query, setQuery] = useState(filter);
  const lastScrollAt = useRef(0);

  // 挂载后接入 localStorage 阈值语义：仅当确实存在 th-* 键时才重算，
  // 否则首帧（th=null 口径）已是正确值，不再产生多余提交。
  useEffect(() => {
    const ths = readThresholds();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 水合后一次性同步外部存储（localStorage），是有意的单次级联
    if (ths.some((th) => th !== null)) setRows(computeRows(ths));
  }, []);

  // 单一固定周期定时器：创建一次、卸载清理，不随渲染重复注册
  useEffect(() => {
    const id = setInterval(() => {
      setRows(computeRows(readThresholds()));
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // 标题随数据刷新持续维护（Next 会在水合完成时按 metadata 重置一次标题，
  // 只在挂载时写一次会被覆盖）；不再写入 Math.random() 噪声
  useEffect(() => {
    document.title = `监控 ${rows.length}`;
  }, [rows]);

  useEffect(() => {
    const onScroll = () => {
      // 保留滚动监听，但不再读 offsetHeight 强制同步布局
      lastScrollAt.current = Date.now();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // rows 每次刷新都是新引用，浅拷贝后排序即可（不再 JSON 深拷贝）
  const sorted = useMemo(() => [...rows].sort((a, b) => b.value - a.value), [rows]);

  const onPick = useCallback((id: string) => {
    // setState 触发当次渲染即更新 UI，替代只改模块变量等下次渲染
    setPicks((p) => ({ ...p, [id]: (p[id] ?? 0) + 1 }));
  }, []);

  const q = query.trim().toLowerCase();

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="过滤指标…"
      />
      {sorted.map((r) => (
        <Row
          key={r.id}
          row={r}
          picked={picks[r.id]}
          onPick={onPick}
          hidden={q !== "" && !`${r.id} ${r.name}`.toLowerCase().includes(q)}
        />
      ))}
    </div>
  );
}

type RowProps = {
  row: RowData;
  picked?: number;
  onPick: (id: string) => void;
  hidden: boolean;
};

const Row = memo(function Row({ row, picked, onPick, hidden }: RowProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart<"line"> | null>(null);
  const valueRef = useRef(row.value);

  // 每个 canvas 只构造一次 Chart（卸载时 destroy），不再每次渲染重绑；
  // 构造经队列分片，避免 300 个实例挤爆单个主线程任务
  useEffect(() => {
    let cancelled = false;
    enqueueChartJob(() => {
      if (cancelled) return;
      const el = canvasRef.current;
      if (!el) return;
      const chart = new Chart(el, {
        type: "line",
        data: { labels: [row.id], datasets: [{ data: [valueRef.current] }] },
        options: {
          animation: false,
          responsive: false,
          events: [],
          scales: {
            x: { display: false, ticks: { display: false } },
            y: { display: false, ticks: { display: false } },
          },
        },
      });
      chartRef.current = chart;
    });
    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [row.id]);

  // 数据随行更新：排序/刷新后复用既有实例，update 而非 new。
  // 图表尚未由分片任务创建时跳过——创建时会直接采用 valueRef 最新值。
  useEffect(() => {
    // 分片任务执行前同步最新值（effect 先于 setTimeout 任务运行）
    valueRef.current = row.value;
    enqueueChartJob(() => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.data.datasets[0].data = [row.value];
      chart.update("none");
    });
  }, [row.value]);

  return (
    <div className="row" style={hidden ? { display: "none" } : undefined}>
      {numberFmt.format(row.value)} · {timeFmt.format(row.ts)} · {picked}
      <button onClick={() => onPick(row.id)}>pick</button>
      <canvas ref={canvasRef} width={80} height={24} />
    </div>
  );
});
