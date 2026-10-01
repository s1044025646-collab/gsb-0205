import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './db.js';
import { SeamCarveService } from './service.js';

/**
 * 端到端演示（npm run demo）：
 * 1) 同一张图在“无保护 / 有保护 / 有优先删除”下删除路线的差异；
 * 2) width-first 与 height-first 两种操作顺序差异；
 * 3) 关闭并重新打开数据库（模拟服务重启）后复核原报告逐像素回放。
 */

const matrix = [
  [10, 10, 90, 10, 10, 10],
  [10, 90, 90, 10, 10, 10],
  [10, 10, 90, 90, 10, 10],
  [10, 10, 10, 10, 10, 10],
  [10, 10, 10, 10, 10, 10],
];

const protect = [
  [0, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 1, 0],
  [0, 0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0, 0],
];

const preferDelete = [
  [0, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 1, 0],
];

function printHeader(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'seamcarve-demo-'));
  const dbPath = join(dir, 'demo.sqlite');
  let store = new Store(dbPath);
  let service = new SeamCarveService(store);

  printHeader('公开尺寸上限');
  process.stdout.write(JSON.stringify(service.limits(), null, 2) + '\n');

  const plain = service.importImage({ name: 'plain', matrix });
  const protectedImg = service.importImage({ name: 'protected', matrix, protect });
  const preferred = service.importImage({ name: 'preferred', matrix, preferDelete });
  process.stdout.write(`导入：plain=${plain.imageId.slice(0, 8)} protected=${protectedImg.imageId.slice(0, 8)} preferred=${preferred.imageId.slice(0, 8)}\n`);

  printHeader('首条垂直接缝路线对比（无保护 / 有保护 / 优先删除）');
  const seamPlain = service.findSingleSeam(plain.imageId, 'vertical');
  const seamProtected = service.findSingleSeam(protectedImg.imageId, 'vertical');
  const seamPrefer = service.findSingleSeam(preferred.imageId, 'vertical', {
    gradient: 'l1',
    boundary: 'zero',
    preferWeight: 30,
    protectCost: Infinity,
  });
  process.stdout.write(`无保护   路径=${JSON.stringify(seamPlain.seam.path)} 代价=${seamPlain.cost}\n`);
  process.stdout.write(`有保护   路径=${JSON.stringify(seamProtected.seam.path)} 代价=${seamProtected.cost} 可行=${seamProtected.feasible}\n`);
  process.stdout.write(`优先删除 路径=${JSON.stringify(seamPrefer.seam.path)} 代价=${seamPrefer.cost}\n`);

  printHeader('两种操作顺序：6x5 → 4x3');
  const wf = service.shrink({ imageId: plain.imageId, targetWidth: 4, targetHeight: 3, order: 'width-first' });
  const hf = service.shrink({ imageId: plain.imageId, targetWidth: 4, targetHeight: 3, order: 'height-first' });
  process.stdout.write(`width-first  方向序列=${JSON.stringify(wf.report.steps.map((s) => s.orientation[0] === 'v' ? '缩宽' : '缩高'))} 报告=${wf.report.reportId.slice(0, 8)}\n`);
  process.stdout.write(`height-first 方向序列=${JSON.stringify(hf.report.steps.map((s) => s.orientation[0] === 'v' ? '缩宽' : '缩高'))} 报告=${hf.report.reportId.slice(0, 8)}\n`);

  printHeader('受保护图缩小后的保护区域核验');
  const protectedShrink = service.shrink({
    imageId: protectedImg.imageId,
    targetWidth: 4,
    targetHeight: 4,
    order: 'width-first',
  });
  const verification = service.verifyProtection(protectedShrink.report.reportId);
  process.stdout.write(`保护像素 ${verification.totalProtected} 个，被删除 ${verification.removedProtected.length} 个，核验通过=${verification.ok}\n`);

  const wfId = wf.report.reportId;
  const wfSteps = wf.report.steps.length;

  printHeader('模拟服务重启：关闭数据库再重新打开，复核原报告');
  store.close();
  store = new Store(dbPath);
  service = new SeamCarveService(store);
  const replay = service.replay(wfId);
  process.stdout.write(`报告 ${wfId.slice(0, 8)}：步骤=${wfSteps}，回放步数=${replay.checkedSteps}，逐像素核验通过=${replay.ok}\n`);
  if (!replay.ok) process.stdout.write(JSON.stringify(replay.mismatches, null, 2) + '\n');
  const idempotent = service.shrink({ imageId: plain.imageId, targetWidth: 4, targetHeight: 3, order: 'width-first' });
  process.stdout.write(`重启后重复请求幂等：created=${idempotent.created}，同报告=${idempotent.report.reportId === wfId}\n`);

  store.close();
  process.stdout.write(`\n演示完成，临时数据库目录：${dir}\n`);
}

main();
