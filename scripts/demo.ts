/**
 * 端到端演示：
 *  1) 同一张图在“无保护 / 有保护”下的首条垂直接缝路线差异；
 *  2) 同一缩小目标在 width-first 与 height-first 下的路线与产物差异；
 *  3) 用已保存接缝独立重放并逐像素核验、保护核验；
 *  4) 关闭并重新打开数据库（模拟服务重启）后复核原报告。
 * 运行: npm run demo
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeamCarveService } from "../src/service.js";
import { Store } from "../src/store/store.js";

function label(path: number[]): string {
  return "[" + path.join(",") + "]";
}

function printGrid(title: string, pixels: number[][]): void {
  console.log(`\n${title} (${pixels[0]!.length}x${pixels.length})`);
  for (const row of pixels) console.log("  " + row.map((v) => String(v).padStart(3)).join(" "));
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "seamcarve-demo-"));
  const dbFile = join(dir, "demo.db");
  console.log(`数据目录（临时）: ${dir}`);

  // 7x7：第 2、3 列是平滑低能量“走廊”（恒定 50），两侧是黑白棋盘高能量纹理。
  // 无保护时接缝被走廊吸引而穿过第 3 列；把第 2、3 列设为保护后，接缝被迫沿右侧纹理绕行。
  const pixels = Array.from({ length: 7 }, (_, r) =>
    Array.from({ length: 7 }, (_, c) =>
      c === 2 || c === 3 ? 50 : (r + c) % 2 === 0 ? 0 : 255,
    ),
  );
  // 保护中央 2 列高能量核心（第 2、3 列）
  const protectMask = pixels.map((row) => row.map((_, c) => (c === 2 || c === 3 ? 1 : 0)));

  let store = new Store(dbFile);
  const service = new SeamCarveService(store);

  const plain = service.importImage({ pixels });
  const guarded = service.importImage({ pixels, protectMask });

  const seamPlain = service.findOneSeam(plain.imageId, "vertical").seam;
  const seamGuarded = service.findOneSeam(guarded.imageId, "vertical").seam;
  console.log("\n=== 保护前后的首条垂直接缝（按列给出每行选中位置）===");
  console.log("无保护:", label(seamPlain.path), "代价:", seamPlain.cost.toFixed(2));
  console.log("有保护:", label(seamGuarded.path), "代价:", seamGuarded.cost.toFixed(2));
  console.log("有保护路线是否避开第 2/3 列:", seamGuarded.path.every((c) => c !== 2 && c !== 3));
  console.log("两条路线是否不同:", label(seamPlain.path) !== label(seamGuarded.path));

  console.log("\n=== 两种操作顺序缩到 5x5 ===");
  const wf = service.carve({
    pixels,
    targetWidth: 5,
    targetHeight: 5,
    order: "width-first",
  });
  const hf = service.carve({
    pixels,
    targetWidth: 5,
    targetHeight: 5,
    order: "height-first",
  });
  console.log(
    "width-first 方向序列 :",
    wf.report.steps.map((s) => s.direction[0]).join(" -> "),
  );
  console.log(
    "height-first 方向序列:",
    hf.report.steps.map((s) => s.direction[0]!).map((d) => (d === "v" ? "v(缩宽)" : "h(缩高)")).join(" -> "),
  );
  printGrid("width-first 产物", wf.finalPixels);
  printGrid("height-first 产物", hf.finalPixels);
  const cmp = service.compareReports(wf.reportId, hf.reportId);
  console.log("最终尺寸相同:", cmp.sameFinalSize, "；逐像素不同位置数:", cmp.differingPixels);

  console.log("\n=== 独立重放与核验（width-first 报告）===");
  const verify = service.replayAndVerify(wf.reportId);
  console.log(JSON.stringify(verify, null, 2).split("\n").filter((l) => !l.includes("replayedPixels")).join("\n"));

  const reportId = wf.reportId;
  store.close();

  console.log("\n=== 模拟服务重启：重新打开数据库并复核原报告 ===");
  store = new Store(dbFile);
  const service2 = new SeamCarveService(store);
  const after = service2.replayAndVerify(reportId);
  console.log("重启后重放逐像素一致:", after.pixelMatch, "；映射一致:", after.coordMapMatch, "；保护保持:", after.protectionKept);
  store.close();

  console.log("\n=== 算法保证说明 ===");
  console.log(wf.report.guaranteeNote);
}

main();
