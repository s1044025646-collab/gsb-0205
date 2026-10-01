import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initCoordMap,
  runCarve,
  validateImageInput,
  validateTarget,
} from "./carve.js";
import { replaySteps, pixelsEqual, verifyProtectedKept } from "./replay.js";
import { DEFAULT_ENERGY_CONFIG, ValidationError } from "../types.js";

const P = (rows: number, cols: number, fill = 0): number[][] =>
  Array.from({ length: rows }, () => new Array<number>(cols).fill(fill));

test("校验：锯齿矩阵、越界像素、掩膜尺寸、掩膜冲突均被拒绝", () => {
  assert.throws(() => validateImageInput({ pixels: [[1, 2], [3]] }), ValidationError);
  assert.throws(() => validateImageInput({ pixels: [[0, 256]] }), ValidationError);
  assert.throws(() => validateImageInput({ pixels: [[0, -1]] }), ValidationError);
  assert.throws(
    () =>
      validateImageInput({
        pixels: [
          [0, 0],
          [0, 0],
        ],
        protectMask: [[1, 1]],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      validateImageInput({
        pixels: [
          [0, 0],
          [0, 0],
        ],
        protectMask: [
          [1, 0],
          [0, 0],
        ],
        priorityMask: [
          [1, 0],
          [0, 0],
        ],
      }),
    /冲突/,
  );
});

test("目标尺寸：禁止放大、禁止低于 1", () => {
  assert.throws(() => validateTarget(6, 2, 5, 5), /只支持缩小/);
  assert.throws(() => validateTarget(0, 2, 5, 5), /至少保留 1/);
  assert.doesNotThrow(() => validateTarget(5, 1, 5, 5));
});

test("缩到单列/单行：每步尺寸与映射正确", () => {
  const pixels = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const valid = validateImageInput({ pixels });
  const r = runCarve({
    pixels: valid.pixels,
    protectMask: valid.protectMask,
    priorityMask: valid.priorityMask,
    targetWidth: 1,
    targetHeight: 1,
    order: "width-first",
    energyConfig: DEFAULT_ENERGY_CONFIG,
  });
  assert.equal(r.pixels.length, 1);
  assert.equal(r.pixels[0]!.length, 1);
  assert.equal(r.steps.length, (4 - 1) + (3 - 1)); // 宽 4->1 三次，高 3->1 两次
  const dirs = r.steps.map((s) => s.direction);
  assert.deepEqual(dirs, ["vertical", "vertical", "vertical", "horizontal", "horizontal"]);
  // 每步尺寸连续：垂直接缝每次删 3 个，水平接缝每次删当时宽（1）个
  const expectedAreas = [9, 6, 3, 2, 1];
  r.steps.forEach((s, i) => {
    assert.equal(s.sizeAfter[0] * s.sizeAfter[1], expectedAreas[i]);
  });
  // 映射：最终唯一像素应指向某个合法原图坐标
  const [or, oc] = r.coordMap[0]![0]!;
  assert.ok(or >= 0 && or < 3 && oc >= 0 && oc < 4);
  // 被追踪删除的原始像素：3 次缩宽每次 3 个、2 次缩高每次 1 个 = 11 个，1 个保留
  const removed = new Set(r.steps.flatMap((s) => s.removedOriginalPixels).map(([a, b]) => `${a},${b}`));
  const removedList = r.steps.flatMap((s) => s.removedOriginalPixels);
  assert.equal(removedList.length, 11);
  assert.equal(new Set(removedList.map(([a, b]) => `${a},${b}`)).size, 11);
  assert.ok(!removed.has(`${or},${oc}`));
});

test("两种顺序：尺寸相同但路径序列可能不同", () => {
  const pixels = [
    [10, 20, 30, 40],
    [11, 250, 250, 41],
    [12, 13, 14, 42],
    [13, 250, 250, 43],
  ];
  const valid = validateImageInput({ pixels });
  const a = runCarve({
    pixels: valid.pixels,
    protectMask: valid.protectMask,
    priorityMask: valid.priorityMask,
    targetWidth: 2,
    targetHeight: 2,
    order: "width-first",
    energyConfig: DEFAULT_ENERGY_CONFIG,
  });
  const b = runCarve({
    pixels: valid.pixels,
    protectMask: valid.protectMask,
    priorityMask: valid.priorityMask,
    targetWidth: 2,
    targetHeight: 2,
    order: "height-first",
    energyConfig: DEFAULT_ENERGY_CONFIG,
  });
  assert.equal(a.pixels.length, 2);
  assert.equal(a.pixels[0]!.length, 2);
  assert.equal(b.pixels.length, 2);
  assert.deepEqual(a.steps[0]!.direction, "vertical");
  assert.deepEqual(b.steps[0]!.direction, "horizontal");
});

test("保护区域完全阻断缩小：抛出且不返回半成品", () => {
  // 2 列图，某行两列都受保护 -> 无法缩宽
  const pixels = [
    [1, 2],
    [3, 4],
  ];
  const protectMask = [
    [1, 1],
    [0, 0],
  ];
  assert.throws(
    () =>
      runCarve({
        pixels,
        protectMask,
        priorityMask: P(2, 2),
        targetWidth: 1,
        targetHeight: 2,
        order: "width-first",
        energyConfig: DEFAULT_ENERGY_CONFIG,
      }),
    /阻断/,
  );
});

test("回放逐像素一致 + 保护像素未丢失（含负代价偏好）", () => {
  const pixels = [
    [0, 50, 100, 150, 200],
    [0, 50, 100, 150, 200],
    [0, 50, 100, 150, 200],
    [0, 50, 100, 150, 200],
  ];
  const protectMask = [
    [0, 0, 0, 1, 0],
    [0, 0, 0, 1, 0],
    [0, 0, 0, 1, 0],
    [0, 0, 0, 1, 0],
  ];
  const priorityMask = [
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
  ];
  const r = runCarve({
    pixels,
    protectMask,
    priorityMask,
    targetWidth: 2,
    targetHeight: 4,
    order: "width-first",
    energyConfig: { boundary: "replicate", priorityWeight: 50 },
  });
  const replay = replaySteps({ originalPixels: pixels, steps: r.steps });
  assert.ok(pixelsEqual(replay.pixels, r.pixels));
  const removed = r.steps.flatMap((s) => s.removedOriginalPixels);
  const check = verifyProtectedKept({ originalProtectMask: protectMask, removedOriginalPixels: removed });
  assert.equal(check.kept, true);
  // 被优先删除的第 0 列应当最先被移除
  assert.equal(r.steps[0]!.removedOriginalPixels.every(([, c]) => c === 0), true);
});

test("回放拒绝越界/断裂/尺寸不符接缝", () => {
  const pixels = [
    [1, 2, 3],
    [4, 5, 6],
  ];
  assert.throws(
    () =>
      replaySteps({
        originalPixels: pixels,
        steps: [
          {
            direction: "vertical",
            path: [0, 2], // 断裂：0 -> 2 差 2
            sizeBefore: [3, 2],
            sizeAfter: [2, 2],
          },
        ],
      }),
    /断裂/,
  );
  assert.throws(
    () =>
      replaySteps({
        originalPixels: pixels,
        steps: [
          {
            direction: "vertical",
            path: [0, 5], // 越界
            sizeBefore: [3, 2],
            sizeAfter: [2, 2],
          },
        ],
      }),
    /越界/,
  );
});

test("initCoordMap 初始为恒等映射", () => {
  const m = initCoordMap(2, 3);
  assert.deepEqual(m[1]![2], [1, 2]);
});
