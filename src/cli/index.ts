#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SeamCarveService } from "../service.js";
import { Store } from "../store/store.js";
import { encodePgm, parsePgm } from "../core/pgm.js";
import { ValidationError } from "../types.js";

function usage(): string {
  return `seamcarve — 灰度图接缝缩小（仅缩小）本地 CLI

用法:
  seamcarve limits
  seamcarve import --json <文件> | --pgm <文件> [--protect <json>] [--priority <json>]
  seamcarve energy --image <imageId> [--boundary replicate|zero] [--priority-weight <n>]
  seamcarve seam --image <imageId> --direction vertical|horizontal [--boundary ...] [--priority-weight <n>]
  seamcarve carve --json <文件> | --image <imageId> --to <宽>x<高>
                  [--order width-first|height-first] [--boundary ...] [--priority-weight <n>]
  seamcarve replay <reportId>
  seamcarve report <reportId>
  seamcarve compare <reportIdA> <reportIdB>
  seamcarve export <reportId> --pgm <out.pgm> | --json <out.json>
  seamcarve list [--image <imageId>]

环境变量:
  SEAMCARVE_DATA  数据目录（默认 ./data）   SEAMCARVE_PORT  HTTP 端口（默认 8787）
`;
}

function parseArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        map.set(a.slice(2), next);
        i++;
      } else {
        map.set(a.slice(2), "true");
      }
    } else {
      positionals.push(a);
    }
  }
  map.set("_", positionals.join("\u0000"));
  return map;
}

function readMatrixFile(file: string): number[][] {
  const raw = readFileSync(resolve(file), "utf-8").trim();
  if (raw.startsWith("P2")) return parsePgm(raw).pixels;
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new ValidationError(`${file} 必须是二维数组 JSON 或 P2 PGM`);
  return value as number[][];
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function makeService(): SeamCarveService {
  const dataDir = resolve(process.env.SEAMCARVE_DATA ?? resolve(process.cwd(), "data"));
  const store = new Store(resolve(dataDir, "seamcarve.db"));
  return new SeamCarveService(store);
}

function energyConfigFromArgs(args: Map<string, string>) {
  return {
    boundary: (args.get("boundary") ?? "replicate") as "replicate" | "zero",
    priorityWeight: Number(args.get("priority-weight") ?? 0),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const positionals = (args.get("_") ?? "").split("\u0000").filter((s) => s.length > 0);
  const service = makeService();

  try {
    switch (command) {
      case "limits":
        return print(service.listLimits());

      case "import": {
        let pixels: number[][] | undefined;
        if (args.has("json")) pixels = readMatrixFile(args.get("json")!);
        else if (args.has("pgm")) pixels = parsePgm(readFileSync(args.get("pgm")!, "utf-8")).pixels;
        else throw new ValidationError("import 需要 --json 或 --pgm");
        const protectMask = args.has("protect")
          ? (JSON.parse(readFileSync(args.get("protect")!, "utf-8")) as number[][])
          : undefined;
        const priorityMask = args.has("priority")
          ? (JSON.parse(readFileSync(args.get("priority")!, "utf-8")) as number[][])
          : undefined;
        return print(service.importImage({ pixels, protectMask, priorityMask }));
      }

      case "energy": {
        if (!args.has("image")) throw new ValidationError("需要 --image");
        return print(service.previewEnergy(args.get("image")!, energyConfigFromArgs(args)));
      }

      case "seam": {
        if (!args.has("image")) throw new ValidationError("需要 --image");
        const direction = args.get("direction") === "horizontal" ? "horizontal" : "vertical";
        return print(
          service.findOneSeam(args.get("image")!, direction, energyConfigFromArgs(args)),
        );
      }

      case "carve": {
        const to = args.get("to");
        if (!to || !/^\d+x\d+$/i.test(to)) throw new ValidationError("需要 --to <宽>x<高>");
        const [tw, th] = to.split("x").map(Number);
        let payload: any = {
          targetWidth: tw,
          targetHeight: th,
          order: args.get("order") ?? "width-first",
          energyConfig: energyConfigFromArgs(args),
        };
        if (args.has("image")) {
          const img = service.getImage(args.get("image")!);
          payload = {
            ...payload,
            imageId: img.id,
            pixels: img.pixels,
            protectMask: img.protectMask,
            priorityMask: img.priorityMask,
          };
        } else if (args.has("json")) {
          const body = JSON.parse(readFileSync(args.get("json")!, "utf-8"));
          payload = { ...body, ...payload };
        } else {
          throw new ValidationError("carve 需要 --image <id> 或 --json <请求文件>");
        }
        return print(service.carve(payload, payload.imageId));
      }

      case "replay":
        if (!positionals[0]) throw new ValidationError("需要 reportId");
        return print(service.replayAndVerify(positionals[0]));

      case "report":
        if (!positionals[0]) throw new ValidationError("需要 reportId");
        return print(service.getReport(positionals[0]).report);

      case "compare":
        if (!positionals[0] || !positionals[1]) throw new ValidationError("需要两个 reportId");
        return print(service.compareReports(positionals[0], positionals[1]));

      case "export": {
        if (!positionals[0]) throw new ValidationError("需要 reportId");
        const result = service.getReport(positionals[0]);
        if (args.has("pgm")) {
          writeFileSync(resolve(args.get("pgm")!), encodePgm(result.finalPixels));
          return print({ exported: args.get("pgm"), size: [result.report.finalWidth, result.report.finalHeight] });
        }
        if (args.has("json")) {
          writeFileSync(resolve(args.get("json")!), JSON.stringify(result, null, 2));
          return print({ exported: args.get("json") });
        }
        throw new ValidationError("export 需要 --pgm 或 --json");
      }

      case "list":
        return print({
          images: service.listImages(),
          reports: service.listReports(args.get("image")),
        });

      default:
        console.log(usage());
        if (command) process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(`错误: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
