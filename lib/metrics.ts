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
