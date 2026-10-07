// SSE 验收脚本：仅使用 Node 原生模块（http/https/URL）。
//
// 用法：
//   node verify.mjs                      # 默认 http://localhost:3000
//   node verify.mjs http://localhost:3120
//   BASE_URL=http://x node verify.mjs
//   DURATION_MS=20000 node verify.mjs
//
// 行为：连接 /api/metrics SSE，采集 DURATION_MS（默认 10s）内的数据帧，
// 打印帧数、每帧 values 数量分布、seq 连续性，并校验 30~80 的契约。
import http from "node:http";
import https from "node:https";

const base = process.argv[2] || process.env.BASE_URL || "http://localhost:3000";
const durationMs = Number(process.env.DURATION_MS || 10_000);
const target = new URL("/api/metrics", base);

const lib = target.protocol === "https:" ? https : http;
const startedAt = Date.now();

const req = lib.get(
  target,
  {
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
  },
  (res) => {
    const contentType = res.headers["content-type"] || "";
    if (res.statusCode !== 200 || !contentType.includes("text/event-stream")) {
      console.error(
        `连接失败: status=${res.statusCode} content-type=${contentType}`
      );
      res.resume();
      process.exit(1);
    }
    console.log(
      `已连接 ${target.href}（status=${res.statusCode}, ${contentType}）`
    );

    let buffer = "";
    let commentCount = 0;
    let badFrameCount = 0;
    const sizes = [];
    const seqList = [];
    const firstTs = [0, 0];

    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      let sep;
      // SSE 事件以空行（\n\n）分隔
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = [];
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith(":")) {
            commentCount += 1;
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length === 0) continue;
        let frame;
        try {
          frame = JSON.parse(dataLines.join("\n"));
        } catch {
          badFrameCount += 1;
          continue;
        }
        const n = frame.values ? Object.keys(frame.values).length : 0;
        sizes.push(n);
        seqList.push(frame.seq);
        if (firstTs[0] === 0) firstTs[0] = Date.now() - startedAt;
      }
    });

    const finish = () => {
      req.destroy();
      const elapsed = Date.now() - startedAt;
      console.log(`\n采集时长: ${elapsed}ms（期望约 ${durationMs}ms）`);
      console.log(`注释帧（connected/ping）: ${commentCount}`);
      console.log(`坏帧数: ${badFrameCount}`);
      console.log(`数据帧总数: ${sizes.length}`);
      if (sizes.length === 0) {
        console.error("未收到任何数据帧");
        process.exit(1);
      }

      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
      console.log(`每帧 values 数量: min=${min} max=${max} avg=${avg.toFixed(1)}`);

      // 分桶分布（30-39, 40-49, ..., 70-79, 80）
      const buckets = new Map();
      for (const n of sizes) {
        const b = Math.min(80, Math.floor(n / 10) * 10);
        buckets.set(b, (buckets.get(b) || 0) + 1);
      }
      console.log("数量分布（每桶 10）:");
      for (const b of [...buckets.keys()].sort((a, b2) => a - b2)) {
        console.log(`  ${b}-${b === 80 ? 80 : b + 9}: ${buckets.get(b)} 帧`);
      }

      // seq 连续性：首帧之后应严格 +1
      let gaps = 0;
      for (let i = 1; i < seqList.length; i++) {
        if (seqList[i] !== seqList[i - 1] + 1) gaps += 1;
      }
      console.log(`seq 区间: ${seqList[0]}..${seqList.at(-1)}，非连续跳变 ${gaps} 处`);

      const inRange = sizes.every((n) => n >= 30 && n <= 80);
      console.log(
        `契约校验: 每帧 30~80 个变化指标 -> ${inRange ? "PASS" : "FAIL"}`
      );
      process.exit(inRange ? 0 : 1);
    };

    setTimeout(finish, durationMs).unref();
  }
);

req.on("error", (err) => {
  console.error(`请求出错: ${err.message}`);
  console.error("请先启动服务，例如: npm run build && npm run start");
  process.exit(1);
});
