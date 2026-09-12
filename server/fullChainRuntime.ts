import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";

const runtimePrefix = "full-chain-";
const AGENT_STEP_TIMEOUT_MS = 3 * 60 * 1000;
const message = (value: unknown, fallback: string) =>
  String(value || fallback)
    .trim()
    .slice(0, 500);

function endpoint(host: any, ingressIp?: string | null) {
  return String(
    ingressIp || host?.entryIp || host?.ipv4 || host?.ip || "",
  ).trim();
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
  const host = (await db.getHostById(Number(next.hostId))) as any;
  if (!host) return fail(chainId, Number(next.id), "deploy", "主机不存在");
  if (index === nodes.length - 1) {
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
  const targetHost = (await db.getHostById(Number(downstream.hostId))) as any;
  const targetIp = endpoint(targetHost, downstream.ingressIp);
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
  const protectedNodes = nodes.slice(1, -1);
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
    if (!String(nodes[index - 1]?.publicIp || "").trim())
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
  for (const node of nodes) {
    if (
      await db.isPortUsedOnHost(
        Number(node.hostId),
        Number(chain.port),
        undefined,
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
    await db.updateFullChainNode(Number(node.id), {
      portStatus: "checking",
      portMessage: null,
      protocolStatus: String(chain.protocol) === "both" ? "checking" : "pending",
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
  for (const node of nodes)
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
      protocolStatus: "checking",
      protocolMessage: null,
    });
  await db.updateFullChain(chainId, {
    status: "checking-protocol",
    statusMessage: "正在逐台检查 UDP 协议",
  });
  for (const node of nodes)
    pushAgentRefresh(Number(node.hostId), "full-chain-protocol-check", {
      urgent: true,
    });
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
    const latency = Number(/latency_ms=([0-9.]+)/.exec(rawMessage)?.[1] || 0);
    await db.updateFullChainNode(nodeId, {
      latencyStatus: isRunning && latency > 0 ? "done" : "error",
      latencyMs: latency > 0 ? Math.round(latency) : null,
    });
    const fresh = await db.getFullChainNodes(chainId);
    if (fresh.slice(0, -1).every((item: any) => item.latencyStatus !== "checking")) {
      const latestLatencyMs = fresh.slice(0, -1).every((item: any) => item.latencyStatus === "done")
          ? fresh.slice(0, -1).reduce((sum: number, item: any) => sum + Math.max(0, Number(item.latencyMs) || 0), 0)
          : null;
      await db.updateFullChain(chainId, { latestLatencyMs });
      await db.recordFullChainLatency(chainId, latestLatencyMs, fresh.map((item: any, index: number) => ({ hostId: item.hostId, name: item.hostName, latencyMs: index < fresh.length - 1 ? item.latencyMs : null, isTimeout: index < fresh.length - 1 && item.latencyStatus !== "done" })));
    }
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
      fresh.slice(1, -1).every((item: any) => item.firewallStatus === "done")
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
  const node = (await db.getFullChainNodeByRuleId(ruleId)) as any;
  if (!node) return false;
  const detail = message(rawMessage, isRunning ? "部署完毕" : "部署失败");
  if (!isRunning) {
    await fail(Number(node.chainId), Number(node.id), "deploy", detail);
    return true;
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

export async function cancelFullChain(chainId: number) {
  const chain = (await db.getFullChainById(chainId)) as any;
  if (!chain) return;
  const nodes = await db.getFullChainNodes(chainId);
  for (const node of nodes) {
    if (node.firewallStatus === "done" || node.firewallStatus === "checking") {
      await db.updateFullChainNode(Number(node.id), {
        firewallStatus: "removing",
      });
      pushAgentRefresh(Number(node.hostId), "full-chain-firewall-remove", {
        urgent: true,
      });
    }
    if (Number(node.generatedRuleId) > 0) {
      await db.deleteForwardRule(Number(node.generatedRuleId));
      pushAgentRefresh(Number(node.hostId), "full-chain-cancel", {
        urgent: true,
      });
    }
  }
  if (Number(chain.landingServiceId) > 0) {
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
      if (
        !["checking-link", "checking-port", "checking-protocol", "deploying"].includes(
          String((chain as any).status),
        )
      )
        continue;
      const nodes = (chain as any).nodes || [];
      const timestamp = (value: any) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric > 0
          ? numeric < 10_000_000_000
            ? numeric * 1000
            : numeric
          : Number(new Date(value || 0));
      };
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
