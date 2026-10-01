import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImage } from '../image/factory.js';
import { DEFAULT_ENERGY_CONFIG, type Image } from '../types.js';
import { replayReport, shrink } from './recarve.js';
import { AppError } from '../errors.js';

const meta = { reportId: 'r1', imageId: 'i1', requestHash: 'h1', createdAt: '2026-10-02T00:00:00.000Z' };

function sample(): Image {
  return createImage(5, 4, [
    [10, 10, 80, 10, 10],
    [10, 80, 80, 10, 10],
    [10, 10, 80, 80, 10],
    [10, 10, 10, 10, 10],
  ]);
}

test('连续删除每步尺寸递减且最终尺寸正确（宽先）', () => {
  const image = sample();
  const report = shrink(image, { targetWidth: 2, targetHeight: 2, order: 'width-first' }, DEFAULT_ENERGY_CONFIG, meta);
  assert.equal(report.steps.length, 5);
  assert.deepEqual(
    report.steps.map((s) => [s.resultingWidth, s.resultingHeight]),
    [
      [4, 4],
      [3, 4],
      [2, 4],
      [2, 3],
      [2, 2],
    ],
  );
  assert.equal(report.finalWidth, 2);
  assert.equal(report.finalHeight, 2);
  assert.equal(report.optimalityClaim, 'stepwise-greedy');
});

test('先高后宽顺序在报告中明确反映', () => {
  const report = shrink(sample(), { targetWidth: 3, targetHeight: 2, order: 'height-first' }, DEFAULT_ENERGY_CONFIG, meta);
  assert.deepEqual(report.steps.map((s) => s.orientation), ['horizontal', 'horizontal', 'vertical', 'vertical']);
});

test('独立回放逐像素、来源映射、掩膜全部一致', () => {
  const image = sample();
  const report = shrink(image, { targetWidth: 2, targetHeight: 2, order: 'width-first' }, DEFAULT_ENERGY_CONFIG, meta);
  const replay = replayReport(image, report);
  assert.equal(replay.ok, true, JSON.stringify(replay.mismatches));
  assert.equal(replay.checkedSteps, 5);
});

test('报告被篡改（接缝越界）时回放拒绝', () => {
  const image = sample();
  const report = shrink(image, { targetWidth: 3, targetHeight: 3, order: 'width-first' }, DEFAULT_ENERGY_CONFIG, meta);
  const tampered = structuredClone(report);
  tampered.steps[0]!.seamPath[0] = 99;
  const replay = replayReport(image, tampered);
  assert.equal(replay.ok, false);
  assert.ok(replay.mismatches.some((m) => m.includes('非法')));
});

test('像素来源映射始终指向合法原始坐标，且最终像素值与源一致', () => {
  const image = sample();
  const report = shrink(image, { targetWidth: 2, targetHeight: 2, order: 'width-first' }, DEFAULT_ENERGY_CONFIG, meta);
  for (let r = 0; r < report.finalHeight; r++) {
    for (let c = 0; c < report.finalWidth; c++) {
      const [or, oc] = report.finalOrigin[r]![c]!;
      assert.equal(report.finalMatrix[r]![c], image.matrix[or]![oc]);
    }
  }
});

test('保护区域在整个序列中不丢失（保护前后删除路线不同）', () => {
  const plain = sample();
  const reportPlain = shrink(plain, { targetWidth: 3, targetHeight: 4, order: 'width-first' }, DEFAULT_ENERGY_CONFIG, meta);
  // 锁住无保护时最优接缝起点所在的最左列，强制接缝从右侧绕行。
  const protectedImage = createImage(5, 4, plain.matrix, [
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]);
  const reportProtected = shrink(
    protectedImage,
    { targetWidth: 3, targetHeight: 4, order: 'width-first' },
    DEFAULT_ENERGY_CONFIG,
    meta,
  );
  assert.equal(reportProtected.removedProtectedOrigins.length, 0);
  assert.equal(reportProtected.survivingProtectedOrigins.length, 3);
  // 受保护列被锁死后，至少某一步接缝应绕开，路线不应与无保护完全相同。
  const plainPaths = reportPlain.steps.map((s) => s.seamPath.join(',')).join('|');
  const protectedPaths = reportProtected.steps.map((s) => s.seamPath.join(',')).join('|');
  assert.notEqual(plainPaths, protectedPaths);
  const replay = replayReport(protectedImage, reportProtected);
  assert.equal(replay.ok, true);
});

test('保护区域完全阻断时抛出阻塞原因且不产生报告步骤污染', () => {
  const image = createImage(3, 2, [
    [0, 0, 0],
    [1, 1, 1],
  ], [
    [0, 0, 0],
    [1, 1, 1],
  ]);
  assert.throws(
    () => shrink(image, { targetWidth: 2, targetHeight: 2, order: 'width-first' }, DEFAULT_ENERGY_CONFIG, meta),
    (err: unknown) => err instanceof AppError && err.code.startsWith('PROTECTED_'),
  );
});

test('优先删除负代价影响多步结果', () => {
  const matrix = createImage(5, 3, [
    [9, 9, 9, 0, 9],
    [9, 9, 9, 0, 9],
    [9, 9, 9, 0, 9],
  ]);
  const prefer = [
    [0, 1, 0, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 1, 0, 0, 0],
  ];
  const preferred = createImage(5, 3, matrix.matrix, undefined, prefer);
  const config = { ...DEFAULT_ENERGY_CONFIG, preferWeight: 20 };
  const report = shrink(preferred, { targetWidth: 4, targetHeight: 3, order: 'width-first' }, config, meta);
  assert.deepEqual(report.steps[0]!.seamPath, [1, 1, 1]);
  assert.ok(report.steps[0]!.cost < 0);
});
