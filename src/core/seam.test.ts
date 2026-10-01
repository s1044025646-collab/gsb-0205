import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeEnergy,
  findHorizontalSeam,
  findVerticalSeam,
  removeHorizontalSeam,
  removeVerticalSeam,
  transpose,
} from "./seam.js";
import { DEFAULT_ENERGY_CONFIG, EnergyConfig } from "../types.js";

const cfg: EnergyConfig = { ...DEFAULT_ENERGY_CONFIG };

/** 穷举所有垂直接缝（每行一列、相邻列差 <=1），返回 {path,cost} 全部组合。 */
function enumerateVertical(energy: number[][], blocked: number[][]): Array<{ path: number[]; cost: number }> {
  const h = energy.length;
  const w = energy[0]!.length;
  const results: Array<{ path: number[]; cost: number }> = [];
  const path: number[] = new Array(h);
  function rec(r: number, prev: number | null, cost: number): void {
    if (r === h) {
      results.push({ path: path.slice(), cost });
      return;
    }
    for (let c = 0; c < w; c++) {
      if (prev !== null && Math.abs(c - prev) > 1) continue;
      if (blocked[r]![c] === 1) continue;
      path[r] = c;
      rec(r + 1, c, cost + energy[r]![c]!);
    }
  }
  rec(0, null, 0);
  return results;
}

/** 与穷举一致性核对（最小代价 + 确定性平局：字典序最小路径）。 */
function assertSeamMatchesBruteForce(
  energy: number[][],
  blocked?: number[][],
): void {
  const h = energy.length;
  const w = energy[0]!.length;
  const b = blocked ?? Array.from({ length: h }, () => new Array<number>(w).fill(0));
  const all = enumerateVertical(energy, b);
  const seam = findVerticalSeam(energy, b);
  if (all.length === 0) {
    assert.equal(seam.blocked, true);
    return;
  }
  assert.equal(seam.blocked, false);
  let minCost = Infinity;
  for (const item of all) if (item.cost < minCost) minCost = item.cost;
  assert.ok(Math.abs(seam.cost - minCost) < 1e-9, `DP 代价 ${seam.cost} != 穷举最小 ${minCost}`);
  // 平局规则：在最小代价路径里，应选中字典序最小（逐行最左）的一条
  const best = all
    .filter((i) => Math.abs(i.cost - minCost) < 1e-9)
    .sort((a, z) => {
      for (let r = 0; r < h; r++) {
        if (a.path[r] !== z.path[r]) return a.path[r]! - z.path[r]!;
      }
      return 0;
    })[0]!;
  assert.deepEqual(seam.path, best.path, "平局路径不是字典序最左者");
}

test("常量图能量全为 0，接缝取最左路径，代价 0", () => {
  const px = [
    [10, 10, 10, 10],
    [10, 10, 10, 10],
    [10, 10, 10, 10],
  ];
  const energy = computeEnergy(px, undefined, cfg);
  for (const row of energy) for (const v of row) assert.equal(v, 0);
  const seam = findVerticalSeam(energy, transpose(transpose(px.map(() => [0, 0, 0, 0]))));
  assert.deepEqual(seam.path, [0, 0, 0]);
  assert.equal(seam.cost, 0);
});

test("单行图：垂直接缝逐列可选且最小代价列", () => {
  const px = [[5, 1, 9]];
  const energy = computeEnergy(px, undefined, { boundary: "zero", priorityWeight: 0 });
  // 单行时上下邻居都缺失：零边界下垂直贡献恒为 0；
  // 水平贡献为 |右-左|（缺侧补 0），故 [|1-0|, |9-5|, |0-1|] = [1,4,1]，最小在两端。
  assert.deepEqual(energy, [[1, 4, 1]]);
  const blocked = [[0, 0, 0]];
  assertSeamMatchesBruteForce(energy, blocked);
  const seam = findVerticalSeam(energy, blocked);
  assert.equal(seam.path[0], 0); // 平局取最左
});

test("单列图：全部行受保护时水平接缝阻断；无保护时唯一路径", () => {
  const px = [[3], [8], [2]];
  const energy = computeEnergy(px, undefined, cfg);
  const blocked = [
    [1],
    [1],
    [1],
  ];
  const seam = findHorizontalSeam(energy, blocked);
  assert.equal(seam.blocked, true);
  assert.ok(seam.blockReason!.includes("保护"));
  const ok = findHorizontalSeam(
    energy,
    [
      [0],
      [0],
      [0],
    ],
  );
  // 单列图水平接缝只有一列（length=1），其值为被选行；
  // replicate 下该列水平梯度为 0，垂直梯度分别为 |8-3|=5、|2-3|=1、|2-8|=6，最小在第 1 行
  const energies = energy.map((row) => row[0]);
  assert.deepEqual(energies, [5, 1, 6]);
  assert.deepEqual(ok.path, [1]);
});

test("小矩阵随机能量：DP 与穷举完全一致（含平局）", () => {
  const energies = [
    [
      [3, 1, 4, 1],
      [5, 9, 2, 6],
      [5, 3, 5, 8],
    ],
    [
      [0, 0, 0],
      [7, 0, 7],
      [0, 0, 0],
    ],
    [
      [2, 2],
      [2, 2],
      [2, 2],
      [2, 2],
    ],
  ];
  for (const e of energies) assertSeamMatchesBruteForce(e);
});

test("保护像素硬约束：穷举受限空间下仍为最小，且永不经过保护像素", () => {
  const energy = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ];
  const blocked = [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ];
  assertSeamMatchesBruteForce(energy, blocked);
  const seam = findVerticalSeam(energy, blocked);
  seam.path.forEach((c, r) => assert.equal(blocked[r]![c], 0));
});

test("保护完全阻断：整行被保护时无接缝", () => {
  const energy = [
    [1, 1],
    [1, 1],
  ];
  const blocked = [
    [0, 0],
    [1, 1],
  ];
  const seam = findVerticalSeam(energy, blocked);
  assert.equal(seam.blocked, true);
  assert.equal(seam.path.length, 0);
});

test("负代价偏好：优先掩膜把接缝吸引到指定列", () => {
  // 普通能量恒定，无偏好时走最左；给最右列高负代价后应被吸引
  const px = [
    [9, 9, 9, 9],
    [9, 9, 9, 9],
    [9, 9, 9, 9],
  ];
  const priority = [
    [0, 0, 0, 1],
    [0, 0, 0, 1],
    [0, 0, 0, 1],
  ];
  const plain = computeEnergy(px, undefined, cfg);
  assert.deepEqual(findVerticalSeam(plain, zeroBlock(3, 4)).path, [0, 0, 0]);
  const biased = computeEnergy(px, priority, { boundary: "replicate", priorityWeight: 100 });
  const seam = findVerticalSeam(biased, zeroBlock(3, 4));
  assert.deepEqual(seam.path, [3, 3, 3]);
  assert.ok(seam.cost < 0);
});

test("水平接缝与转置对应：路径=转置矩阵垂直接缝，代价相同", () => {
  const px = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 1, 2, 3],
  ];
  const energy = computeEnergy(px, undefined, cfg);
  const hSeam = findHorizontalSeam(energy, zeroBlock(3, 4));
  const tSeam = findVerticalSeam(transpose(energy), zeroBlock(4, 3));
  assert.deepEqual(hSeam.path, tSeam.path);
  assert.ok(Math.abs(hSeam.cost - tSeam.cost) < 1e-9);
  // 合法性：每列一行，相邻行差 <=1
  for (let c = 1; c < 4; c++) assert.ok(Math.abs(hSeam.path[c]! - hSeam.path[c - 1]!) <= 1);
});

test("接缝删除后尺寸正确，水平删除等价转置往返", () => {
  const m = [
    [1, 2, 3],
    [4, 5, 6],
  ];
  const v = removeVerticalSeam(m, [1, 2]);
  assert.deepEqual(v, [
    [1, 3],
    [4, 5],
  ]);
  const h = removeHorizontalSeam(m, [0, 0, 1]);
  assert.deepEqual(h, [
    [4, 5, 3],
  ]);
  // 不修改原矩阵
  assert.deepEqual(m, [
    [1, 2, 3],
    [4, 5, 6],
  ]);
});

test("细线图案：高对比竖线带来高能量，接缝避开它", () => {
  // 背景 0，第 2 列为 255 的竖线
  const px = [
    [0, 0, 255, 0, 0],
    [0, 0, 255, 0, 0],
    [0, 0, 255, 0, 0],
  ];
  const energy = computeEnergy(px, undefined, cfg);
  const seam = findVerticalSeam(energy, zeroBlock(3, 5));
  for (const c of seam.path) assert.notEqual(c, 2);
});

function zeroBlock(h: number, w: number): number[][] {
  return Array.from({ length: h }, () => new Array<number>(w).fill(0));
}
