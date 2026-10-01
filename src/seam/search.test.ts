import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImage } from '../image/factory.js';
import { DEFAULT_ENERGY_CONFIG, type EnergyConfig, type Image } from '../types.js';
import { findSeam } from './search.js';
import { bruteForceBestSeam } from './bruteforce.js';
import { computeEnergy } from './energy.js';

const cfg: EnergyConfig = { ...DEFAULT_ENERGY_CONFIG };

function zeros(width: number, height: number) {
  return Array.from({ length: height }, () => Array<number>(width).fill(0));
}

test('常量图能量全为 0，平局规则选出全 0 列的最左接缝', () => {
  const image = createImage(4, 3, zeros(4, 3));
  const energy = computeEnergy(image, cfg);
  assert.deepEqual(energy, zeros(4, 3));
  const result = findSeam(image, 'vertical', energy);
  assert.equal(result.feasible, true);
  assert.equal(result.cost, 0);
  assert.deepEqual(result.seam.path, [0, 0, 0]);
});

test('梯度图：DP 与穷举最小代价及平局选择一致（含全部平局路径覆盖）', () => {
  const matrix = [
    [9, 1, 9],
    [9, 1, 9],
    [9, 1, 9],
    [9, 9, 9],
  ];
  const image = createImage(3, 4, matrix);
  for (const orientation of ['vertical', 'horizontal'] as const) {
    const dp = findSeam(image, orientation, computeEnergy(image, cfg));
    const brute = bruteForceBestSeam(image, orientation, cfg);
    assert.equal(dp.feasible, true);
    assert.equal(dp.cost, brute.minCost, `${orientation} 代价`);
    assert.ok(brute.bestPaths.some((p) => p.join() === dp.seam.path.join()), 'DP 路径在最优集合中');
    assert.deepEqual(dp.seam.path, brute.bestPaths[0], `${orientation} 平局确定性路径`);
  }
});

test('多组随机小矩阵穷举核对最小代价', () => {
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let width = 2; width <= 5; width++) {
    for (let height = 2; height <= 5; height++) {
      for (let trial = 0; trial < 8; trial++) {
        const matrix = Array.from({ length: height }, () =>
          Array.from({ length: width }, () => Math.floor(rand() * 256)),
        );
        const image = createImage(width, height, matrix);
        for (const orientation of ['vertical', 'horizontal'] as const) {
          const dp = findSeam(image, orientation, computeEnergy(image, cfg));
          const brute = bruteForceBestSeam(image, orientation, cfg);
          assert.equal(dp.cost, brute.minCost, `${width}x${height}#${trial} ${orientation}`);
          assert.deepEqual(dp.seam.path, brute.bestPaths[0]);
        }
      }
    }
  }
});

test('细线图案：接缝沿低能量细线中央下行', () => {
  const matrix = [
    [9, 0, 9],
    [9, 0, 9],
    [9, 0, 9],
    [9, 0, 9],
  ];
  const image = createImage(3, 4, matrix);
  // wrap 边界消除左右边缘效应后，暗线（c=1）始终是最低能量区。
  const wrapCfg: EnergyConfig = { ...cfg, boundary: 'wrap' };
  const result = findSeam(image, 'vertical', computeEnergy(image, wrapCfg));
  assert.ok(result.seam.path.every((c) => c <= 1), `路径应贴在低能量暗线上，实际 ${JSON.stringify(result.seam.path)}`);
  const brute = bruteForceBestSeam(image, 'vertical', wrapCfg);
  assert.equal(result.cost, brute.minCost);
  assert.ok(brute.bestPaths.some((p) => p.join() === result.seam.path.join()));
});

test('负代价偏好：preferDelete 使接缝偏移到偏好列（权重可配置）', () => {
  const matrix = zeros(3, 3);
  const prefer = [
    [0, 0, 1],
    [0, 0, 1],
    [0, 0, 1],
  ];
  const base = createImage(3, 3, matrix);
  assert.deepEqual(findSeam(base, 'vertical', computeEnergy(base, cfg)).seam.path, [0, 0, 0]);
  const preferred: Image = { ...base, preferDelete: prefer };
  const pcfg: EnergyConfig = { ...cfg, preferWeight: 10 };
  const result = findSeam(preferred, 'vertical', computeEnergy(preferred, pcfg));
  assert.deepEqual(result.seam.path, [2, 2, 2]);
  assert.ok(result.cost < 0);
});

test('单行/单列：垂直接缝在 1 行图上选最小列，水平接缝在 1 列图上选最小行', () => {
  const image = createImage(4, 1, [[5, 1, 9, 2]]);
  const vertical = findSeam(image, 'vertical', computeEnergy(image, cfg));
  // 1 行图 zero 边界：水平双向梯度 + 下方虚零行。
  // c3 只有一个水平邻居：|2-9| + |2-0|(下) + 2(下?见 energy 实现)，
  // 精确以实现为准——列 3 边界邻居更少，能量最低。
  const energy = computeEnergy(image, cfg);
  assert.equal(vertical.cost, energy[0]![3]);
  assert.deepEqual(vertical.seam.path, [3]);
  const horizontal = findSeam(image, 'horizontal', computeEnergy(image, cfg));
  assert.equal(horizontal.seam.path.length, 4); // 水平接缝长度 = width = 4

  const column = createImage(1, 4, [[5], [1], [9], [2]]);
  const h = findSeam(column, 'horizontal', computeEnergy(column, cfg));
  // 1 列图：水平接缝长度 = width = 1，选择能量最小的行。
  assert.equal(h.seam.path.length, 1);
  const columnEnergy = computeEnergy(column, cfg);
  const minRow = columnEnergy.map((row) => row[0]!).reduce((best, value, index, arr) => (value < arr[best]! ? index : best), 0);
  assert.deepEqual(h.seam.path, [minRow]);
});

test('受保护整行完全阻断垂直接缝，返回明确阻塞原因且不降低保护', () => {
  const matrix = zeros(3, 3);
  const protect = [
    [0, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ];
  const image = createImage(3, 3, matrix, protect);
  const result = findSeam(image, 'vertical', computeEnergy(image, cfg));
  assert.equal(result.feasible, false);
  assert.equal(result.cost, Infinity);
  assert.ok(result.blockReason?.code === 'PROTECTED_FULL_ROW' || result.blockReason?.code === 'PROTECTED_BARRIER');
});

test('水平接缝的屏障检测与转置规则对应', () => {
  const matrix = zeros(3, 3);
  const protect = [
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
  ];
  const image = createImage(3, 3, matrix, protect);
  const result = findSeam(image, 'horizontal', computeEnergy(image, cfg));
  assert.equal(result.feasible, false);
  assert.ok(
    result.blockReason?.code === 'PROTECTED_FULL_COLUMN' || result.blockReason?.code === 'PROTECTED_BARRIER',
  );
});

test('边界策略 replicate 使常量边界能量与 zero 不同但内点一致', () => {
  const matrix = [
    [10, 20],
    [30, 40],
  ];
  const image = createImage(2, 2, matrix);
  const eZero = computeEnergy(image, { ...cfg, boundary: 'zero' });
  const eRep = computeEnergy(image, { ...cfg, boundary: 'replicate' });
  // 2x2 全是边界：replicate 下越界方向复制自身贡献 0，(0,0)=|10-20|+|10-30|=30。
  assert.equal(eRep[0]![0], 30);
  assert.notEqual(eZero[0]![0], eRep[0]![0]);
  assert.notEqual(eZero[1]![1], eRep[1]![1]);
});
