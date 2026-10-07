// /api/metrics —— 实时指标数据源
//
// 两种用法（同一路由，零新增依赖，仅用 Web ReadableStream 原语）：
//   GET /api/metrics              -> SSE 长连接，event: frame，每 1000ms 一帧增量
//   GET /api/metrics?snapshot=1  -> 一次性 JSON 全量快照（重连对齐用）
//
// 设计动机：
// 1) runtime 显式声明 nodejs：模块级的"权威值数组 + 单 tick 定时器"必须跨请求
//    共享；edge runtime 已废弃且模块实例语义不同。
// 2) force-dynamic：Math.random / Date.now / 长连接都是非确定性操作，显式关闭
//    任何预渲染/缓存企图，保证每个请求拿到真实流。
// 3) 引用计数的单 tick：没有订阅者时不跑定时器（省 CPU、也避免无客户端时状态
//    空跑）；首个 SSE 连接接入时启动，最后一个断开时停止。快照请求不计数。
// 4) 服务端状态只有"初始 compute 值 + 后续随机游走增量"，compute 从不在帧
//    路径执行；帧 values 绝对口径与 SSR 的 base 一致，客户端可直接覆盖。
import {
  FRAME_INTERVAL_MS,
  FRAME_MAX_CHANGED,
  FRAME_MIN_CHANGED,
  METRIC_COUNT,
  METRICS,
  getInitialValues,
  type MetricsFrame,
  type MetricsSnapshot,
} from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- 模块级权威状态（nodejs runtime 内跨请求共享） ----

let values: number[] | null = null;
let lastTs = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
const subscribers = new Set<(frame: MetricsFrame) => void>();

// Fisher–Yates 局部洗牌：每帧要挑 30~80 个"互不重复"的指标 id。
// 复用同一张索引表，只洗前 n 位即可，避免每帧分配 300 长度数组。
const indexPool = Array.from({ length: METRIC_COUNT }, (_, i) => i);
function pickChangedIndices(n: number): number[] {
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (METRIC_COUNT - i));
    const tmp = indexPool[i];
    indexPool[i] = indexPool[j];
    indexPool[j] = tmp;
  }
  return indexPool.slice(0, n);
}

// 随机游走：以初始 compute 值为锚做均值回归，防止长期单边漂移到 0 或爆炸。
function walkOnce(current: number[], initial: number[], ts: number): MetricsFrame {
  const count =
    FRAME_MIN_CHANGED +
    Math.floor(Math.random() * (FRAME_MAX_CHANGED - FRAME_MIN_CHANGED + 1));
  const frameValues: Record<string, number> = {};
  for (const idx of pickChangedIndices(count)) {
    const anchor = initial[idx];
    // 30% 拉回锚点 + 小幅噪声；噪声尺度按锚点绝对值缩放（锚点为 0 时退化为 ±0.02）
    const noise = (Math.random() - 0.5) * 0.04 * (Math.abs(anchor) || 1);
    const next = anchor + (current[idx] - anchor) * 0.7 + noise;
    current[idx] = next;
    frameValues[METRICS[idx].id] = Number(next.toFixed(4));
  }
  return { ts, values: frameValues };
}

function ensureStarted() {
  if (!values) values = [...getInitialValues()];
  if (timer) return;
  timer = setInterval(() => {
    if (subscribers.size === 0 || !values) return;
    lastTs = Date.now();
    const frame = walkOnce(values, getInitialValues(), lastTs);
    // 拷贝一份订阅者集合：回调内可能立即 unsubscribe（连接断开），
    // 直接遍历 Set 边删边发依赖实现细节，显式快照更稳。
    for (const push of [...subscribers]) push(frame);
  }, FRAME_INTERVAL_MS);
  // 测试/脚本场景父进程退出时不被空转定时器拖住
  timer.unref?.();
}

function stopIfIdle() {
  if (refCount === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function buildSnapshot(): MetricsSnapshot {
  if (!values) values = [...getInitialValues()];
  const all: Record<string, number> = {};
  for (let i = 0; i < METRIC_COUNT; i++) all[METRICS[i].id] = values[i];
  return { ts: lastTs || Date.now(), values: all };
}

const sseHeaders: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // 禁止任何代理/缓冲层攒批；SSE 需要逐帧直达客户端
  "X-Accel-Buffering": "no",
};

function encodeSSE(frame: MetricsFrame): Uint8Array {
  return new TextEncoder().encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
}

export function GET(request: Request): Response {
  const url = new URL(request.url);

  // ---- 全量快照分支：普通 JSON，一次请求即结束 ----
  if (url.searchParams.get("snapshot") === "1") {
    return Response.json(buildSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // ---- SSE 分支 ----
  const encoder = new TextEncoder();
  // 让 cancel() 能调到 start() 里创建的幂等清理函数
  const cleanupRef: { current: null | (() => void) } = { current: null };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ensureStarted();
      refCount++;

      // 接入即发一条注释行（retry 提示 + 初始字节）：
      // 让 curl/客户端立刻看到响应头与流存活；retry 只是给 EventSource 的建议，
      // 客户端另有显式重连逻辑兜底。
      try {
        controller.enqueue(encoder.encode(`: connected\nretry: 1000\n\n`));
      } catch {
        // controller 可能在 enqueue 前就已关闭，交给 cancel 路径处理
      }

      let cleaned = false;
      // 唯一清理入口：客户端断开时 abort 与 stream cancel 可能先后都触发，
      // 必须幂等（cleaned 守卫 + Set.delete 结果双重保险），否则引用计数
      // 会被扣成负数，导致"有订阅者却停了定时器"或计数永远归零不了。
      const teardown = () => {
        if (cleaned) return;
        cleaned = true;
        subscribers.delete(push);
        refCount--;
        stopIfIdle();
        try {
          controller.close();
        } catch {
          // 重复 close 忽略
        }
      };

      const push = (frame: MetricsFrame) => {
        try {
          controller.enqueue(encodeSSE(frame));
        } catch {
          // 下游已关闭：取消订阅即可，不能让一个坏连接炸掉整轮 tick
          teardown();
        }
      };
      subscribers.add(push);

      request.signal.addEventListener("abort", teardown, { once: true });
      cleanupRef.current = teardown;
    },
    cancel() {
      // 客户端主动断开（EventSource.close / 浏览器销毁请求）。
      // 与 abort 走同一个幂等清理，不在这里重复扣计数。
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
  });

  return new Response(stream, { headers: sseHeaders });
}
