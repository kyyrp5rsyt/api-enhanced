// Cloudflare Pages Functions entry for api-enhanced.
// Bridges the Cloudflare Request/Response API to the Express app built by constructServer().
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Compatibility shims required before server.js is loaded:
// - __dirname is used by express.static() in server.js
// - api-enhanced reads runtime files from the temp dir at require-time
//   (workerd's nodejs_compat provides an in-memory fs, so create them up front)
globalThis.__dirname = "/";
const tmpPath = os.tmpdir();
const anonymousTokenPath = path.resolve(tmpPath, "./anonymous_token");
if (!fs.existsSync(anonymousTokenPath)) {
  fs.writeFileSync(anonymousTokenPath, "", "utf-8");
}
const xeapiKeyPath = path.resolve(tmpPath, "./xeapi_public_key");
if (!fs.existsSync(xeapiKeyPath)) {
  fs.writeFileSync(xeapiKeyPath, "", "utf-8");
}

// Dynamic imports so the code above runs before server.js -> util/request.js is loaded.
const { constructServer } = await import("../server.js");
const { moduleDefs } = await import("./_registry.js");

let appPromise;

function getApp() {
  if (!appPromise) {
    appPromise = constructServer(moduleDefs).catch((err) => {
      console.error("constructServer failed", err);
      throw err;
    });
  }
  return appPromise;
}

function headersToObject(headers) {
  const out = {};
  headers.forEach((v, k) => {
    out[String(k).toLowerCase()] = v;
  });
  return out;
}

export async function onRequest(context) {
  const { request } = context;
  const app = await getApp();

  const url = new URL(request.url);
  const isHttps = url.protocol === "https:";
  const rawBody = await request.arrayBuffer();

  // --- Build a Node-style req ---
  const req = Readable.from([Buffer.from(rawBody)]);
  Object.assign(req, {
    method: request.method,
    url: url.pathname + url.search,
    originalUrl: url.pathname + url.search,
    path: url.pathname,
    headers: headersToObject(request.headers),
    rawHeaders: [],
    httpVersion: "1.1",
    complete: true,
  });
  const sock = {
    remoteAddress: "127.0.0.1",
    remotePort: isHttps ? 443 : 80,
    encrypted: isHttps,
    setTimeout() {},
  };
  req.socket = sock;
  req.connection = sock;
  req.protocol = isHttps ? "https" : "http";
  req.secure = isHttps;
  req.ip = "127.0.0.1";

  // --- Build a Node-style res that buffers output ---
  const chunks = [];
  let finishCallback = null;

  const res = {
    statusCode: 200,
    statusMessage: "",
    headers: {},
    finished: false,
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
      return this;
    },
    getHeader(k) {
      return this.headers[String(k).toLowerCase()];
    },
    getHeaders() {
      return this.headers;
    },
    hasHeader(k) {
      return String(k).toLowerCase() in this.headers;
    },
    removeHeader(k) {
      delete this.headers[String(k).toLowerCase()];
    },
    writeHead(status, ...args) {
      if (typeof status === "number") this.statusCode = status;
      if (args.length > 0 && typeof args[0] === "string") {
        this.statusMessage = args[0];
      }
      if (
        args.length > 0 &&
        args[0] &&
        typeof args[0] === "object" &&
        !Array.isArray(args[0])
      ) {
        Object.entries(args[0]).forEach(([k, v]) => this.setHeader(k, v));
      }
      return this;
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null && chunk !== "") {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
      }
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null && chunk !== "") {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
      }
      this.finished = true;
      if (finishCallback) finishCallback();
      return this;
    },
    flushHeaders() {},
    on(ev, cb) {
      if (ev === "finish") finishCallback = cb;
      return this;
    },
    once(ev, cb) {
      return this.on(ev, cb);
    },
    emit() {
      return false;
    },
  };

  // Attach express extensions (res.send/json/redirect, req.get, etc.)
  try {
    Object.setPrototypeOf(res, app.response);
    Object.setPrototypeOf(req, app.request);
  } catch (e) {
    // ignore prototype errors; basic handlers still work
  }
  if (!req.cookies) req.cookies = {};

  // Run the express app.
  await new Promise((resolve) => {
    res.on("finish", resolve);
    try {
      app(req, res);
    } catch (err) {
      console.error("app handler error", err);
      if (!res.finished) {
        try {
          res.statusCode = 500;
          res.end();
        } catch (e) {}
      }
      resolve();
    }
    setTimeout(() => resolve(), 60000);
  });

  // --- Assemble Cloudflare Response ---
  const headers = new Headers();
  Object.entries(res.headers).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      v.forEach((item) => headers.append(k, String(item)));
    } else if (v !== undefined && v !== null) {
      headers.append(k, String(v));
    }
  });

  const body = chunks.length ? Buffer.concat(chunks) : null;
  return new Response(body, {
    status: res.statusCode,
    headers,
  });
}
