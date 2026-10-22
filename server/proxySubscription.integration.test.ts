import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { connectDatabase, executeRaw, queryRaw } from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { renderProxyNodeSubscription, renderProxySubscription } from "./proxySubscriptionPublic";

const databasePath = `/tmp/forwardx-proxy-subscription-${process.pid}.db`;
const timestamp = Math.floor(Date.now() / 1000);

test.before(async () => {
  fs.rmSync(databasePath, { force: true });
  await connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
  await ensureDatabaseSchema();
});

test.after(() => fs.rmSync(databasePath, { force: true }));

test("template subscription links nodes, a selected template and strategy-group assignments", async () => {
  await executeRaw("INSERT INTO proxy_nodes (name, protocol, link, enabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)", ["香港 A", "ss", "ss://YWVzLTI1Ni1nY206cGFzc0BleGFtcGxlLmNvbTo0NDM#HK-A", true, 0, timestamp, timestamp]);
  await executeRaw("INSERT INTO proxy_nodes (name, protocol, link, enabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)", ["日本 B", "ss", "ss://YWVzLTI1Ni1nY206cGFzc0BleGFtcGxlLm5ldDo0NDM#JP-B", true, 1, timestamp, timestamp]);
  const nodes = await queryRaw<any>("SELECT id FROM proxy_nodes ORDER BY id");
  await executeRaw("INSERT INTO proxy_templates (format, filename, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)", ["t-test-clash", "clash.yaml", "proxies:\n{{PROXY_NODES}}\nproxy-groups:\n  - name: Auto\n    proxies: [{{PROXY_GROUP:Auto}}]\n", timestamp, timestamp]);
  const template = (await queryRaw<any>("SELECT id FROM proxy_templates WHERE filename=?", ["clash.yaml"]))[0];
  await executeRaw("INSERT INTO proxy_subscriptions (name, token, nodeIdsJson, formatsJson, templateId, strategyGroupsJson, accessLimit, revoked, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["配置订阅", "template-token", JSON.stringify(nodes.map((item) => item.id)), JSON.stringify(["clash"]), template.id, JSON.stringify([{ name: "Auto", nodeIds: [nodes[0].id] }]), 0, false, timestamp, timestamp]);
  await executeRaw("INSERT INTO proxy_node_subscriptions (name, token, nodeIdsJson, accessLimit, revoked, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)", ["节点订阅", "nodes-token", JSON.stringify([nodes[1].id]), 0, false, timestamp, timestamp]);

  const rendered = await renderProxySubscription("template-token", "loon");
  assert.ok(rendered?.includes('name: "HK-A"'), rendered || undefined);
  assert.ok(rendered?.includes('name: "JP-B"'));
  assert.match(rendered || "", /proxies: \[HK-A\]/);

  const nodePayload = await renderProxyNodeSubscription("nodes-token");
  assert.equal(Buffer.from(nodePayload || "", "base64").toString("utf8"), "ss://YWVzLTI1Ni1nY206cGFzc0BleGFtcGxlLm5ldDo0NDM#JP-B\n");
  const accesses = await queryRaw<any>("SELECT subscriptionKind, format FROM proxy_subscription_logs ORDER BY id");
  assert.deepEqual(accesses.map((item) => [item.subscriptionKind, item.format]), [["config", "clash"], ["nodes", "raw"]]);
});
