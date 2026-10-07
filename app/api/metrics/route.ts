// 指标实时数据源（SSE）。
//
// 两种用法（同一路由，GET）：
//   GET /api/metrics            -> text/event-stream，每 1000ms 一帧增量
//   GET /api/metrics?snapshot=1 -> application/json，一次性全量快照（300 个）
//
// 实现约束：
//   - 仅用 Web 标准 ReadableStream / setInterval，无任何新增依赖；
//   - 推流状态（bases/seq）是模块级单例：所有连接共享同一条随机游走序列，
//     这样"重连后拉到的快照"与"断线期间错过的增量"在同一 seq 坐标系内，
//     客户端按 seq 去重即可严格对齐；
//   - ticker 按订阅者引用计数懒启动/停止，无连接时不做任何 CPU 工作；
//   - force-dynamic：本路由依赖运行时随机状态，禁止预渲染/缓存。
import {
  FRAME_MAX,
  FRAME_MIN,
  INITIAL_BASES,
  METRICS,
  METRIC_COUNT,
  type MetricsFrame,
  type MetricsSnapshot,
} from "@/lib/metrics";

export const dynamic = "force-dynamic";

// 默认 1000ms/帧（契约）。TICK_MS 允许由环境变量 METRICS_TICK_MS 覆盖，
// 仅供压测（自检 b：100ms/帧时客户端瓶颈定位），生产不设置即为 1000。
const TICK_MS = (() => {
  const n = Number(process.env.METRICS_TICK_MS);
  return Number.isFinite(n) && n >= 50 ? n : 1000;
})();
const HEARTBEAT_MS = 15_000;

type Subscriber = (chunk: string) => void;

// ---- 模块级共享推流状态 ----------------------------------------------------
const bases: number[] = [...INITIAL_BASES];
let seq = 0;
const subscribers = new Set<Subscriber>();
let ticker: ReturnType<typeof setInterval> | null = null;

function startTicker() {
  if (ticker) return;
  ticker = setInterval(tick, TICK_MS);
  // 不阻止进程退出（HTTP server 本身会保活 event loop，这里只是防御）。
  ticker.unref?.();
}

function stopTicker() {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

function addSubscriber(fn: Subscriber) {
  subscribers.add(fn);
  startTicker();
}

function removeSubscriber(fn: Subscriber) {
  subscribers.delete(fn);
  if (subscribers.size === 0) stopTicker();
}

// 每 tick：随机选 30~80 个不同指标做小幅随机游走，只广播变化项。
function tick() {
  const count = FRAME_MIN + Math.floor(Math.random() * (FRAME_MAX - FRAME_MIN + 1));
  const chosen = new Set<number>();
  while (chosen.size < count) {
    chosen.add(Math.floor(Math.random() * METRIC_COUNT));
  }

  const values: Record<string, number> = {};
  for (const i of chosen) {
    const next = bases[i] + (Math.random() - 0.5) * 0.5;
    // 保留 4 位小数：线宽足够，且显著减小每帧 JSON 体积。
    bases[i] = Math.round(next * 10_000) / 10_000;
    values[METRICS[i].id] = bases[i];
  }
  seq += 1;

  const frame: MetricsFrame = { seq, ts: Date.now(), values };
  const chunk = `data: ${JSON.stringify(frame)}\n\n`;
  // subscriber 自身负责在写入失败时退订（见 GET 内 closed 标记）。
  subscribers.forEach((fn) => fn(chunk));
}

function buildSnapshot(): MetricsSnapshot {
  const values: Record<string, number> = {};
  for (let i = 0; i < METRIC_COUNT; i++) values[METRICS[i].id] = bases[i];
  return { seq, ts: Date.now(), values };
}

export function GET(request: Request) {
  const url = new URL(request.url);

  // 全量快照：首连与重连对齐都走这里。JSON 响应，不占用订阅引用计数。
  if (url.searchParams.get("snapshot") === "1") {
    return Response.json(buildSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 对端已关闭：标记并退订，stopTicker 在最后一个连接离开时执行。
          closed = true;
          removeSubscriber(send);
          if (heartbeat !== null) clearInterval(heartbeat);
        }
      };

      addSubscriber(send);
      // 注释行立即冲刷：让客户端/代理立刻收到响应头与首字节，确认链路建立；
      // EventSource 会忽略不以 data: 开头的注释帧。
      send(": connected\n\n");

      // 心跳：防中间代理静默掐断空闲连接（增量帧本身 1s 一帧，心跳是兜底）。
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      heartbeat.unref?.();

      const close = () => {
        if (closed) return;
        closed = true;
        removeSubscriber(send);
        if (heartbeat !== null) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // controller 可能已因异常关闭，忽略。
        }
      };
      // 客户端主动断开（EventSource.close / 标签页关闭）。
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
