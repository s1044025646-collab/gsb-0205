import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeamCarveService } from "./service.js";
import { Store } from "./store/store.js";
import { encodePgm, parsePgm } from "./core/pgm.js";

function tempDb(): { dir: string; dbFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "seamcarve-"));
  return { dir, dbFile: join(dir, "test.db") };
}

test("PGM 往返保持像素一致", () => {
  const pixels = [
    [0, 1, 255],
    [10, 20, 30],
  ];
  const text = encodePgm(pixels);
  assert.ok(text.startsWith("P2"));
  assert.deepEqual(parsePgm(text).pixels, pixels);
});

test("端到端：缩小 -> 落库 -> 重放核验 -> 重启后复核 -> 版本比较 -> 幂等", () => {
  const { dir, dbFile } = tempDb();
  try {
    const pixels = [
      [10, 20, 30, 40, 50],
      [10, 20, 30, 40, 50],
      [10, 20, 30, 40, 50],
      [10, 20, 30, 40, 50],
    ];

    let store = new Store(dbFile);
    const service = new SeamCarveService(store);

    // 幂等：相同输入导入返回同一 imageId
    const imp1 = service.importImage({ pixels });
    const imp2 = service.importImage({ pixels });
    assert.equal(imp1.imageId, imp2.imageId);
    assert.equal(imp1.reused, false);
    assert.equal(imp2.reused, true);

    const carveReq = {
      imageId: imp1.imageId,
      pixels,
      targetWidth: 3,
      targetHeight: 2,
      order: "width-first" as const,
    };
    const r1 = service.carve(carveReq, imp1.imageId);
    const r2 = service.carve(carveReq, imp1.imageId);
    assert.equal(r1.reportId, r2.reportId);
    assert.equal(r2.reused, true);

    const verification = service.replayAndVerify(r1.reportId);
    assert.equal(verification.ok, true, JSON.stringify(verification));
    assert.deepEqual(verification.finalSize, [3, 2]);

    // 另一操作顺序用于版本比较
    const other = service.carve(
      { ...carveReq, order: "height-first" },
      imp1.imageId,
    );
    const cmp = service.compareReports(r1.reportId, other.reportId);
    assert.equal(cmp.sameFinalSize, true);
    assert.deepEqual(cmp.reportA.order, "width-first");
    assert.deepEqual(cmp.reportB.order, "height-first");

    store.close();

    // 重启：重新打开同一数据文件，报告与重放结果仍在且逐像素一致
    store = new Store(dbFile);
    const service2 = new SeamCarveService(store);
    const fetched = service2.getReport(r1.reportId);
    assert.equal(fetched.report.targetWidth, 3);
    const verifyAfterRestart = service2.replayAndVerify(r1.reportId);
    assert.equal(verifyAfterRestart.ok, true);
    // 冻结的输入配置同样存在
    assert.equal(service2.getImage(imp1.imageId).width, 5);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("保护阻断不落库：操作表中无半成品", () => {
  const { dir, dbFile } = tempDb();
  try {
    const store = new Store(dbFile);
    const service = new SeamCarveService(store);
    const pixels = [
      [1, 2],
      [3, 4],
    ];
    const protectMask = [
      [1, 1],
      [1, 1],
    ];
    assert.throws(() =>
      service.carve(
        {
          pixels,
          protectMask,
          targetWidth: 1,
          targetHeight: 2,
        },
        undefined,
      ),
    );
    assert.equal(service.listReports().length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
