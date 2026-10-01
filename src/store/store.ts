import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CarveReport,
  EnergyConfig,
  Order,
} from "../types.js";

export interface ImageRow {
  id: string;
  width: number;
  height: number;
  pixels: number[][];
  protectMask: number[][];
  priorityMask: number[][];
  inputHash: string;
  createdAt: string;
}

export interface OperationRow {
  id: string;
  imageId: string;
  targetWidth: number;
  targetHeight: number;
  order: Order;
  energyConfig: EnergyConfig;
  status: "completed";
  report: CarveReport;
  finalPixels: number[][];
  finalProtectMask: number[][];
  finalPriorityMask: number[][];
  finalCoordMap: Array<Array<[number, number]>>;
  requestHash: string;
  createdAt: string;
}

interface ImageRecordShape {
  id: string;
  width: number;
  height: number;
  pixels: string;
  protect_mask: string;
  priority_mask: string;
  input_hash: string;
  created_at: string;
}

interface OperationRecordShape {
  id: string;
  image_id: string;
  target_width: number;
  target_height: number;
  order: Order;
  energy_config: string;
  report: string;
  final_pixels: string;
  final_protect_mask: string;
  final_priority_mask: string;
  final_coord_map: string;
  request_hash: string;
  created_at: string;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class Store {
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        pixels TEXT NOT NULL,
        protect_mask TEXT NOT NULL,
        priority_mask TEXT NOT NULL,
        input_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        image_id TEXT NOT NULL REFERENCES images(id),
        target_width INTEGER NOT NULL,
        target_height INTEGER NOT NULL,
        "order" TEXT NOT NULL,
        energy_config TEXT NOT NULL,
        report TEXT NOT NULL,
        final_pixels TEXT NOT NULL,
        final_protect_mask TEXT NOT NULL,
        final_priority_mask TEXT NOT NULL,
        final_coord_map TEXT NOT NULL,
        request_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * 冻结输入：相同像素+掩膜（SHA-256）返回同一 imageId（幂等）。
   */
  upsertImage(input: {
    id: string;
    width: number;
    height: number;
    pixels: number[][];
    protectMask: number[][];
    priorityMask: number[][];
    createdAt: string;
  }): { row: ImageRow; reused: boolean } {
    const inputHash = sha256Json([
      input.width,
      input.height,
      input.pixels,
      input.protectMask,
      input.priorityMask,
    ]);
    const existing = this.findImageByHash(inputHash);
    if (existing) return { row: existing, reused: true };

    this.db
      .prepare(
        `INSERT INTO images (id, width, height, pixels, protect_mask, priority_mask, input_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.width,
        input.height,
        JSON.stringify(input.pixels),
        JSON.stringify(input.protectMask),
        JSON.stringify(input.priorityMask),
        inputHash,
        input.createdAt,
      );
    return { row: this.getImage(input.id)!, reused: false };
  }

  private findImageByHash(hash: string): ImageRow | null {
    const rec = this.db
      .prepare(`SELECT * FROM images WHERE input_hash = ?`)
      .get(hash) as ImageRecordShape | undefined;
    return rec ? this.toImageRow(rec) : null;
  }

  getImage(id: string): ImageRow | null {
    const rec = this.db
      .prepare(`SELECT * FROM images WHERE id = ?`)
      .get(id) as ImageRecordShape | undefined;
    return rec ? this.toImageRow(rec) : null;
  }

  listImages(): Array<Pick<ImageRow, "id" | "width" | "height" | "createdAt">> {
    const recs = this.db
      .prepare(`SELECT id, width, height, created_at FROM images ORDER BY created_at`)
      .all() as Array<{ id: string; width: number; height: number; created_at: string }>;
    return recs.map((r) => ({
      id: r.id,
      width: r.width,
      height: r.height,
      createdAt: r.created_at,
    }));
  }

  private toImageRow(rec: ImageRecordShape): ImageRow {
    return {
      id: rec.id,
      width: rec.width,
      height: rec.height,
      pixels: JSON.parse(rec.pixels),
      protectMask: JSON.parse(rec.protect_mask),
      priorityMask: JSON.parse(rec.priority_mask),
      inputHash: rec.input_hash,
      createdAt: rec.created_at,
    };
  }

  static operationRequestHash(input: {
    imageId: string;
    targetWidth: number;
    targetHeight: number;
    order: Order;
    energyConfig: EnergyConfig;
  }): string {
    return sha256Json([
      input.imageId,
      input.targetWidth,
      input.targetHeight,
      input.order,
      input.energyConfig,
    ]);
  }

  /**
   * 幂等地写入一次“成功完成”的操作。
   * 相同（图像+目标尺寸+顺序+能量配置）请求永远返回同一份报告。
   * 调用方必须先完成全部计算；本方法在单个事务中写库，
   * 若计算阶段被阻断则根本不会调用，绝不留下半份结果。
   */
  saveOperation(input: {
    id: string;
    imageId: string;
    targetWidth: number;
    targetHeight: number;
    order: Order;
    energyConfig: EnergyConfig;
    report: CarveReport;
    finalPixels: number[][];
    finalProtectMask: number[][];
    finalPriorityMask: number[][];
    finalCoordMap: Array<Array<[number, number]>>;
    createdAt: string;
  }): { row: OperationRow; reused: boolean } {
    const requestHash = Store.operationRequestHash(input);
    const existing = this.findOperationByHash(requestHash);
    if (existing) return { row: existing, reused: true };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO operations
           (id, image_id, target_width, target_height, "order", energy_config,
            report, final_pixels, final_protect_mask, final_priority_mask,
            final_coord_map, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.imageId,
          input.targetWidth,
          input.targetHeight,
          input.order,
          JSON.stringify(input.energyConfig),
          JSON.stringify(input.report),
          JSON.stringify(input.finalPixels),
          JSON.stringify(input.finalProtectMask),
          JSON.stringify(input.finalPriorityMask),
          JSON.stringify(input.finalCoordMap),
          requestHash,
          input.createdAt,
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { row: this.getOperation(input.id)!, reused: false };
  }

  private findOperationByHash(hash: string): OperationRow | null {
    const rec = this.db
      .prepare(`SELECT * FROM operations WHERE request_hash = ?`)
      .get(hash) as OperationRecordShape | undefined;
    return rec ? this.toOperationRow(rec) : null;
  }

  getOperation(id: string): OperationRow | null {
    const rec = this.db
      .prepare(`SELECT * FROM operations WHERE id = ?`)
      .get(id) as OperationRecordShape | undefined;
    return rec ? this.toOperationRow(rec) : null;
  }

  /** 列出某图像的全部成功操作（供版本比较）。 */
  listOperations(imageId?: string): OperationRow[] {
    const recs = imageId
      ? (this.db
          .prepare(`SELECT * FROM operations WHERE image_id = ? ORDER BY created_at`)
          .all(imageId) as OperationRecordShape[])
      : (this.db
          .prepare(`SELECT * FROM operations ORDER BY created_at`)
          .all() as OperationRecordShape[]);
    return recs.map((r) => this.toOperationRow(r));
  }

  private toOperationRow(rec: OperationRecordShape): OperationRow {
    return {
      id: rec.id,
      imageId: rec.image_id,
      targetWidth: rec.target_width,
      targetHeight: rec.target_height,
      order: rec.order,
      energyConfig: JSON.parse(rec.energy_config),
      status: "completed",
      report: JSON.parse(rec.report),
      finalPixels: JSON.parse(rec.final_pixels),
      finalProtectMask: JSON.parse(rec.final_protect_mask),
      finalPriorityMask: JSON.parse(rec.final_priority_mask),
      finalCoordMap: JSON.parse(rec.final_coord_map),
      requestHash: rec.request_hash,
      createdAt: rec.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
