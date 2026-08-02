import { createServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { sha256 } from "../src/json.js";
import { REPOSITORY_ROOT } from "../src/paths.js";

const distDirectory = join(REPOSITORY_ROOT, "dist");
const host = "127.0.0.1";
const port = Number(process.env.CATALOG_PREVIEW_PORT ?? "4173");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CATALOG_PREVIEW_PORT 必须是 1 到 65535 的整数");
}

function contentType(path: string): string {
  const logicalPath = path.replace(/\.(?:br|gz)$/u, "");
  switch (extname(logicalPath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    default:
      return "application/json; charset=utf-8";
  }
}

function cacheControl(path: string): string {
  if (path === "manifest.json" || path === "index.html") {
    return "no-cache, max-age=0, must-revalidate";
  }
  return path.startsWith("versioned/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300, must-revalidate";
}

function sendError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(message);
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendError(response, 405, "Method Not Allowed");
      return;
    }
    let requestedPath: string;
    try {
      requestedPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
        .replace(/^\/+/, "");
    } catch {
      sendError(response, 400, "Bad Request");
      return;
    }
    const publicPath = requestedPath === "" ? "index.html" : normalize(requestedPath);
    const target = join(distDirectory, publicPath);
    const relativePath = relative(distDirectory, target);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      sendError(response, 403, "Forbidden");
      return;
    }
    try {
      if (!(await stat(target)).isFile()) {
        sendError(response, 404, "Not Found");
        return;
      }
      const bytes = await readFile(target);
      const etag = `"${sha256(bytes)}"`;
      const headers: Record<string, string | number> = {
        "content-type": contentType(publicPath),
        "content-length": bytes.byteLength,
        "cache-control": cacheControl(publicPath),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        etag,
      };
      if (publicPath.endsWith(".gz")) {
        headers["content-encoding"] = "gzip";
      } else if (publicPath.endsWith(".br")) {
        headers["content-encoding"] = "br";
      }
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers).end();
        return;
      }
      response.writeHead(200, headers);
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      sendError(response, 404, "Not Found");
    }
  })();
});

server.listen(port, host, () => {
  console.log(`目录预览已启动：http://${host}:${port}/`);
  console.log("该进程仅用于本地预览；生产环境请直接发布 dist/ 到对象存储/CDN。");
});
