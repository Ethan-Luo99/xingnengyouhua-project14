// SSE 自检脚本：仅使用 Node 原生模块（http/URL），无任何外部依赖。
//
// 用法：
//   node verify.mjs                # 默认 http://localhost:3000
//   node verify.mjs http://host:3001
//   DURATION_MS=10000 node verify.mjs
//
// 行为：连接 /api/metrics 的 SSE，收集 DURATION_MS（默认 10s）内的全部
// event: frame，打印：帧数、每帧 values 数量分布（直方图 + min/max/avg）、
// 帧间隔分布，以及首帧示例。连接前会先 GET 一次 ?snapshot=1 校验全量快照
// （应含 300 个值）。
import http from "node:http";

const BASE = process.argv[2]?.replace(/\/$/, "") || "http://localhost:3000";
const DURATION_MS = Number(process.env.DURATION_MS || 10000);
const EXPECTED_METRICS = 300;

function get(path, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${path}`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${path} -> HTTP ${res.statusCode}`));
        return;
      }
      if (json) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body)));
      } else {
        resolve(res);
      }
    });
    req.on("error", reject);
  });
}

// 极简 SSE 分帧解析器：按空行分隔事件，收集 data: 行
function parseSSEChunks(stream, onFrame) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = rawEvent
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length === 0) continue; // 注释行/重试行，忽略
      try {
        onFrame(JSON.parse(dataLines.join("\n")));
      } catch {
        // 服务端不应发出坏 JSON；遇到则丢弃并统计交给上层
      }
    }
  });
}

const histogram = new Map();
const gapHistogram = new Map();
let frames = 0;
let totalValues = 0;
let minValues = Infinity;
let maxValues = 0;
let firstFrame = null;
let lastTs = null;

const started = Date.now();
console.log(`[verify] GET ${BASE}/api/metrics?snapshot=1 (全量快照)`);
const snap = await get("/api/metrics?snapshot=1", { json: true });
const snapCount = Object.keys(snap.values).length;
console.log(
  `[verify] 快照 ts=${snap.ts} values=${snapCount}（期望 ${EXPECTED_METRICS}）`
);
if (snapCount !== EXPECTED_METRICS) {
  console.error("[verify] 快照值数量不符，终止");
  process.exit(1);
}

console.log(`[verify] 连接 SSE /api/metrics，采集 ${DURATION_MS}ms …`);
const stream = await get("/api/metrics");
parseSSEChunks(stream, (frame) => {
  if (!frame || typeof frame.ts !== "number" || !frame.values) return;
  frames++;
  const n = Object.keys(frame.values).length;
  totalValues += n;
  minValues = Math.min(minValues, n);
  maxValues = Math.max(maxValues, n);
  histogram.set(n, (histogram.get(n) || 0) + 1);
  if (lastTs !== null) {
    const gap = frame.ts - lastTs;
    gapHistogram.set(gap, (gapHistogram.get(gap) || 0) + 1);
  }
  lastTs = frame.ts;
  if (!firstFrame) firstFrame = frame;
});

await new Promise((r) => setTimeout(r, DURATION_MS));
stream.destroy();

const elapsed = Date.now() - started;
console.log("");
console.log("========== SSE 采集结果 ==========");
console.log(`采集窗口         : ${DURATION_MS}ms（实际 ${elapsed}ms）`);
console.log(`收到帧数         : ${frames}`);
if (frames === 0) {
  console.error("[verify] 未收到任何帧，判定失败");
  process.exit(1);
}
console.log(
  `每帧 values 数量 : min=${minValues} max=${maxValues} avg=${(
    totalValues / frames
  ).toFixed(1)}（期望区间 30~80）`
);
console.log("values 数量直方图（数量 => 帧数）:");
for (const n of [...histogram.keys()].sort((a, b) => a - b)) {
  console.log(`  ${String(n).padStart(3)} => ${histogram.get(n)}`);
}
console.log("帧间隔(ms)直方图（间隔 => 次数，期望集中在 1000）:");
for (const g of [...gapHistogram.keys()].sort((a, b) => a - b)) {
  console.log(`  ${String(g).padStart(5)} => ${gapHistogram.get(g)}`);
}
const sampleEntries = Object.entries(firstFrame.values).slice(0, 5);
console.log(
  `首帧示例         : ts=${firstFrame.ts} values 前 5 项 =`,
  Object.fromEntries(sampleEntries)
);

const inRange = minValues >= 30 && maxValues <= 80;
console.log("");
console.log(
  inRange
    ? "[verify] PASS：帧在推流，且每帧变化数落在 30~80 区间"
    : "[verify] WARN：存在帧的 values 数量超出 30~80"
);
process.exit(inRange ? 0 : 2);
