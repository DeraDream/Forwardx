import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
import { createHopTestBatch, recordHopTestResult, registerHopTest } from "./hopTestState";

const runtimePrefix = "full-chain-";
const AGENT_STEP_TIMEOUT_MS = 3 * 60 * 1000;
const LATENCY_TIMEOUT_MS = 60 * 1000;
const message = (value: unknown, fallback: string) =>
  String(value || fallback)
    .trim()
    .slice(0, 500);

const latencyDetails = (value: unknown) => {
  try {
    const parsed = value ? JSON.parse(String(value)) : null;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

function endpoint(host: any, ingressIp?: string | null) {
  return String(
    ingressIp || host?.entryIp || host?.publicIp || host?.ipv4 || host?.ip || "",
  ).trim();
}

async function nodeEntry(node: any) {
  if (String(node?.nodeType || "host") !== "forward-chain") {
    const host = await db.getHostById(Number(node?.hostId));
    return { hostId: Number(node?.hostId), host, ip: endpoint(host, node?.ingressIp) };
  }
  const group = await db.getForwardGroupById(Number(node?.forwardGroupId)) as any;
  if (!group || String(group.groupMode) !== "chain" || group.isEnabled === false) throw new Error("引用的转发链不可用");
  const hostId = await db.getForwardGroupDefaultHostId(Number(group.id));
  const host = await db.getHostById(hostId);
  return { hostId, host, ip: endpoint(host) };
}

async function nodeExitIp(node: any) {
  if (String(node?.nodeType || "host") !== "forward-chain") return String(node?.publicIp || "").trim();
  const group = await db.getForwardGroupById(Number(node?.forwardGroupId)) as any;
  const member = (group?.members || []).filter((item: any) => item.isEnabled !== false).at(-1);
  const host = member?.hostId ? await db.getHostById(Number(member.hostId)) : null;
  return endpoint(host);
}

const timestamp = (value: any) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? numeric < 10_000_000_000 ? numeric * 1000 : numeric
    : Number(new Date(value || 0));
};

async function finishLatencyCheck(chainId: number) {
  const nodes = await db.getFullChainNodes(chainId);
  const hops = nodes.slice(0, -1);
  if (hops.some((node: any) => node.latencyStatus === "checking")) return;
  const latestLatencyMs = hops.every((node: any) => node.latencyStatus === "done")
    ? hops.reduce((sum: number, node: any) => sum + Math.max(0, Number(node.latencyMs) || 0), 0)
    : null;
  await db.updateFullChain(chainId, { latestLatencyMs });
  await db.recordFullChainLatency(chainId, latestLatencyMs, nodes.map((node: any, index: number) => ({ hostId: node.hostId, forwardGroupId: node.forwardGroupId, name: node.forwardGroupName || node.hostName, latencyMs: index < hops.length ? node.latencyMs : null, isTimeout: index < hops.length && node.latencyStatus !== "done", details: latencyDetails(node.latencyDetails) })));
}

async function fail(
  chainId: number,
  nodeId: number,
  phase: "port" | "protocol" | "deploy",
  detail: string,
) {
  const column =
    phase === "port"
      ? "portStatus"
      : phase === "protocol"
        ? "protocolStatus"
        : "deployStatus";
  const messageColumn =
    phase === "port"
      ? "portMessage"
      : phase === "protocol"
        ? "protocolMessage"
        : "deployMessage";
  await db.updateFullChainNode(nodeId, {
    [column]: "error",
    [messageColumn]: detail,
  });
  await db.updateFullChain(chainId, { status: "error", statusMessage: detail });
}

async function beginDeploy(chainId: number) {
  const chain = (await db.getFullChainById(chainId)) as any;
  if (!chain || chain.status === "cancelled") return;
  const nodes = await db.getFullChainNodes(chainId);
  const next = nodes.find(
    (node: any) => String(node.deployStatus) === "pending",
  );
  if (!next) return;
  await db.updateFullChain(chainId, {
    status: "deploying",
    statusMessage: "正在按顺序部署",
  });
  await db.updateFullChainNode(Number(next.id), {
    deployStatus: "checking",
    deployMessage: "部署中",
  });
  const index = nodes.findIndex(
    (node: any) => Number(node.id) === Number(next.id),
  );
  if (String(next.nodeType || "host") === "forward-chain") {
    const downstream = nodes[index + 1];
    if (!downstream) return fail(chainId, Number(next.id), "deploy", "转发链不能作为落地节点");
    try {
      const group = await db.getForwardGroupById(Number(next.forwardGroupId)) as any;
      const entry = await nodeEntry(next);
      const target = await nodeEntry(downstream);
      if (!entry.hostId || !target.ip) throw new Error("转发链入口或下一跳不可用");
      const createTemplate = () => db.createForwardRule({
        userId: Number(chain.userId), hostId: entry.hostId, name: `[全链路:${chainId}] ${chain.name} 转发链`,
        forwardType: String(group.forwardType || "iptables"), protocol: chain.protocol,
        sourcePort: Number(chain.port), targetIp: target.ip, targetPort: Number(chain.port),
        forwardGroupId: Number(group.id), isForwardGroupTemplate: true,
        isEnabled: true, telegramErrorNotifyEnabled: false,
        blockHttp: false, blockSocks: false, blockTls: false,
      } as any);
      const ruleId = await db.withForwardGroupSyncTransaction(Number(group.id), createTemplate);
      const childRules = await db.getForwardGroupChildRulesForTemplate(ruleId);
      if (!childRules.length) throw new Error("转发链没有生成可部署的子规则");
      await db.updateFullChainNode(Number(next.id), { generatedRuleId: ruleId, deployMessage: `等待转发链 ${childRules.length} 条规则运行` });
      return;
    } catch (error) {
      return fail(chainId, Number(next.id), "deploy", message(error, "转发链部署失败"));
    }
  }
  const host = (await db.getHostById(Number(next.hostId))) as any;
  if (!host) return fail(chainId, Number(next.id), "deploy", "主机不存在");
  if (index === nodes.length - 1) {
    if (Number(chain.landingServiceId) > 0) {
      const service = await db.getLandingServiceById(Number(chain.landingServiceId), true) as any;
      if (service && Number(service.hostId) === Number(next.hostId) && service.isEnabled !== false) {
        await db.updateFullChainNode(Number(next.id), { deployStatus: "done", deployMessage: "复用已有落地 SS" });
        await finishDeploy(chainId);
        return;
      }
    }
    const landing = await db.getLandingHostByHostId(Number(next.hostId));
    if (!landing)
      return fail(chainId, Number(next.id), "deploy", "末端主机不是落地机");
    const serviceId = await db.createLandingService({
      hostId: Number(next.hostId),
      userId: Number(chain.userId),
      name: chain.name,
      protocol: chain.ssProtocol,
      method: chain.method,
      password: chain.password,
      port: Number(chain.port),
      endpoint: endpoint(host),
      latencyTargetHost: "www.gstatic.com",
      latencyTargetPort: 443,
      isEnabled: true,
      status: "pending",
      statusMessage: "全链路正在部署末端 SS",
      isFullChainManaged: true,
    } as any);
    await db.updateFullChain(chainId, {
      landingServiceId: serviceId,
      statusMessage: "正在部署末端 SS",
    });
    pushAgentRefresh(Number(next.hostId), "full-chain-landing-create", {
      urgent: true,
    });
    return;
  }
  const downstream = nodes[index + 1];
  const targetIp = (await nodeEntry(downstream)).ip;
  if (!targetIp)
    return fail(chainId, Number(next.id), "deploy", "下一跳没有可用入口 IP");
  const ruleId = await db.createForwardRule({
    userId: Number(chain.userId),
    hostId: Number(next.hostId),
    name: `[全链路:${chainId}] ${chain.name} ${index + 1}/${nodes.length - 1}`,
    forwardType: "iptables",
    protocol: chain.protocol,
    sourcePort: Number(chain.port),
    targetIp,
    targetPort: Number(chain.port),
    isEnabled: true,
    telegramErrorNotifyEnabled: false,
    blockHttp: false,
    blockSocks: false,
    blockTls: false,
  } as any);
  await db.updateFullChainNode(Number(next.id), { generatedRuleId: ruleId });
  pushAgentRefresh(Number(next.hostId), "full-chain-forward-create", {
    urgent: true,
  });
}

async function finishDeploy(chainId: number) {
  const chain = (await db.getFullChainById(chainId)) as any;
  if (!chain) return;
  const nodes = await db.getFullChainNodes(chainId);
  const protectedNodes = nodes.slice(1, -1).filter((node: any) => String(node.nodeType || "host") !== "forward-chain");
  if (chain.allowPublicIntermediate || protectedNodes.length === 0) {
    for (const node of protectedNodes)
      await db.updateFullChainNode(Number(node.id), { firewallStatus: "done" });
    await db.updateFullChain(chainId, {
      status: "running",
      statusMessage: "全链路可用",
    });
    return;
  }
  for (const [index, node] of nodes.entries()) {
    if (index === 0 || index === nodes.length - 1) continue;
    if (String(node.nodeType || "host") === "forward-chain") continue;
    if (!await nodeExitIp(nodes[index - 1]))
      return fail(
        chainId,
        Number(node.id),
        "deploy",
        "上一跳没有公网 IP，无法限制中转入口",
      );
    await db.updateFullChainNode(Number(node.id), {
      firewallStatus: "checking",
    });
    pushAgentRefresh(Number(node.hostId), "full-chain-firewall-apply", {
      urgent: true,
    });
  }
  await db.updateFullChain(chainId, {
    status: "deploying",
    statusMessage: "正在限制中转入口 IP",
  });
}

export async function startFullChain(chainId: number) {
  const chain = (await db.getFullChainById(chainId)) as any;
  if (!chain) throw new Error("全链路不存在");
  const nodes = await db.getFullChainNodes(chainId);
  if (nodes.length < 2) throw new Error("全链路至少需要两台机器");
  const ignoredRuleIds = Number(chain.replacesChainId) > 0
    ? (await db.getFullChainNodes(Number(chain.replacesChainId)))
      .map((node: any) => Number(node.generatedRuleId || 0))
      .filter((id: number) => id > 0)
    : undefined;
  for (const node of nodes) {
    if (String(node.nodeType || "host") === "forward-chain") continue;
    if (
      await db.isPortUsedOnHost(
        Number(node.hostId),
        Number(chain.port),
        ignoredRuleIds,
        chain.protocol,
      )
    ) {
      await fail(
        chainId,
        Number(node.id),
        "port",
        `端口 ${chain.port} 已被面板中的规则占用`,
      );
      return;
    }
  }
  for (const node of nodes) {
    const referenced = String(node.nodeType || "host") === "forward-chain";
    await db.updateFullChainNode(Number(node.id), {
      portStatus: referenced ? "available" : "checking",
      portMessage: null,
      protocolStatus: referenced ? "available" : String(chain.protocol) === "both" ? "checking" : "pending",
      protocolMessage: null,
      deployStatus: "pending",
      deployMessage: null,
      firewallStatus: "pending",
    });
  }
  await db.updateFullChain(chainId, {
    status: "checking-link",
    statusMessage: "正在检查链路端口和 UDP",
    landingServiceId: null,
    isEnabled: true,
  });
  for (const node of nodes) if (String(node.nodeType || "host") !== "forward-chain")
    pushAgentRefresh(Number(node.hostId), "full-chain-check", { urgent: true });
}

export async function startFullChainProtocolCheck(chainId: number) {
  const chain = (await db.getFullChainById(chainId)) as any;
  if (!chain) throw new Error("全链路不存在");
  if (String(chain.protocol) === "tcp") {
    await db.updateFullChain(chainId, {
      status: "ready-to-deploy",
      statusMessage: "TCP 端口检查完成，可以开始部署",
    });
    return;
  }
  const nodes = await db.getFullChainNodes(chainId);
  if (
    !nodes.length ||
    nodes.some((node: any) => node.portStatus !== "available")
  )
    throw new Error("请先完成端口检查");
  for (const node of nodes)
    await db.updateFullChainNode(Number(node.id), {
      protocolStatus: String(node.nodeType || "host") === "forward-chain" ? "available" : "checking",
      protocolMessage: null,
    });
  await db.updateFullChain(chainId, {
    status: "checking-protocol",
    statusMessage: "正在逐台检查 UDP 协议",
  });
  for (const node of nodes) if (String(node.nodeType || "host") !== "forward-chain")
    pushAgentRefresh(Number(node.hostId), "full-chain-protocol-check", {
      urgent: true,
    });
}

export async function startFullChainLatencyCheck(chainId: number) {
  const chain = (await db.getFullChainById(chainId)) as any;
  if (!chain || chain.isEnabled === false || String(chain.status) === "cancelled") return false;
  const nodes = await db.getFullChainNodes(chainId);
  const hops = nodes.slice(0, -1);
  if (!hops.length) return false;
  const batchId = createHopTestBatch("full-chain", chainId);
  await db.updateFullChain(chainId, { latencyBatchId: batchId, latestLatencyMs: null });
  const unavailable: any[] = [];
  for (const [index, node] of hops.entries()) {
    const target = nodes[index + 1];
    const sourceEntry = await nodeEntry(node);
    const targetEntry = await nodeEntry(target);
    const targetIp = targetEntry.ip;
    const sourceName = node.forwardGroupName || node.hostName || `主机${sourceEntry.hostId}`;
    const targetName = target.forwardGroupName || target.hostName || `主机${targetEntry.hostId}`;
    const meta = { kind: "full-chain", chainId, nodeId: Number(node.id), targetIp, targetPort: Number(chain.port), method: "tcp", hopLabel: `${index + 1}/${hops.length}`, routeLabel: `${sourceName} -> ${targetName}`, batchId, latencyMode: "remaining-path" as const };
    registerHopTest(batchId, Number(node.id));
    await db.updateFullChainNode(Number(node.id), { latencyStatus: "checking", latencyMs: null, latencyDetails: null });

    // A referenced chain must be measured from its real member hosts. Asking
    // its entry host to connect back to its own public listener depends on NAT
    // hairpin support and can fail even while every real hop is healthy.
    if (String(node.nodeType || "host") === "forward-chain" && Number(node.generatedRuleId) > 0) {
      const templateRule = await db.getForwardRuleById(Number(node.generatedRuleId));
      const group = await db.getForwardGroupById(Number(node.forwardGroupId)) as any;
      const probes = await db.getForwardGroupChainProbes(Number(node.forwardGroupId), { includeFinalTarget: true, templateRule });
      if (probes.length) {
        const detailLatencyMode = probes.some((probe: any) => probe.method === "tcp")
          && ["iptables", "nftables"].includes(String(group?.forwardType || "").trim().toLowerCase())
          ? Number(group?.entryGroupId || 0) > 0 ? "multi-source-remaining-path" : "remaining-path"
          : "sum";
        const detailBatchId = createHopTestBatch("full-chain-detail", Number(node.id));
        for (const [probeIndex, probe] of probes.entries()) {
          const probeKey = -(Number(node.id) * 1000 + probeIndex + 1);
          const probeMeta = {
            kind: "full-chain", chainId, nodeId: Number(node.id), diagnosticOnly: true,
            probeKey, parentBatchId: batchId, batchId: detailBatchId,
            targetIp: probe.targetIp, targetPort: probe.targetPort, method: probe.method,
            hopLabel: probe.hopLabel, routeLabel: probe.routeLabel,
            latencyMode: detailLatencyMode,
          };
          registerHopTest(detailBatchId, probeKey);
          await db.createForwardTest({ ruleId: 0, hostId: Number(probe.fromHostId), userId: Number(chain.userId), status: "pending", listenOk: false, targetReachable: false, forwardOk: false, message: JSON.stringify(probeMeta) } as any);
          pushAgentRefresh(Number(probe.fromHostId), "full-chain-latency-detail", { urgent: true });
        }
        continue;
      }
    }
    if (!targetIp) {
      unavailable.push(meta);
      continue;
    }
    await db.createForwardTest({ ruleId: 0, hostId: sourceEntry.hostId, userId: Number(chain.userId), status: "pending", listenOk: false, targetReachable: false, forwardOk: false, message: JSON.stringify(meta) } as any);
    pushAgentRefresh(sourceEntry.hostId, "full-chain-latency", { urgent: true });
  }
  for (const meta of unavailable)
    await applyFullChainLatencyTestResult(meta, false, null, "下一跳没有可用入口 IP");
  await finishLatencyCheck(chainId);
  return true;
}

export async function applyFullChainLatencyTestResult(meta: any, success: boolean, latencyMs: number | null, detail: string | null) {
  const chainId = Number(meta?.chainId), nodeId = Number(meta?.nodeId);
  if (!chainId || !nodeId) return false;
  const chain = await db.getFullChainById(chainId) as any;
  const activeBatchId = meta?.diagnosticOnly ? meta?.parentBatchId : meta?.batchId;
  if (!chain || !meta?.batchId || String(chain.latencyBatchId || "") !== String(activeBatchId || "")) return true;
  const nodes = await db.getFullChainNodes(chainId);
  const node = nodes.find((item: any) => Number(item.id) === nodeId);
  if (!node || (!meta?.diagnosticOnly && node.latencyStatus !== "checking")) return true;
  let measurable = success && Number.isFinite(Number(latencyMs));
  if (meta?.diagnosticOnly) {
    const aggregate = recordHopTestResult(Number(meta.probeKey), {
      success: measurable,
      latencyMs: measurable ? Number(latencyMs) : null,
      message: detail,
      hopLabel: String(meta.hopLabel || "hop"),
      routeLabel: typeof meta.routeLabel === "string" ? meta.routeLabel : null,
      method: String(meta.method || "tcp"),
    }, {
      successPrefix: "转发链逐跳测试成功",
      failurePrefix: "转发链逐跳测试失败",
      latencyMode: meta.latencyMode === "multi-source-remaining-path" ? "multi-source-remaining-path" : meta.latencyMode === "remaining-path" ? "remaining-path" : "sum",
    });
    if (!aggregate) return true;
    await db.updateFullChainNode(nodeId, { latencyDetails: JSON.stringify(aggregate.details) });
    success = aggregate.success;
    latencyMs = aggregate.latencyMs;
    detail = aggregate.message;
    const nodeIndex = nodes.findIndex((item: any) => Number(item.id) === nodeId);
    const nextNode = nodes[nodeIndex + 1];
    meta = {
      ...meta,
      diagnosticOnly: false,
      batchId: meta.parentBatchId,
      method: "tcp",
      hopLabel: `${nodeIndex + 1}/${Math.max(1, nodes.length - 1)}`,
      routeLabel: `${node.forwardGroupName || node.hostName || "转发链"} -> ${nextNode?.forwardGroupName || nextNode?.hostName || "下一跳"}`,
    };
    measurable = success && Number.isFinite(Number(latencyMs));
  }
  await db.updateFullChainNode(nodeId, { latencyStatus: measurable ? "done" : "error", latencyMs: measurable ? Number(latencyMs) : null });
  const aggregate = recordHopTestResult(nodeId, {
    success: measurable,
    latencyMs: measurable ? Number(latencyMs) : null,
    message: detail,
    hopLabel: String(meta.hopLabel || "hop"),
    routeLabel: typeof meta.routeLabel === "string" ? meta.routeLabel : null,
    method: "tcp",
  }, {
    successPrefix: "全链路逐跳测试成功",
    failurePrefix: "全链路逐跳测试失败",
    latencyMode: "remaining-path",
  });
  if (!aggregate) return true;
  const fresh = await db.getFullChainNodes(chainId), hops = fresh.slice(0, -1);
  const segmentTotal = aggregate.details.reduce((sum, item) => sum + (item.success ? Number(item.latencyMs) || 0 : 0), 0);
  const consistent = aggregate.success && segmentTotal === Number(aggregate.latencyMs);
  const details = aggregate.details.map((item, index) => ({ hostId: hops[index]?.hostId, name: hops[index]?.hostName, latencyMs: item.latencyMs, isTimeout: aggregate.success ? !consistent : !item.success, message: item.message || (aggregate.success && !consistent ? "逐跳延迟与入口总延迟不一致" : null) }));
  await Promise.all(hops.map((node: any, index: number) => db.updateFullChainNode(Number(node.id), { latencyStatus: aggregate.success && !consistent ? "error" : (aggregate.details[index]?.success ? "done" : "error"), latencyMs: aggregate.details[index]?.latencyMs ?? null })));
  await db.updateFullChain(chainId, { latestLatencyMs: consistent ? aggregate.latencyMs : null });
  await db.recordFullChainLatency(chainId, consistent ? aggregate.latencyMs : null, details);
  return true;
}

export async function applyFullChainRuntimeStatus(
  hostId: number,
  forwardType: string,
  isRunning: boolean,
  rawMessage: string,
) {
  const match = new RegExp(
    `^${runtimePrefix}(port|protocol|latency|firewall)-(\\d+)-(\\d+)$`,
  ).exec(forwardType);
  if (!match) return false;
  const phase = match[1] as "port" | "protocol" | "latency" | "firewall";
  const chainId = Number(match[2]);
  const nodeId = Number(match[3]);
  const nodes = await db.getFullChainNodes(chainId);
  const node = nodes.find(
    (item: any) => Number(item.id) === nodeId && Number(item.hostId) === hostId,
  );
  if (!node) return true;
  if (phase === "latency") {
    return true;
  }
  if (phase === "firewall") {
    const chain = (await db.getFullChainById(chainId)) as any;
    const removing =
      chain?.isEnabled === false ||
      String(chain?.status) === "cancelled" ||
      String(chain?.status) === "replaced";
    await db.updateFullChainNode(nodeId, {
      firewallStatus: removing ? "pending" : isRunning ? "done" : "error",
    });
    if (removing) return true;
    if (!isRunning) {
      await fail(
        chainId,
        nodeId,
        "deploy",
        message(rawMessage, "中转入口防火墙部署失败"),
      );
      return true;
    }
    const fresh = await db.getFullChainNodes(chainId);
    if (
      fresh.slice(1, -1).filter((item: any) => String(item.nodeType || "host") !== "forward-chain").every((item: any) => item.firewallStatus === "done")
    ) {
      await db.updateFullChain(chainId, {
        status: "running",
        statusMessage: "全链路可用",
      });
    }
    return true;
  }
  const detail = message(
    rawMessage,
    isRunning
      ? phase === "port"
        ? "端口可用"
        : "协议可用"
      : phase === "port"
        ? "端口不可用"
        : "UDP 不支持",
  );
  if (!isRunning) {
    await fail(chainId, nodeId, phase, detail);
    return true;
  }
  const statusColumn = phase === "port" ? "portStatus" : "protocolStatus";
  const messageColumn = phase === "port" ? "portMessage" : "protocolMessage";
  await db.updateFullChainNode(nodeId, {
    [statusColumn]: "available",
    [messageColumn]: detail,
  });
  const fresh = await db.getFullChainNodes(chainId);
  const chain = (await db.getFullChainById(chainId)) as any;
  if (
    phase === "port" &&
    fresh.every((item: any) => item.portStatus === "available") &&
    String(chain?.protocol) === "tcp"
  ) {
    await db.updateFullChain(chainId, {
      status: "ready-to-deploy",
      statusMessage: "端口检查完成，可以创建链路",
    });
  } else if (
    phase === "protocol" &&
    fresh.every((item: any) => item.protocolStatus === "available")
  ) {
    await db.updateFullChain(chainId, {
      status: "ready-to-deploy",
      statusMessage: "链路检查完成，可以创建链路",
    });
  }
  return true;
}

export async function applyFullChainRuleStatus(
  ruleId: number,
  isRunning: boolean,
  rawMessage: string,
) {
  let node = (await db.getFullChainNodeByRuleId(ruleId)) as any;
  const reportedRule = !node ? await db.getForwardRuleById(ruleId) as any : null;
  if (!node && Number(reportedRule?.forwardGroupRuleId) > 0) {
    node = await db.getFullChainNodeByRuleId(Number(reportedRule.forwardGroupRuleId)) as any;
  }
  if (!node) return false;
  const chain = (await db.getFullChainById(Number(node.chainId))) as any;
  if (!chain || chain.isEnabled === false || ["cancelled", "replaced"].includes(String(chain.status))) return true;
  const detail = message(rawMessage, isRunning ? "部署完毕" : "部署失败");
  if (!isRunning) {
    await fail(Number(node.chainId), Number(node.id), "deploy", detail);
    return true;
  }
  if (String(node.nodeType || "host") === "forward-chain") {
    const childRules = await db.getForwardGroupChildRulesForTemplate(Number(node.generatedRuleId));
    const activeRules = childRules.filter((rule: any) => rule.isEnabled !== false && !rule.pendingDelete);
    if (!activeRules.length || activeRules.some((rule: any) => !rule.isRunning)) return true;
  }
  await db.updateFullChainNode(Number(node.id), {
    deployStatus: "done",
    deployMessage: detail,
  });
  await beginDeploy(Number(node.chainId));
  return true;
}

export async function deployFullChain(chainId: number) {
  const chain = (await db.getFullChainById(chainId)) as any;
  if (!chain) throw new Error("全链路不存在");
  if (String(chain.status) !== "ready-to-deploy")
    throw new Error("请先完成端口和协议检查");
  if (Number(chain.replacesChainId) > 0) {
    const replacedChainId = Number(chain.replacesChainId);
    const replaced = (await db.getFullChainById(replacedChainId)) as any;
    const oldNodes = await db.getFullChainNodes(replacedChainId);
    const nextNodes = await db.getFullChainNodes(chainId);
    const reuseLandingService =
      Number(replaced?.landingServiceId) > 0 &&
      Number(oldNodes.at(-1)?.hostId) === Number(nextNodes.at(-1)?.hostId) &&
      Number(replaced?.port) === Number(chain.port) &&
      String(replaced?.ssProtocol) === String(chain.ssProtocol) &&
      String(replaced?.method) === String(chain.method) &&
      String(replaced?.password) === String(chain.password);
    await cancelFullChain(replacedChainId, { preserveLandingService: reuseLandingService });
    await db.moveFullChainTraffic(replacedChainId, chainId);
    await db.deleteFullChain(replacedChainId);
    if (reuseLandingService) await db.updateLandingService(Number(replaced.landingServiceId), { name: chain.name });
    await db.updateFullChain(chainId, { replacesChainId: null, landingServiceId: reuseLandingService ? Number(replaced.landingServiceId) : null });
  }
  await beginDeploy(chainId);
}

export async function applyFullChainLandingStatus(
  serviceId: number,
  isRunning: boolean,
  rawMessage: string,
) {
  const chains = await db.listFullChains();
  const chain = chains.find(
    (item: any) => Number(item.landingServiceId) === serviceId,
  );
  if (!chain) return false;
  const node = chain.nodes[chain.nodes.length - 1];
  if (node?.deployStatus !== "checking") return true;
  const detail = message(rawMessage, isRunning ? "部署完毕" : "部署失败");
  if (!isRunning) {
    await fail(Number(chain.id), Number(node.id), "deploy", detail);
    return true;
  }
  await db.updateFullChainNode(Number(node.id), {
    deployStatus: "done",
    deployMessage: detail,
  });
  await finishDeploy(Number(chain.id));
  return true;
}

export async function cancelFullChain(chainId: number, { preserveLandingService = false } = {}) {
  const chain = (await db.getFullChainById(chainId)) as any;
  if (!chain) return;
  const nodes = await db.getFullChainNodes(chainId);
  for (const node of nodes) {
    if (String(node.nodeType || "host") !== "forward-chain" && (node.firewallStatus === "done" || node.firewallStatus === "checking")) {
      await db.updateFullChainNode(Number(node.id), {
        firewallStatus: "removing",
      });
      pushAgentRefresh(Number(node.hostId), "full-chain-firewall-remove", {
        urgent: true,
      });
    }
    if (Number(node.generatedRuleId) > 0) {
      if (String(node.nodeType || "host") === "forward-chain" && Number(node.forwardGroupId) > 0) {
        await db.withForwardGroupSyncTransaction(Number(node.forwardGroupId), () => db.deleteForwardRule(Number(node.generatedRuleId)));
      } else {
        await db.deleteForwardRule(Number(node.generatedRuleId));
      }
      const entry = await nodeEntry(node).catch(() => ({ hostId: Number(node.hostId || 0) }));
      if (entry.hostId > 0) pushAgentRefresh(entry.hostId, "full-chain-cancel", {
        urgent: true,
      });
    }
  }
  if (!preserveLandingService && Number(chain.landingServiceId) > 0) {
    const service = (await db.getLandingServiceById(
      Number(chain.landingServiceId),
      true,
    )) as any;
    if (service) {
      await db.updateLandingService(Number(service.id), {
        isEnabled: false,
        status: "removing",
        statusMessage: "全链路取消，正在清理",
      });
      pushAgentRefresh(Number(service.hostId), "full-chain-cancel", {
        urgent: true,
      });
    }
  }
  await db.updateFullChain(chainId, {
    status: "cancelled",
    statusMessage: "已请求清理已部署端口",
    isEnabled: false,
  });
}

// A lost Agent must not leave a half-built public listener behind.  The
// heartbeat path advances the timestamp for every acknowledged step; silence
// beyond this bound is treated exactly like pressing “取消并清理”.
const fullChainWatchdog = setInterval(() => {
  void (async () => {
    for (const chain of await db.listFullChains()) {
      const nodes = (chain as any).nodes || [];
      const staleLatencyNodes = nodes.slice(0, -1).filter((node: any) => node.latencyStatus === "checking" && Date.now() - timestamp(node.updatedAt) > LATENCY_TIMEOUT_MS);
      for (const node of staleLatencyNodes) await db.updateFullChainNode(Number(node.id), { latencyStatus: "error", latencyMs: null });
      if (staleLatencyNodes.length) await finishLatencyCheck(Number((chain as any).id));
      if (
        !["checking-link", "checking-port", "checking-protocol", "deploying"].includes(
          String((chain as any).status),
        )
      )
        continue;
      const newest = Math.max(
        timestamp((chain as any).updatedAt),
        ...nodes.map((node: any) => timestamp(node.updatedAt)),
      );
      if (
        Number.isFinite(newest) &&
        Date.now() - newest > AGENT_STEP_TIMEOUT_MS
      ) {
        await cancelFullChain(Number((chain as any).id));
        await db.updateFullChain(Number((chain as any).id), {
          status: "error",
          statusMessage: "Agent 响应超时，已自动清理已部署端口",
        });
      }
    }
  })().catch(() => undefined);
}, 30 * 1000);
fullChainWatchdog.unref?.();
