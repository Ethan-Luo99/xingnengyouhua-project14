import Dashboard, { type PerfRow } from "./dashboard";
import { METRICS, getInitialValues, serverNow } from "@/lib/metrics";

export default async function PerfPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  // await 动态 API（searchParams 为 Promise），本页保持请求期动态渲染（ƒ Dynamic）
  const params = await searchParams;
  const filter = typeof params.q === "string" ? params.q : "";

  // 300 个指标的重计算在服务端执行一次，结果随 RSC payload 下发：
  // 1) 客户端首屏/hydration 不再重复计算（消除 61ms 级主线程长任务）；
  // 2) SSR 与 CSR 使用同一份 value/ts，水合文本必然一致。
  const ts = serverNow();
  // getInitialValues 与 SSE 推流模块共用同一份初始权威值，首屏快照与推流起点同口径
  const initialValues = getInitialValues();
  const initialRows: PerfRow[] = METRICS.map((m, i) => ({
    id: m.id,
    name: m.name,
    base: initialValues[i],
    ts,
  }));

  return (
    <main>
      <h1>Metrics Dashboard</h1>
      <Dashboard filter={filter} initialRows={initialRows} />
    </main>
  );
}
