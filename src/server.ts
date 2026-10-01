import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { SeamCarveService } from "./service.js";
import { Store } from "./store/store.js";
import { parsePgm } from "./core/pgm.js";
import { ValidationError } from "./types.js";

export interface ServerConfig {
  port: number;
  dataDir: string;
}

export function readServerConfig(): ServerConfig {
  const port = Number(process.env.PORT ?? process.env.SEAMCARVE_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口无效：${process.env.PORT}`);
  }
  const dataDir = resolve(
    process.env.SEAMCARVE_DATA ?? resolve(process.cwd(), "data"),
  );
  return { port, dataDir };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

export function createApp(service: SeamCarveService) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      // GET /api/limits
      if (method === "GET" && path === "/api/limits") {
        return sendJson(res, 200, service.listLimits());
      }

      // POST /api/images/import  （body: {pixels, protectMask?, priorityMask?} 或 {pgm}）
      if (method === "POST" && path === "/api/images/import") {
        const body = await readJson(req);
        if (typeof body.pgm === "string") {
          const parsed = parsePgm(body.pgm);
          const out = service.importImage({
            pixels: parsed.pixels,
            protectMask: body.protectMask,
            priorityMask: body.priorityMask,
          });
          return sendJson(res, 200, out);
        }
        const out = service.importImage(body);
        return sendJson(res, 200, out);
      }

      // GET /api/images
      if (method === "GET" && path === "/api/images") {
        return sendJson(res, 200, { images: service.listImages() });
      }

      const imageMatch = path.match(/^\/api\/images\/([^/]+)$/);
      if (method === "GET" && imageMatch) {
        return sendJson(res, 200, service.getImage(imageMatch[1]!));
      }

      // POST /api/images/:id/energy
      const energyMatch = path.match(/^\/api\/images\/([^/]+)\/energy$/);
      if (method === "POST" && energyMatch) {
        const body = await readJson(req);
        return sendJson(
          res,
          200,
          service.previewEnergy(energyMatch[1]!, body?.energyConfig),
        );
      }

      // POST /api/images/:id/seam  {direction, energyConfig?}
      const seamMatch = path.match(/^\/api\/images\/([^/]+)\/seam$/);
      if (method === "POST" && seamMatch) {
        const body = await readJson(req);
        const dir = body?.direction === "horizontal" ? "horizontal" : "vertical";
        return sendJson(
          res,
          200,
          service.findOneSeam(seamMatch[1]!, dir, body?.energyConfig),
        );
      }

      // POST /api/carve  完整缩小（可直接带像素，也可带 imageId）
      if (method === "POST" && path === "/api/carve") {
        const body = await readJson(req);
        const result = service.carve(body, body?.imageId);
        return sendJson(res, 200, result);
      }

      // POST /api/reports/:id/replay
      const replayMatch = path.match(/^\/api\/reports\/([^/]+)\/replay$/);
      if (method === "POST" && replayMatch) {
        return sendJson(res, 200, service.replayAndVerify(replayMatch[1]!));
      }

      // GET /api/reports/:id
      const reportMatch = path.match(/^\/api\/reports\/([^/]+)$/);
      if (method === "GET" && reportMatch) {
        return sendJson(res, 200, service.getReport(reportMatch[1]!));
      }

      // POST /api/reports/compare  {reportIdA, reportIdB}
      if (method === "POST" && path === "/api/reports/compare") {
        const body = await readJson(req);
        return sendJson(
          res,
          200,
          service.compareReports(body.reportIdA, body.reportIdB),
        );
      }

      // GET /api/reports/:id/export?format=json|pgm
      const exportMatch = path.match(/^\/api\/reports\/([^/]+)\/export$/);
      if (method === "GET" && exportMatch) {
        const result = service.getReport(exportMatch[1]!);
        const format = url.searchParams.get("format") ?? "json";
        if (format === "pgm") {
          const { encodePgm } = await import("./core/pgm.js");
          const pgm = encodePgm(result.finalPixels);
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          return res.end(pgm);
        }
        return sendJson(res, 200, result);
      }

      sendJson(res, 404, { error: "未找到路由", path, method });
    } catch (err) {
      if (err instanceof ValidationError) {
        return sendJson(res, 400, { error: err.message });
      }
      if (err instanceof SyntaxError) {
        return sendJson(res, 400, { error: "请求体不是合法 JSON" });
      }
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });
}

function main(): void {
  const config = readServerConfig();
  const store = new Store(resolve(config.dataDir, "seamcarve.db"));
  const service = new SeamCarveService(store);
  const server = createApp(service);
  server.listen(config.port, () => {
    console.log(
      `[seamcarve] HTTP 服务已启动: http://127.0.0.1:${config.port}  数据目录: ${config.dataDir}`,
    );
  });
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("server.ts") || invokedPath.endsWith("server.js")) {
  main();
}
