import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("latency series resolve direct rules, active forward-group children, tunnels, chains, and services", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-latency-series-"));
  const databasePath = path.join(directory, "latency.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const metrics = await import(moduleUrl("server/repositories/metricsRepository.ts"));
    const tunnels = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const forwardTests = await import(moduleUrl("server/repositories/forwardTestRepository.ts"));
    const database = await import(moduleUrl("server/db.ts"));
    const probes = await import(moduleUrl("server/repositories/hostProbeServiceRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();

    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      const placeholders = values.map(() => "?").join(", ");
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + placeholders + ")",
        values,
      );
    };
    const now = Math.floor(Date.now() / 1000);
    const since = new Date((now - 600) * 1000);
    const stableProbeBucketAt = Math.floor((now - 1800) / 1800) * 1800 + 900;

    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "activeMemberId"], [10, "failover", "host", "failover", "0.0.0.0", 1, 1, 102]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled"], [20, "chain", "host", "chain", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 1, 1]);

    const ruleColumns = ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"];
    await insert("forward_rules", ruleColumns, [100, 1, "template", "iptables", "tcp", 10, null, null, 1, 10000, "example.test", 443, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [110, 1, "child-1", "iptables", "tcp", 10, 100, 101, 0, 10000, "example.test", 443, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [120, 2, "child-2", "iptables", "tcp", 10, 100, 102, 0, 10000, "example.test", 443, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [130, 1, "direct", "iptables", "tcp", null, null, null, 0, 10001, "example.test", 443, 1, 1, 1]);
    await insert("forward_rules", [...ruleColumns, "tunnelId"], [140, 1, "tunnel", "gost", "tcp", null, null, null, 0, 10002, "example.test", 443, 1, 1, 1, 30]);

    await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [110, 1, 11, 0, now - 120]);
    await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [120, 2, 42, 0, now - 90]);
    await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [130, 1, 33, 0, now - 60]);
    await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [140, 1, 999, 0, now - 55]);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "recordedAt"], [30, 55, 0, now - 50]);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "seriesKey", "recordedAt"], [31, 9, 0, "primary", now - 20]);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "seriesKey", "recordedAt"], [31, 15, 0, "total", now - 20]);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "seriesKey", "recordedAt"], [31, 7, 0, "exit-2", now - 10]);
    await insert("forward_group_latency_stats", ["groupId", "latencyMs", "isTimeout", "recordedAt"], [20, 66, 0, now - 40]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [40, 1, 77, 0, now - 30]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [41, 1, 10, 0, stableProbeBucketAt]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [41, 1, 20, 0, stableProbeBucketAt]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [41, 1, 30, 0, stableProbeBucketAt]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [41, 1, 35, 0, stableProbeBucketAt]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [41, 1, 40, 0, stableProbeBucketAt]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [42, 1, 50, 0, now - 31 * 60]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [42, 1, 60, 0, now - 5 * 60]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [43, 1, 80, 0, now - 120]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [43, 1, null, 1, now - 120]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [44, 1, null, 1, now - 120]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [44, 1, null, 1, now - 120]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [45, 1, 70, 0, now - 30]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [45, 2, 90, 0, now - 10]);

    // Three services reporting every ten seconds produce more than the old
    // global 20,000-row cap over a 24-hour window. Keep the fixture large
    // enough to catch regressions while inserting it in a few SQLite batches.
    const denseRows = [];
    for (const serviceId of [50, 51, 52]) {
      for (let offset = 0; offset < 24 * 60 * 60; offset += 10) {
        denseRows.push([serviceId, 1, 20 + (offset % 30), 0, now - offset]);
      }
    }
    for (let start = 0; start < denseRows.length; start += 250) {
      const batch = denseRows.slice(start, start + 250);
      await runtime.executeRaw(
        "INSERT INTO " + q("host_probe_service_stats") + " (" + ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"].map(q).join(", ") + ") VALUES " + batch.map(() => "(?, ?, ?, ?, ?)").join(", "),
        batch.flat(),
      );
    }

    const activeSeries = await metrics.getTcpingSeriesByRule(100, { since });
    assert.deepEqual(activeSeries.map((item) => item.latencyMs), [42]);

    await runtime.executeRaw('UPDATE "forward_groups" SET "activeMemberId" = NULL WHERE "id" = 10');
    const priorityFallbackSeries = await metrics.getTcpingSeriesByRule(100, { since });
    assert.deepEqual(priorityFallbackSeries.map((item) => item.latencyMs), [11]);

    const directSeries = await metrics.getTcpingSeriesByRule(130, { since });
    assert.deepEqual(directSeries.map((item) => item.latencyMs), [33]);
    const tunnelSeries = await metrics.getTunnelLatencySeries(30, { since });
    assert.deepEqual(tunnelSeries.map((item) => item.latencyMs), [55]);
    const latestTunnelTotal = await forwardTests.getLatestTunnelLatency(31);
    assert.equal(latestTunnelTotal?.seriesKey, "total");
    assert.equal(latestTunnelTotal?.latencyMs, 15);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "seriesKey", "recordedAt"], [32, 10, 0, "total", now + 60]);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "seriesKey", "recordedAt"], [32, 20, 0, "total", now - 60]);
    assert.equal((await forwardTests.getLatestTunnelLatency(32))?.latencyMs, 20, "latest insertion id must win across a panel clock correction");
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "seriesKey", "recordedAt"], [33, 11, 0, "primary", now]);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "seriesKey", "recordedAt"], [33, 11, 0, "total", now]);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "seriesKey", "recordedAt"], [33, 22, 0, "exit-2", now]);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "seriesKey", "recordedAt"], [33, 22, 0, "total", now]);
    const secondBatchTotal = await forwardTests.getLatestTunnelLatency(33);
    assert.deepEqual(
      (await metrics.getTunnelLatencyBranchSeriesForTotal(33, secondBatchTotal?.id)).map((row) => [row.seriesKey, row.latencyMs]),
      [["exit-2", 22]],
      "branch lookup must not reuse a same-second row from the previous total batch",
    );
    assert.deepEqual(await metrics.getTunnelLatencyBranchSeriesForTotal(31, secondBatchTotal?.id), [], "total id must belong to the requested tunnel");
    await tunnels.clearTunnelTestSnapshot(31, { clearHistory: true });
    assert.deepEqual(await metrics.getLatestTunnelLatencySeries([31]), new Map());
    assert.equal(await forwardTests.getLatestTunnelLatency(31), undefined);
    const chainSeries = await metrics.getForwardGroupLatencySeries(20, { since });
    assert.deepEqual(chainSeries.map((item) => item.latencyMs), [66]);

    // Without a separate entry group, child tcping paths overlap. The card
    // must show the same hop aggregate as the chart, not 70 + 36 + 5.
    await insert("forward_rules", ruleColumns, [150, 1, "chain template", "iptables", "tcp", 20, null, null, 1, 31287, "example.test", 443, 1, 1, 1]);
    for (const [id, hostId, latency] of [[151, 1, 70], [152, 2, 36], [153, 3, 5]]) {
      await insert("forward_rules", ruleColumns, [id, hostId, "chain child", "iptables", "tcp", 20, 150, id, 0, 31287, "example.test", 443, 1, 1, 1]);
      await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [id, hostId, latency, 0, now - 10]);
    }
    await insert("traffic_stats", ["ruleId", "hostId", "recordedAt"], [150, 1, now - 10]);
    const chainCard = await metrics.getTrafficSummaryByRule({ userId: 1, ruleIds: [150], since });
    assert.equal(chainCard.find((row) => row.ruleId === 150)?.latestLatencyMs, 66,
      "card latency must match the completed-hop chart rather than summed child tcping");
    await insert("forward_group_latency_stats", ["groupId", "latencyMs", "isTimeout", "recordedAt"], [20, null, 1, now - 5]);
    const timedOutCard = await metrics.getTrafficSummaryByRule({ userId: 1, ruleIds: [150], since });
    assert.equal(timedOutCard.find((row) => row.ruleId === 150)?.latestLatencyIsTimeout, true,
      "the most recent chart timeout must also appear on the card");
    await runtime.executeRaw('DELETE FROM "forward_group_latency_stats" WHERE "groupId" = 20');
    const unmeasuredCard = await metrics.getTrafficSummaryByRule({ userId: 1, ruleIds: [150], since });
    assert.equal(unmeasuredCard.find((row) => row.ruleId === 150)?.latestLatencyMs, null,
      "without a complete-path sample, do not display a sum of overlapping child probes");

    // A multi-entry chain has two complete entry-to-landing samples. The card
    // must choose the lower path, not sum the parallel entries and relay rows.
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "entryGroupId", "targetIp", "userId", "isEnabled"], [21, "multi-entry", "host", "chain", 22, "0.0.0.0", 1, 1]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled"], [22, "entries", "host", "entry", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [221, 22, "host", 13, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [222, 22, "host", 14, 1, 1]);
    await insert("forward_rules", ruleColumns, [131, 13, "multi-entry template", "iptables", "tcp", 21, null, null, 1, 40297, "example.test", 443, 1, 1, 1]);
    for (const [id, hostId, memberId, latency] of [[132, 1, 201, 5], [133, 2, 202, 35], [134, 3, 203, 37], [135, 13, 201, 44], [136, 14, 201, 43]]) {
      await insert("forward_rules", ruleColumns, [id, hostId, "chain child", "iptables", "tcp", 21, 131, memberId, 0, 40297, "example.test", 443, 1, 1, 1]);
      await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [id, hostId, latency, 0, now - 10]);
    }
    await insert("traffic_stats", ["ruleId", "hostId", "recordedAt"], [131, 13, now - 10]);
    await insert("forward_tests", ["ruleId", "hostId", "userId", "status", "latencyMs", "updatedAt"], [131, 13, 1, "success", 163, now - 5]);
    const multiEntrySummary = await metrics.getTrafficSummaryByRule({ userId: 1, ruleIds: [131], since });
    assert.equal(multiEntrySummary.find((row) => row.ruleId === 131)?.latestLatencyMs, 43,
      "an older or newer aggregate self-test must not overwrite the lower entry path");

    const serviceSeries = await probes.getHostProbeServiceSeries({ serviceIds: [40], hostId: 1, hours: 1 });
    assert.deepEqual(serviceSeries.map((item) => item.latencyMs), [77]);
    const limitedServiceSeries = await probes.getHostProbeServiceSeries({ serviceIds: [41], hostId: 1, hours: 1, limit: 3 });
    assert.deepEqual(limitedServiceSeries.map((item) => item.latencyMs), [27]);
    assert.equal(limitedServiceSeries[0]?.isTimeout, false);
    const halfHourServiceSeries = await probes.getHostProbeServiceSeries({ serviceIds: [42], hostId: 1, hours: 0.5 });
    assert.deepEqual(halfHourServiceSeries.map((item) => item.latencyMs), [60]);
    const timeoutSeries = await probes.getHostProbeServiceSeries({ serviceIds: [43, 44], hostId: 1, hours: 1 });
    assert.equal(timeoutSeries.find((item) => item.serviceId === 43)?.latencyMs, 80);
    assert.equal(timeoutSeries.find((item) => item.serviceId === 43)?.isTimeout, false);
    assert.equal(timeoutSeries.find((item) => item.serviceId === 44)?.latencyMs, null);
    assert.equal(timeoutSeries.find((item) => item.serviceId === 44)?.isTimeout, true);
    assert.equal((await probes.getLatestHostProbeServiceStats([45]))?.get(45)?.latencyMs, 90);
    assert.equal((await probes.getLatestHostProbeServiceStats([45], 1))?.get(45)?.latencyMs, 70);

    const denseServiceSeries = await probes.getHostProbeServiceSeries({ serviceIds: [50, 51, 52], hostId: 1, hours: 24 });
    assert.ok(denseServiceSeries.length > 600 && denseServiceSeries.length < 1_200);
    assert.deepEqual(new Set(denseServiceSeries.map((item) => item.serviceId)), new Set([50, 51, 52]));
    for (const serviceId of [50, 51, 52]) {
      const earliest = Math.min(...denseServiceSeries.filter((item) => item.serviceId === serviceId).map((item) => item.recordedAt.getTime()));
      const ageSeconds = (Date.now() - earliest) / 1000;
      assert.ok(ageSeconds >= 23 * 60 * 60, "dense series starts too late: " + ageSeconds + "s old");
      assert.ok(ageSeconds <= 24 * 60 * 60 + 10 * 60, "dense series starts too early: " + ageSeconds + "s old");
    }
    const denseUnscopedSeries = await probes.getHostProbeServiceSeries({ serviceIds: [50, 51, 52], hours: 24 });
    assert.ok(denseUnscopedSeries.length > 600 && denseUnscopedSeries.length < 1_200);
    assert.deepEqual(new Set(denseUnscopedSeries.map((item) => item.hostId)), new Set([1]));

    assert.equal(await database.clearLegacyTunnelRuleLatencyHistoryOnce(), 1);
    assert.equal(Number((await runtime.queryRaw('SELECT COUNT(*) AS count FROM "tcping_stats" WHERE "ruleId" = 140'))[0]?.count || 0), 0);
    assert.equal(Number((await runtime.queryRaw('SELECT COUNT(*) AS count FROM "tcping_stats" WHERE "ruleId" = 130'))[0]?.count || 0), 1);
    await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [140, 1, 44, 0, now]);
    assert.equal(await database.clearLegacyTunnelRuleLatencyHistoryOnce(), 0);
    assert.equal(Number((await runtime.queryRaw('SELECT COUNT(*) AS count FROM "tcping_stats" WHERE "ruleId" = 140'))[0]?.count || 0), 1);

    await runtime.closeDatabase();
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: databasePath,
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
