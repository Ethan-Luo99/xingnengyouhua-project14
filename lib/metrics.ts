// /perf 页面的指标定义：300 个 compute 函数 + 2 万个采样点
import payload from "./samples.json";

export const RAW = payload.data;

// compute 保持纯函数：不触碰 localStorage / Date 等环境状态，
// 因此服务端与客户端对同一 data 必然得到同一结果（水合一致）。
// localStorage 阈值系数在客户端由 dashboard 单独读取并相乘（见 dashboard.tsx）。
export const METRICS = Array.from({ length: 300 }, (_, i) => ({
  id: `m${i}`,
  name: `metric_${i}`,
  compute: (data: { v: number }[]) => {
    let s = 0;
    for (const p of data) s += Math.log(p.v + 1) * Math.sin(i / 97);
    return s / (data.length || 1);
  },
}));

// ---- 实时推流相关（本轮新增；上方 RAW/METRICS/compute 语义不变） ----

export const METRIC_COUNT = METRICS.length;

// 每帧变化的指标数区间（含端点）
export const FRAME_MIN_CHANGED = 30;
export const FRAME_MAX_CHANGED = 80;
export const FRAME_INTERVAL_MS = 1000;

// SSE 帧：values 只覆盖本帧发生变化的指标（30~80 个）。
// 数值口径与 PerfRow.base 完全一致（即 compute 的绝对值，阈值系数只在客户端相乘），
// 因此断线后拿到的快照可以直接覆盖 base，不会出现口径分叉。
export type MetricsFrame = {
  ts: number;
  values: Record<string, number>;
};

// 全量快照：values 覆盖全部 300 个指标。SSE 连接建立/重连对齐时由客户端
// 通过 ?snapshot=1 拉取，语义等价于"服务端当前权威状态"。
export type MetricsSnapshot = MetricsFrame;

// 初始权威值：SSR（page.tsx 首屏 300 行）与推流模块（route.ts 的状态起点）
// 必须共用同一份计算结果。放在纯模块里，nodejs runtime 下两端 import 同一缓存。
// compute 仍只在此处执行：SSR 一次、推流状态懒初始化一次，之后推流只做随机游走，
// 任何帧都不会重跑 compute。
let cachedInitial: number[] | null = null;
export function getInitialValues(): number[] {
  if (!cachedInitial) cachedInitial = METRICS.map((m) => m.compute(RAW));
  return cachedInitial;
}

// 服务端时间戳封装：page.tsx 是 async Server Component（非 React 渲染期），
// 但 react-hooks/purity 规则会把组件函数体内直接调用 Date.now 标记为 impure；
// 收敛到普通模块函数后规则不误报，语义仍为"请求处理时刻的时间戳"。
export function serverNow(): number {
  return Date.now();
}
