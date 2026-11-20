import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PANEL_UPGRADE_LOG_RETENTION_MS,
  appendPersistentPanelUpgradeLog,
  clearExpiredPanelUpgradeLog,
  panelUpgradeLogPaths,
} from "./panelUpgradeLog";

test("panel upgrade output is persisted with timestamps", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-panel-upgrade-log-"));
  try {
    const now = new Date("2026-11-20T12:00:00.000Z");
    appendPersistentPanelUpgradeLog("download started\nexitCode=1", now, directory);
    const content = fs.readFileSync(panelUpgradeLogPaths(directory).logPath, "utf8");
    assert.equal(content, "2026-11-20T12:00:00.000Z download started\n2026-11-20T12:00:00.000Z exitCode=1\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("panel upgrade log is cleared only after one 30-day retention window", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-panel-upgrade-retention-"));
  try {
    const startedAt = Date.parse("2026-10-01T00:00:00.000Z");
    appendPersistentPanelUpgradeLog("first failure", new Date(startedAt), directory);
    const { logPath } = panelUpgradeLogPaths(directory);
    assert.equal(clearExpiredPanelUpgradeLog(startedAt + PANEL_UPGRADE_LOG_RETENTION_MS - 1, directory), false);
    assert.match(fs.readFileSync(logPath, "utf8"), /first failure/);
    assert.equal(clearExpiredPanelUpgradeLog(startedAt + PANEL_UPGRADE_LOG_RETENTION_MS, directory), true);
    assert.equal(fs.readFileSync(logPath, "utf8"), "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
