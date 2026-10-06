// 生成 /perf 页面的采样数据：lib/samples.json（2 万个采样点）
// 用法：node scripts/gen-samples.mjs
import { writeFileSync, existsSync, mkdirSync } from "node:fs";

const COUNT = 20000;
const outDir = "lib";
const outFile = `${outDir}/samples.json`;

let seed = 20260927;
const rand = () => {
  // 线性同余，保证每次生成结果一致（hydration 场景需要稳定数据）
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const data = Array.from({ length: COUNT }, () => ({
  v: Number((rand() * 1000).toFixed(4)),
}));

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify({ data }), "utf8");
console.log(`written ${outFile}: ${data.length} samples`);
