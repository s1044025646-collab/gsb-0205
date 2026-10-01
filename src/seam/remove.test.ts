import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImage } from '../image/factory.js';
import { removeSeam, validateSeamAgainstImage } from './remove.js';
import { AppError } from '../errors.js';

test('删除垂直接缝同步更新矩阵、掩膜与 origin 映射', () => {
  const image = createImage(
    3,
    2,
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
    [
      [0, 1, 0],
      [0, 0, 1],
    ],
  );
  const { image: next, removed } = removeSeam(image, { orientation: 'vertical', path: [0, 1] });
  assert.equal(next.width, 2);
  assert.equal(next.height, 2);
  assert.deepEqual(next.matrix, [
    [2, 3],
    [4, 6],
  ]);
  assert.deepEqual(next.protect, [
    [1, 0],
    [0, 1],
  ]);
  assert.deepEqual(next.origin, [
    [
      [0, 1],
      [0, 2],
    ],
    [
      [1, 0],
      [1, 2],
    ],
  ]);
  assert.deepEqual(
    removed.map((cell) => cell.origin),
    [
      [0, 0],
      [1, 1],
    ],
  );
});

test('删除水平接缝与“转置后垂直接缝”结果逐像素对应', () => {
  const matrix = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ];
  const image = createImage(3, 3, matrix);
  const transposed = createImage(
    3,
    3,
    matrix[0]!.map((_, c) => matrix.map((row) => row[c]!)),
  );
  // 在转置图上走垂直接缝 path，等价于原图水平接缝同 path。
  const path = [0, 1, 0];
  const h = removeSeam(image, { orientation: 'horizontal', path });
  const v = removeSeam(transposed, { orientation: 'vertical', path });
  // 转置回：v.image.matrix 的转置应等于 h.image.matrix
  const back = v.image.matrix[0]!.map((_, c) => v.image.matrix.map((row) => row[c]!));
  assert.deepEqual(back, h.image.matrix);
});

test('接缝越界、断裂、长度不符分别被拒绝', () => {
  const image = createImage(3, 3, [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]);
  assert.throws(
    () => validateSeamAgainstImage({ orientation: 'vertical', path: [0, 3, 0] }, image),
    (err: unknown) => err instanceof AppError && err.code === 'SEAM_OUT_OF_BOUNDS',
  );
  assert.throws(
    () => validateSeamAgainstImage({ orientation: 'vertical', path: [0, 2, 0] }, image),
    (err: unknown) => err instanceof AppError && err.code === 'SEAM_BROKEN',
  );
  assert.throws(
    () => validateSeamAgainstImage({ orientation: 'vertical', path: [0, 1] }, image),
    (err: unknown) => err instanceof AppError && err.code === 'SEAM_LENGTH_MISMATCH',
  );
});

test('接缝经过保护像素时删除被拒绝（最终防线）', () => {
  const image = createImage(2, 2, [
    [0, 0],
    [0, 0],
  ], [
    [0, 0],
    [0, 1],
  ]);
  assert.throws(
    () => removeSeam(image, { orientation: 'vertical', path: [0, 1] }),
    (err: unknown) => err instanceof AppError && err.code === 'PROTECTED_PIXEL_ON_SEAM',
  );
});

test('删除是不可变操作，源图像不被改写', () => {
  const image = createImage(2, 2, [
    [1, 2],
    [3, 4],
  ]);
  const snapshot = JSON.stringify(image.matrix);
  removeSeam(image, { orientation: 'vertical', path: [0, 0] });
  assert.equal(JSON.stringify(image.matrix), snapshot);
});
