import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from '../db.js';
import { AppError, isAppError } from '../errors.js';
import { SeamCarveService } from '../service.js';
import { DEFAULT_ENERGY_CONFIG, LIMITS } from '../types.js';
import { loadConfig } from '../config.js';

/**
 * 纯 JSON HTTP API（无任何网页/静态资源）。
 * 所有失败返回结构化 {error: {code,message,details}}，且不会产生半份结果：
 * 缩小失败时在写库前抛出，报告表不会出现半成品。
 */

interface RouteContext {
  service: SeamCarveService;
  body: unknown;
  query: URLSearchParams;
}

type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: (match: RegExpMatchArray) => Handler;
}

export function createApp(service: SeamCarveService): Server {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/limits$/, handler: () => () => ({ limits: { ...LIMITS }, defaultEnergyConfig: { ...DEFAULT_ENERGY_CONFIG, protectCost: 'Infinity' } }) },
    { method: 'GET', pattern: /^\/api\/images$/, handler: () => (ctx) => ({ images: ctx.service.listImages() }) },
    { method: 'POST', pattern: /^\/api\/images$/, handler: () => (ctx) => ctx.service.importImage(asRecord(ctx.body)) },
    { method: 'GET', pattern: /^\/api\/images\/([^/]+)$/, handler: (m) => (ctx) => ctx.service.getImageOrThrow(m[1]!) },
    {
      method: 'POST',
      pattern: /^\/api\/images\/([^/]+)\/energy$/,
      handler: (m) => (ctx) => ctx.service.previewEnergy(m[1]!, asRecord(ctx.body).energyConfig),
    },
    {
      method: 'POST',
      pattern: /^\/api\/images\/([^/]+)\/seams\/(vertical|horizontal)$/,
      handler: (m) => (ctx) => {
        const rec = asRecord(ctx.body);
        return ctx.service.findSingleSeam(m[1]!, m[2] as 'vertical' | 'horizontal', rec.energyConfig);
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/images\/([^/]+)\/seams\/(vertical|horizontal)\/check$/,
      handler: (m) => (ctx) => {
        const rec = asRecord(ctx.body);
        return ctx.service.checkSeam(m[1]!, m[2] as 'vertical' | 'horizontal', rec.path);
      },
    },
    { method: 'POST', pattern: /^\/api\/shrink$/, handler: () => (ctx) => ctx.service.shrink(asShrinkBody(ctx.body)) },
    { method: 'GET', pattern: /^\/api\/reports$/, handler: () => (ctx) => ({ reports: ctx.service.listReports() }) },
    { method: 'GET', pattern: /^\/api\/reports\/([^/]+)$/, handler: (m) => (ctx) => ctx.service.getReportOrThrow(m[1]!) },
    { method: 'POST', pattern: /^\/api\/reports\/([^/]+)\/replay$/, handler: (m) => (ctx) => ctx.service.replay(m[1]!) },
    { method: 'POST', pattern: /^\/api\/reports\/([^/]+)\/verify-protection$/, handler: (m) => (ctx) => ctx.service.verifyProtection(m[1]!) },
    {
      method: 'POST',
      pattern: /^\/api\/compare$/,
      handler: () => (ctx) => {
        const rec = asRecord(ctx.body);
        return ctx.service.compare(String(rec.aImageId), { imageId: rec.bImageId as string | undefined, reportId: rec.bReportId as string | undefined });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/reports\/([^/]+)\/export$/,
      handler: (m) => (ctx) => {
        const rec = asRecord(ctx.body);
        const format = rec.format === 'pgm' ? 'pgm' : 'json';
        return ctx.service.exportMatrix(m[1]!, format);
      },
    },
  ];

  return createServer(async (req, res) => {
    await handleRequest(req, res, routes, service);
  });
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function asShrinkBody(body: unknown): Parameters<SeamCarveService['shrink']>[0] {
  const rec = asRecord(body);
  return {
    imageId: String(rec.imageId),
    targetWidth: Number(rec.targetWidth),
    targetHeight: Number(rec.targetHeight),
    order: rec.order,
    energyConfig: rec.energyConfig,
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 50 * 1024 * 1024) {
      throw new AppError('BODY_TOO_LARGE', '请求体超过 50MB 上限', 413);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, (_key, value) => (value === Infinity ? 'Infinity' : value));
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Route[],
  service: SeamCarveService,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes.find((candidate) => candidate.method === (req.method ?? '') && candidate.pattern.test(url.pathname));
    if (!route) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由: ${req.method} ${url.pathname}` } });
      return;
    }
    const match = url.pathname.match(route.pattern)!;
    const body = req.method === 'POST' ? await readJson(req) : {};
    const result = route.handler(match)({ service, body, query: url.searchParams });
    sendJson(res, 200, { data: result });
  } catch (err) {
    if (isAppError(err)) {
      sendJson(res, err.statusCode, { error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    sendJson(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } });
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('api.js')) {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const service = new SeamCarveService(store);
  const server = createApp(service);
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[seamcarve] HTTP API 已启动: http://127.0.0.1:${config.port}`);
    console.log(`[seamcarve] 数据目录: ${config.dataDir}`);
  });
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
