// /perf 页面的指标定义：300 个 compute 函数 + 2 万个采样点
import payload from "./samples.json";

export const RAW = payload.data as { v: number }[];

// 聚合结果按数据引用缓存：RAW 在模块生命周期内不变，300 个指标共享
// 同一个 Σlog(v+1)，不必每个指标、每个 tick 都重算 2 万点。
const sumLogCache = new WeakMap<{ v: number }[], number>();

function sumLog(data: { v: number }[]): number {
  let s = sumLogCache.get(data);
  if (s === undefined) {
    s = 0;
    for (const p of data) s += Math.log(p.v + 1);
    sumLogCache.set(data, s);
  }
  return s;
}

export const METRICS = Array.from({ length: 300 }, (_, i) => {
  // sin(i/97) 对每个指标是常数，定义时算一次即可
  const factor = Math.sin(i / 97);
  return {
    id: `m${i}`,
    name: `metric_${i}`,
    // th 由调用方注入（客户端读 localStorage，服务端传 null）。
    // compute 不再直接访问浏览器 API，SSR 与 CSR 口径一致。
    compute: (data: { v: number }[], th: string | null = null) =>
      (sumLog(data) / (data.length || 1)) * factor * (th ? Number(th) : 1),
  };
});
