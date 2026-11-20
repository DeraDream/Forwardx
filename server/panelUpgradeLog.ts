import fs from "fs";
import path from "path";
import { ENV } from "./env";

export const PANEL_UPGRADE_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function panelDataDir() {
  return path.dirname(path.resolve(ENV.sqlitePath || path.resolve(process.cwd(), "data", "forwardx.db")));
}

export function panelUpgradeLogPaths(dataDir = panelDataDir()) {
  return {
    logPath: path.join(dataDir, "panel-upgrade.log"),
    statePath: path.join(dataDir, "panel-upgrade-log-state.json"),
  };
}

function writeCleanupState(statePath: string, clearedAt: number) {
  fs.writeFileSync(statePath, `${JSON.stringify({ clearedAt })}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Clear the persistent upgrade log once per 30-day retention window. */
export function clearExpiredPanelUpgradeLog(now = Date.now(), dataDir = panelDataDir()) {
  const { logPath, statePath } = panelUpgradeLogPaths(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let clearedAt = 0;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    clearedAt = Number(state?.clearedAt || 0);
  } catch {
    // The first run starts a new retention window without discarding existing
    // diagnostics from an installation upgraded before this feature existed.
    writeCleanupState(statePath, now);
    return false;
  }
  if (!Number.isFinite(clearedAt) || clearedAt <= 0) {
    writeCleanupState(statePath, now);
    return false;
  }
  if (now - clearedAt < PANEL_UPGRADE_LOG_RETENTION_MS) return false;
  fs.writeFileSync(logPath, "", { encoding: "utf8", mode: 0o600 });
  writeCleanupState(statePath, now);
  return true;
}

export function appendPersistentPanelUpgradeLog(text: string, now = new Date(), dataDir = panelDataDir()) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  if (lines.length === 0) return;
  clearExpiredPanelUpgradeLog(now.getTime(), dataDir);
  const { logPath } = panelUpgradeLogPaths(dataDir);
  const content = lines.map((line) => `${now.toISOString()} ${line}\n`).join("");
  fs.appendFileSync(logPath, content, { encoding: "utf8", mode: 0o600 });
}
