import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Image, ShrinkReport } from './types.js';

/**
 * SQLite 持久层（Node 内置 node:sqlite，无需 Docker/WSL/原生编译工具链）。
 * images / reports 均以 JSON 冻结输入与操作配置；request_hash 唯一索引保证幂等。
 */

export interface StoredImage extends Image {
  imageId: string;
  name: string | null;
  contentHash: string;
  createdAt: string;
}

interface ImageRow {
  image_id: string;
  name: string | null;
  content_hash: string;
  payload: string;
  created_at: string;
}

interface ReportRow {
  report_id: string;
  image_id: string;
  request_hash: string;
  payload: string;
  created_at: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        image_id     TEXT PRIMARY KEY,
        name         TEXT,
        content_hash TEXT NOT NULL,
        payload      TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_images_content_hash ON images(content_hash);

      CREATE TABLE IF NOT EXISTS reports (
        report_id    TEXT PRIMARY KEY,
        image_id     TEXT NOT NULL REFERENCES images(image_id),
        request_hash TEXT NOT NULL,
        payload      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_request_hash ON reports(request_hash);
    `);
  }

  /** 内容相同的图像返回既有记录（幂等导入）。 */
  insertImageIfAbsent(record: StoredImage): { stored: StoredImage; created: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM images WHERE content_hash = ?')
      .get(record.contentHash) as ImageRow | undefined;
    if (existing) {
      return { stored: rowToImage(existing), created: false };
    }
    this.db
      .prepare('INSERT INTO images(image_id, name, content_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(record.imageId, record.name, record.contentHash, JSON.stringify(record), record.createdAt);
    return { stored: record, created: true };
  }

  getImage(imageId: string): StoredImage | null {
    const row = this.db.prepare('SELECT * FROM images WHERE image_id = ?').get(imageId) as ImageRow | undefined;
    return row ? rowToImage(row) : null;
  }

  listImages(): Array<Pick<StoredImage, 'imageId' | 'name' | 'width' | 'height' | 'contentHash' | 'createdAt'>> {
    const rows = this.db
      .prepare('SELECT payload FROM images ORDER BY created_at ASC, image_id ASC')
      .all() as Array<{ payload: string }>;
    return rows.map(({ payload }) => {
      const img = JSON.parse(payload) as StoredImage;
      return {
        imageId: img.imageId,
        name: img.name,
        width: img.width,
        height: img.height,
        contentHash: img.contentHash,
        createdAt: img.createdAt,
      };
    });
  }

  /** 同一请求指纹返回既有报告（重复缩小请求幂等）。 */
  insertReportIfAbsent(report: ShrinkReport): { report: ShrinkReport; created: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM reports WHERE request_hash = ?')
      .get(report.requestHash) as ReportRow | undefined;
    if (existing) {
      return { report: JSON.parse(existing.payload) as ShrinkReport, created: false };
    }
    this.db
      .prepare('INSERT INTO reports(report_id, image_id, request_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        report.reportId,
        report.imageId,
        report.requestHash,
        JSON.stringify(report),
        report.createdAt,
      );
    return { report, created: true };
  }

  getReport(reportId: string): ShrinkReport | null {
    const row = this.db.prepare('SELECT payload FROM reports WHERE report_id = ?').get(reportId) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as ShrinkReport) : null;
  }

  getReportByRequestHash(requestHash: string): ShrinkReport | null {
    const row = this.db.prepare('SELECT payload FROM reports WHERE request_hash = ?').get(requestHash) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as ShrinkReport) : null;
  }

  listReports(): Array<Pick<ShrinkReport, 'reportId' | 'imageId' | 'order' | 'finalWidth' | 'finalHeight' | 'createdAt'>> {
    const rows = this.db
      .prepare('SELECT payload FROM reports ORDER BY created_at ASC, report_id ASC')
      .all() as Array<{ payload: string }>;
    return rows.map(({ payload }) => {
      const r = JSON.parse(payload) as ShrinkReport;
      return {
        reportId: r.reportId,
        imageId: r.imageId,
        order: r.order,
        finalWidth: r.finalWidth,
        finalHeight: r.finalHeight,
        createdAt: r.createdAt,
      };
    });
  }

  close(): void {
    this.db.close();
  }
}

function rowToImage(row: ImageRow): StoredImage {
  return JSON.parse(row.payload) as StoredImage;
}
