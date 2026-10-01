import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { Store, type StoredImage } from './db.js';
import {
  DEFAULT_ENERGY_CONFIG,
  LIMITS,
  type EnergyConfig,
  type Image,
  type OperationOrder,
  type OriginCell,
  type SeamOrientation,
  type ShrinkReport,
} from './types.js';
import {
  assertMasksNoConflict,
  validateEnergyConfig,
  validateMask,
  validateMatrix,
  validateShrinkTargets,
} from './image/validation.js';
import { createImage } from './image/factory.js';
import { hashImagePayload, hashShrinkRequest } from './hash.js';
import { encodeP2, parseP2 } from './image/pgm.js';
import { computeEnergy } from './seam/energy.js';
import { findSeam } from './seam/search.js';
import { replayReport, shrink } from './seam/recarve.js';
import { validateSeamAgainstImage } from './seam/remove.js';

export interface ImportInput {
  matrix?: unknown;
  /** 文本 PGM（P2），与 matrix 二选一。 */
  pgm?: unknown;
  protect?: unknown;
  preferDelete?: unknown;
  name?: unknown;
}

export interface CompareResult {
  a: { id: string; width: number; height: number };
  b: { id: string; width: number; height: number };
  sameDimensions: boolean;
  /** 重叠区域内逐像素相等的比例（尺寸不同时仅比较重叠区域）。 */
  overlapCells: number;
  equalCells: number;
  equalRatio: number;
  /** B 中仍来自 A 原始坐标的像素数量（来源保留率，不要求尺寸相同）。 */
  sharedOriginCells: number;
}

export class SeamCarveService {
  constructor(private readonly store: Store) {}

 limits() {
    return { ...LIMITS };
  }

  defaultEnergyConfig(): EnergyConfig {
    return { ...DEFAULT_ENERGY_CONFIG, protectCost: Number.POSITIVE_INFINITY };
  }

  importImage(input: ImportInput): { imageId: string; created: boolean; width: number; height: number } {
    let matrix: unknown;
    let width: number;
    let height: number;
    if (input.matrix !== undefined && input.matrix !== null) {
      if (input.pgm !== undefined && input.pgm !== null) {
        throw new AppError('AMBIGUOUS_INPUT', 'matrix 与 pgm 只能提供一种');
      }
      matrix = input.matrix;
      ({ width, height } = validateMatrix(matrix));
    } else if (typeof input.pgm === 'string' && input.pgm.length > 0) {
      const parsed = parseP2(input.pgm);
      matrix = parsed.matrix;
      width = parsed.width;
      height = parsed.height;
      validateMatrix(matrix, 'pgm');
    } else {
      throw new AppError('MISSING_IMAGE', '必须提供 matrix 或 pgm 之一');
    }

    const protect = validateMask(input.protect, width, height, 'protect');
    const preferDelete = validateMask(input.preferDelete, width, height, 'preferDelete');
    assertMasksNoConflict(protect, preferDelete, width, height);
    const name = typeof input.name === 'string' ? input.name : null;

    const contentHash = hashImagePayload({ matrix, protect, preferDelete });
    const now = new Date().toISOString();
    const record: StoredImage = {
      imageId: randomUUID(),
      name,
      contentHash,
      createdAt: now,
      ...createImage(width, height, matrix as number[][], protect, preferDelete),
    };
    const { stored, created } = this.store.insertImageIfAbsent(record);
    return { imageId: stored.imageId, created, width, height };
  }

  getImageOrThrow(imageId: string): StoredImage {
    const image = this.store.getImage(imageId);
    if (!image) throw new AppError('IMAGE_NOT_FOUND', `图像 ${imageId} 不存在`, 404);
    return image;
  }

  private requireConfig(config: unknown): EnergyConfig {
    if (config === undefined || config === null) return this.defaultEnergyConfig();
    return validateEnergyConfig(config);
  }

  previewEnergy(imageId: string, config?: unknown): { width: number; height: number; energy: number[][] } {
    const image = this.getImageOrThrow(imageId);
    const cfg = this.requireConfig(config);
    return { width: image.width, height: image.height, energy: computeEnergy(image, cfg) };
  }

  findSingleSeam(
    imageId: string,
    orientation: SeamOrientation,
    config?: unknown,
  ): ReturnType<typeof findSeam> & { width: number; height: number } {
    if (orientation !== 'vertical' && orientation !== 'horizontal') {
      throw new AppError('INVALID_ORIENTATION', `未知接缝方向: ${String(orientation)}`);
    }
    const image = this.getImageOrThrow(imageId);
    const cfg = this.requireConfig(config);
    const result = findSeam(image, orientation, computeEnergy(image, cfg));
    return { ...result, width: image.width, height: image.height };
  }

  /** 仅校验一条外部接缝（不删除），用于提交前检查。 */
  checkSeam(imageId: string, orientation: SeamOrientation, path: unknown): { valid: boolean } {
    const image = this.getImageOrThrow(imageId);
    if (!Array.isArray(path) || !path.every((v) => typeof v === 'number' && Number.isInteger(v))) {
      throw new AppError('INVALID_SEAM_PATH', 'seamPath 必须是整数数组');
    }
    validateSeamAgainstImage({ orientation, path: path as number[] }, image);
    return { valid: true };
  }

  shrink(params: {
    imageId: string;
    targetWidth: number;
    targetHeight: number;
    order?: unknown;
    energyConfig?: unknown;
  }): { report: ShrinkReport; created: boolean } {
    const image = this.getImageOrThrow(params.imageId);
    const { targetWidth, targetHeight } = validateShrinkTargets(
      params.targetWidth,
      params.targetHeight,
      image.width,
      image.height,
    );
    const order: OperationOrder = params.order === undefined ? 'width-first' : (params.order as OperationOrder);
    if (order !== 'width-first' && order !== 'height-first') {
      throw new AppError('INVALID_ORDER', `未知操作顺序: ${String(params.order)}`);
    }
    const config = this.requireConfig(params.energyConfig);

    const requestHash = hashShrinkRequest({
      imageHash: image.contentHash,
      targetWidth,
      targetHeight,
      order,
      energyConfig: config,
    });
    const existing = this.findReportByRequestHash(requestHash);
    if (existing) return { report: existing, created: false };

    const report = shrink(
      image,
      { targetWidth, targetHeight, order },
      config,
      { reportId: randomUUID(), imageId: image.imageId, requestHash, createdAt: new Date().toISOString() },
    );
    return this.store.insertReportIfAbsent(report);
  }

  private findReportByRequestHash(requestHash: string): ShrinkReport | null {
    // node:sqlite 未暴露按二级索引直查的封装方法，这里在 Store 已有 getReport 之外，
    // 直接遍历报告列表代价随报告数增长，故使用 Store 暴露的查询。
    return this.store.getReportByRequestHash(requestHash);
  }

  getReportOrThrow(reportId: string): ShrinkReport {
    const report = this.store.getReport(reportId);
    if (!report) throw new AppError('REPORT_NOT_FOUND', `报告 ${reportId} 不存在`, 404);
    return report;
  }

  replay(reportId: string) {
    const report = this.getReportOrThrow(reportId);
    const image = this.getImageOrThrow(report.imageId);
    return replayReport(image, report);
  }

  /** 保护区域核验：确认没有任何受保护原始像素被删除。 */
  verifyProtection(reportId: string) {
    const report = this.getReportOrThrow(reportId);
    const image = this.getImageOrThrow(report.imageId);
    const protectedOrigins: OriginCell[] = [];
    for (let r = 0; r < image.height; r++) {
      for (let c = 0; c < image.width; c++) {
        if (image.protect[r]![c] === 1) protectedOrigins.push([r, c]);
      }
    }
    return {
      reportId,
      totalProtected: protectedOrigins.length,
      survivingProtected: report.survivingProtectedOrigins,
      removedProtected: report.removedProtectedOrigins,
      ok: report.removedProtectedOrigins.length === 0,
    };
  }

  /** 比较两个版本：两张已存图像，或一张源图像与某份报告的产物。 */
  compare(aImageId: string, b: { imageId?: string; reportId?: string }): CompareResult {
    const imageA = this.getImageOrThrow(aImageId);
    let imageB: Image;
    let bId: string;
    if (b.reportId) {
      const report = this.getReportOrThrow(b.reportId);
      bId = report.reportId;
      imageB = reportToImage(report);
    } else if (b.imageId) {
      const stored = this.getImageOrThrow(b.imageId);
      bId = stored.imageId;
      imageB = stored;
    } else {
      throw new AppError('COMPARE_TARGET_MISSING', '比较目标必须提供 imageId 或 reportId');
    }
    return compareImages(imageA, imageA.imageId, imageB, bId);
  }

  exportMatrix(reportId: string, format: 'json' | 'pgm'): { format: 'json' | 'pgm'; content: string; width: number; height: number } {
    const report = this.getReportOrThrow(reportId);
    if (format === 'pgm') {
      return { format, content: encodeP2(report.finalMatrix), width: report.finalWidth, height: report.finalHeight };
    }
    return {
      format,
      content: JSON.stringify(
        {
          width: report.finalWidth,
          height: report.finalHeight,
          matrix: report.finalMatrix,
          origin: report.finalOrigin,
          protect: report.finalProtect,
          preferDelete: report.finalPreferDelete,
        },
        null,
        2,
      ),
      width: report.finalWidth,
      height: report.finalHeight,
    };
  }

  listImages() {
    return this.store.listImages();
  }

  listReports() {
    return this.store.listReports();
  }
}

function reportToImage(report: ShrinkReport): Image {
  return {
    width: report.finalWidth,
    height: report.finalHeight,
    matrix: report.finalMatrix,
    protect: report.finalProtect,
    preferDelete: report.finalPreferDelete,
    origin: report.finalOrigin,
  };
}

function compareImages(a: Image, aId: string, b: Image, bId: string): CompareResult {
  const overlapW = Math.min(a.width, b.width);
  const overlapH = Math.min(a.height, b.height);
  let equalCells = 0;
  for (let r = 0; r < overlapH; r++) {
    for (let c = 0; c < overlapW; c++) {
      if (a.matrix[r]![c] === b.matrix[r]![c]) equalCells++;
    }
  }
  const overlapCells = overlapW * overlapH;
  const aOriginKeys = new Set<string>();
  for (let r = 0; r < a.height; r++) {
    for (let c = 0; c < a.width; c++) {
      const o = a.origin[r]![c]!;
      aOriginKeys.add(o.join(','));
    }
  }
  let sharedOriginCells = 0;
  for (let r = 0; r < b.height; r++) {
    for (let c = 0; c < b.width; c++) {
      if (aOriginKeys.has(b.origin[r]![c]!.join(','))) sharedOriginCells++;
    }
  }
  return {
    a: { id: aId, width: a.width, height: a.height },
    b: { id: bId, width: b.width, height: b.height },
    sameDimensions: a.width === b.width && a.height === b.height,
    overlapCells,
    equalCells,
    equalRatio: overlapCells === 0 ? 0 : equalCells / overlapCells,
    sharedOriginCells,
  };
}
