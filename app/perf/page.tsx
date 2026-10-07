import Link from "next/link";
import Dashboard, { type PerfRow } from "./dashboard";
import { buildInitialSnapshot, METRICS } from "@/lib/metrics";

export default async function PerfPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  // await 动态 API（searchParams 为 Promise），本页保持请求期动态渲染（ƒ Dynamic）
  const params = await searchParams;
  const filter = typeof params.q === "string" ? params.q : "";

  // 300 个指标的重计算在服务端执行一次（静态 samples.json 的基线，与 SSE
  // 推流端模块初值同源），结果随 RSC payload 下发：
  // 1) 客户端首屏/hydration 零 compute；
  // 2) SSR 与 CSR 使用同一份 value/ts，水合文本必然一致；
  // 3) 首帧 SSE 前页面显示的就是推流端 seq=0 的同一组值，不存在初始跳变。
  // ts 的 Date.now 收敛到 buildInitialSnapshot 内（服务端模块函数），
  // 组件体内不直接调用非纯 API（react-hooks/purity）。
  const snap = buildInitialSnapshot();
  const initialRows: PerfRow[] = METRICS.map((m) => ({
    id: m.id,
    name: m.name,
    base: snap.values[m.id],
    ts: snap.ts,
  }));

  return (
    <main>
      <h1>Metrics Dashboard</h1>
      <p>
        <Link href="/">← Home</Link>
      </p>
      <Dashboard filter={filter} initialRows={initialRows} />
    </main>
  );
}
