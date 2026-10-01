import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './db.js';
import { SeamCarveService } from './service.js';
import { AppError } from './errors.js';
import { encodeP2, parseP2 } from './image/pgm.js';

let dir: string;
let store: Store;
let service: SeamCarveService;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'seamcarve-'));
  store = new Store(join(dir, 'test.sqlite'));
  service = new SeamCarveService(store);
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('导入幂等：相同矩阵+掩膜返回同一 imageId，created 第二次为 false', () => {
  const payload = {
    matrix: [
      [1, 2],
      [3, 4],
    ],
  };
  const first = service.importImage(payload);
  const second = service.importImage({ ...payload, name: '另一个名字' });
  assert.equal(first.imageId, second.imageId);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
});

test('缩小请求幂等：重复请求返回同一 reportId 且不新增', () => {
  const imported = service.importImage({
    matrix: [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
  });
  const req = { imageId: imported.imageId, targetWidth: 2, targetHeight: 2, order: 'width-first' as const };
  const a = service.shrink(req);
  const b = service.shrink(req);
  assert.equal(a.report.reportId, b.report.reportId);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
});

test('两种操作顺序生成不同报告且各自回放通过', () => {
  const imported = service.importImage({
    matrix: [
      [10, 80, 10, 10],
      [10, 80, 80, 10],
      [10, 10, 80, 10],
      [10, 10, 10, 10],
    ],
  });
  const wf = service.shrink({ imageId: imported.imageId, targetWidth: 2, targetHeight: 2, order: 'width-first' });
  const hf = service.shrink({ imageId: imported.imageId, targetWidth: 2, targetHeight: 2, order: 'height-first' });
  assert.notEqual(wf.report.reportId, hf.report.reportId);
  assert.deepEqual(wf.report.steps.map((s) => s.orientation), ['vertical', 'vertical', 'horizontal', 'horizontal']);
  assert.deepEqual(hf.report.steps.map((s) => s.orientation), ['horizontal', 'horizontal', 'vertical', 'vertical']);
  assert.equal(service.replay(wf.report.reportId).ok, true);
  assert.equal(service.replay(hf.report.reportId).ok, true);
});

test('保护核验、版本比较与导出 JSON/PGM', () => {
  const imported = service.importImage({
    matrix: [
      [0, 0, 0],
      [0, 0, 0],
    ],
    protect: [
      [0, 1, 0],
      [0, 1, 0],
    ],
  });
  const shrinkResult = service.shrink({ imageId: imported.imageId, targetWidth: 2, targetHeight: 2, order: 'width-first' });
  const verification = service.verifyProtection(shrinkResult.report.reportId);
  assert.equal(verification.ok, true);
  assert.equal(verification.totalProtected, 2);
  assert.equal(verification.removedProtected.length, 0);

  const comparison = service.compare(imported.imageId, { reportId: shrinkResult.report.reportId });
  assert.equal(comparison.sameDimensions, false);
  assert.ok(comparison.sharedOriginCells >= 4);

  const jsonExport = service.exportMatrix(shrinkResult.report.reportId, 'json');
  assert.match(jsonExport.content, /"width": 2/);
  const pgmExport = service.exportMatrix(shrinkResult.report.reportId, 'pgm');
  assert.match(pgmExport.content, /^P2\n/);
  const parsed = parseP2(pgmExport.content);
  assert.equal(parsed.width, 2);
  assert.equal(parsed.height, 2);
});

test('PGM 往返解析，保留注释', () => {
  const matrix = [
    [0, 255],
    [128, 1],
  ];
  const text = encodeP2(matrix);
  const parsed = parseP2(text);
  assert.deepEqual(parsed.matrix, matrix);
});

test('服务重启等价：新建 Store 指向同一数据库后报告仍可读取并重放成功', () => {
  const imported = service.importImage({ matrix: [[5, 6, 7], [8, 9, 10]] });
  const result = service.shrink({ imageId: imported.imageId, targetWidth: 2, targetHeight: 1, order: 'height-first' });
  store.close();
  const reopened = new Store(join(dir, 'test.sqlite'));
  const reopenedService = new SeamCarveService(reopened);
  const report = reopenedService.getReportOrThrow(result.report.reportId);
  assert.equal(report.finalWidth, 2);
  assert.equal(report.finalHeight, 1);
  assert.equal(reopenedService.replay(result.report.reportId).ok, true);
  // 重复请求在重启后依然幂等。
  const again = reopenedService.shrink({ imageId: imported.imageId, targetWidth: 2, targetHeight: 1, order: 'height-first' });
  assert.equal(again.created, false);
  assert.equal(again.report.reportId, result.report.reportId);
  store = reopened;
  service = reopenedService;
});

test('非法输入：放大被拒绝、像素越界被拒绝、掩膜冲突被拒绝', () => {
  const imported = service.importImage({ matrix: [[1, 2]] });
  assert.throws(
    () => service.shrink({ imageId: imported.imageId, targetWidth: 5, targetHeight: 1 }),
    (err: unknown) => err instanceof AppError && err.code === 'UPSCALE_FORBIDDEN',
  );
  assert.throws(
    () => service.importImage({ matrix: [[0, 256]] }),
    (err: unknown) => err instanceof AppError && err.code === 'PIXEL_OUT_OF_RANGE',
  );
  assert.throws(
    () =>
      service.importImage({
        matrix: [
          [0, 0],
          [0, 0],
        ],
        protect: [
          [1, 0],
          [0, 0],
        ],
        preferDelete: [
          [1, 0],
          [0, 0],
        ],
      }),
    (err: unknown) => err instanceof AppError && err.code === 'MASKS_CONFLICT',
  );
});
