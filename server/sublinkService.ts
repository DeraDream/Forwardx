import { createHmac } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Express, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { createContext } from "./_core/context";
import { ENV } from "./env";

const SUBLINK_HOST = "127.0.0.1";
const SUBLINK_PORT = 8000;
const SUBLINK_USERNAME = "admin";
let sublinkProcess: ChildProcess | null = null;
let sublinkStopping = false;
let sublinkRestartTimer: ReturnType<typeof setTimeout> | null = null;

function sublinkJwtSecret() {
  return createHmac("sha256", ENV.cookieSecret).update("forwardx-sublink-jwt-v1").digest("base64url");
}

function issueSublinkToken() {
  return jwt.sign({ username: SUBLINK_USERNAME, sub: SUBLINK_USERNAME }, sublinkJwtSecret(), { algorithm: "HS256", expiresIn: "10m" });
}

async function requireForwardXAdmin(req: Request, res: Response) {
  // SublinkX's iframe sends its own JWT in Authorization. ForwardX's context
  // resolver normally prefers a bearer token over the session cookie, so it
  // would try to verify the SublinkX JWT with ForwardX's cookie secret and
  // reject an otherwise valid panel session. Authenticate this proxy boundary
  // exclusively with the ForwardX browser cookie; the SublinkX token is added
  // only after this check when forwarding upstream.
  const authorization = req.headers.authorization;
  delete req.headers.authorization;
  const context = await createContext({ req, res } as any);
  if (authorization !== undefined) req.headers.authorization = authorization;
  if (!context.user) {
    res.status(401).json({ message: "ForwardX 登录已失效" });
    return false;
  }
  if (context.user.role !== "admin") {
    res.status(403).json({ message: "代理订阅仅限管理员访问" });
    return false;
  }
  return true;
}

function proxyToSublink(req: Request, res: Response, targetPath: string, options: { requireAdmin: boolean }) {
  void (async () => {
    if (options.requireAdmin && !(await requireForwardXAdmin(req, res))) return;
    const headers = { ...req.headers, host: `${SUBLINK_HOST}:${SUBLINK_PORT}` } as Record<string, string | string[] | undefined>;
    // SublinkX uses these standard headers when it writes an Egern auto-update
    // URL. Preserve the externally visible ForwardX address, never its private
    // loopback upstream.
    headers["x-forwarded-host"] = req.get("host") || "";
    headers["x-forwarded-proto"] = req.protocol;
    if (options.requireAdmin) headers.authorization = `Bearer ${issueSublinkToken()}`;
    delete headers.connection;

    const upstream = httpRequest({
      host: SUBLINK_HOST,
      port: SUBLINK_PORT,
      path: targetPath,
      method: req.method,
      headers,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.status(503).json({ message: "SublinkX 服务尚未启动" });
      else res.end();
    });
    req.pipe(upstream);
  })();
}

/** Mount SublinkX APIs and public subscription endpoints behind ForwardX checks. */
export function installSublinkProxy(app: Express) {
  app.use("/api/v1", (req, res) => proxyToSublink(req, res, req.originalUrl, { requireAdmin: true }));
  app.use("/static", (req, res) => proxyToSublink(req, res, req.originalUrl, { requireAdmin: false }));
  app.use("/c", (req, res) => proxyToSublink(req, res, req.originalUrl, { requireAdmin: false }));
  app.use("/n", (req, res) => proxyToSublink(req, res, req.originalUrl, { requireAdmin: false }));
}

export function startSublinkService(serverDir: string) {
  if (sublinkProcess) return;
  sublinkStopping = false;
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  // Release bundles carry both Linux architectures below dist/. Docker copies
  // the same assets beside dist/. The legacy filename is retained as a final
  // fallback for existing development installations.
  const binaries = [
    path.resolve(serverDir, `sublinkx/sublink-linux-${architecture}`),
    path.resolve(serverDir, `../sublinkx/sublink-linux-${architecture}`),
    path.resolve(serverDir, "sublinkx/sublink"),
    path.resolve(serverDir, "../sublinkx/sublink"),
  ];
  const binary = binaries.find(existsSync);
  if (!binary) {
    console.warn(`[SublinkX] binary not found (${binaries.join(", ")}); proxy subscription pages are unavailable`);
    return;
  }
  const dataDir = process.env.FORWARDX_SUBLINK_DATA_DIR || "/data/sublinkx";
  mkdirSync(dataDir, { recursive: true });
  sublinkProcess = spawn(binary, ["run", "-port", String(SUBLINK_PORT)], {
    cwd: dataDir,
    env: {
      ...process.env,
      FORWARDX_SUBLINK_HOST: SUBLINK_HOST,
      FORWARDX_SUBLINK_JWT_SECRET: sublinkJwtSecret(),
    },
    stdio: "inherit",
  });
  sublinkProcess.on("error", (error) => console.error(`[SublinkX] failed to start: ${error.message}`));
  sublinkProcess.on("exit", (code, signal) => {
    sublinkProcess = null;
    console.warn(`[SublinkX] exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    if (!sublinkStopping) {
      sublinkRestartTimer = setTimeout(() => { sublinkRestartTimer = null; startSublinkService(serverDir); }, 1000);
      sublinkRestartTimer.unref();
    }
  });
}

const MAX_SUBLINK_BACKUP_BYTES = 32 * 1024 * 1024;

async function sublinkBackupRequest(endpoint: "export" | "import", form: FormData): Promise<globalThis.Response> {
  const response = await fetch(`http://${SUBLINK_HOST}:${SUBLINK_PORT}/api/v1/backup/${endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${issueSublinkToken()}` }, body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { msg?: string };
    throw new Error(data.msg || `订阅备份服务返回 HTTP ${response.status}`);
  }
  return response;
}

/** The inner archive is encrypted together with the complete panel snapshot. */
export async function exportSublinkBackup(): Promise<string> {
  const response = await sublinkBackupRequest("export", new FormData());
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_SUBLINK_BACKUP_BYTES) throw new Error("订阅备份超过 32 MB，请缩减订阅数据后重试");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_SUBLINK_BACKUP_BYTES) throw new Error("订阅备份为空或超过 32 MB");
  return bytes.toString("base64");
}

export async function importSublinkBackup(encoded: string): Promise<void> {
  if (encoded.length > Math.ceil(MAX_SUBLINK_BACKUP_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("订阅备份数据无效或超过 32 MB");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_SUBLINK_BACKUP_BYTES) throw new Error("订阅备份数据无效或超过 32 MB");
  const form = new FormData();
  form.set("file", new Blob([bytes]), "sublink-backup.sublink-backup");
  await sublinkBackupRequest("import", form);
}

export function stopSublinkService() {
  sublinkStopping = true;
  if (sublinkRestartTimer) clearTimeout(sublinkRestartTimer);
  sublinkRestartTimer = null;
  sublinkProcess?.kill("SIGTERM");
  sublinkProcess = null;
}
