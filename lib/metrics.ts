// /perf 页面的指标定义：300 个 compute 函数 + 2 万个采样点
//
// 本文件同时被 app/perf/page.tsx（RSC）与 app/api/metrics/route.ts（Route Handler）
// 引用，故除 compute 与常量外只放"纯数据/纯类型"：不触碰 localStorage / window /
// document，任何运行时导入都安全。
import payload from "./samples.json";

export const RAW = payload.data;

export const METRIC_COUNT = 300;
export const METRICS = Array.from({ length: METRIC_COUNT }, (_, i) => ({
  id: `m${i}`,
  name: `metric_${i}`,
  compute: (data: { v: number }[]) => {
    let s = 0;
    for (const p of data) s += Math.log(p.v + 1) * Math.sin(i / 97);
    return s / (data.length || 1);
  },
}));

// 指标 id -> 稳定序号，服务端推流与客户端 store 都按序号定位，避免每帧 find。
export const METRIC_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  METRICS.map((m, i) => [m.id, i])
);

// 静态基线：samples.json 不变即不变。SSR 初值（page.tsx）与推流端初始状态
// （route.ts）都从这里取数，保证"页面初始快照"与"SSE 全量对齐快照"同源。
export const INITIAL_BASES: number[] = METRICS.map((m) => m.compute(RAW));

// SSR 首屏快照（seq=0、全量 300 项、单一 ts）。page.tsx 与推流端初始世界状态
// 共用同一构造口径；唯一的非纯调用 Date.now 收敛在此模块函数内。
export function buildInitialSnapshot(): MetricsSnapshot {
  const ts = Date.now();
  const values: Record<string, number> = {};
  for (let i = 0; i < METRIC_COUNT; i++) values[METRICS[i].id] = INITIAL_BASES[i];
  return { seq: 0, ts, values };
}

// SSE 增量帧：values 只覆盖本帧发生变化的指标（30~80 个）。
export type MetricsFrame = {
  seq: number;
  ts: number;
  values: Record<string, number>;
};

// 全量快照：重连对齐 / 首连对齐使用，覆盖全部 300 个指标。
export type MetricsSnapshot = {
  seq: number;
  ts: number;
  values: Record<string, number>;
};

// SSE 每帧变化指标数范围（服务端推流与客户端校验共用同一口径）。
export const FRAME_MIN = 30;
export const FRAME_MAX = 80;
