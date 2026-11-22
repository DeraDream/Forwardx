import { execFileSync } from "node:child_process";
import os from "node:os";
import { isIP } from "node:net";

type InterfaceAddress = {
  address: string;
  family: string | number;
  internal?: boolean;
};

type InterfaceMap = Record<string, InterfaceAddress[] | undefined>;

function ipv4Parts(value: string) {
  if (isIP(value) !== 4) return null;
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

export function isDirectPublicIpv4(value: string) {
  const parts = ipv4Parts(String(value || "").trim());
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function selectLinkSpeedHost(input: {
  configured?: string | null;
  routeOutput?: string | null;
  interfaces?: InterfaceMap | null;
}) {
  const configured = String(input.configured || "").trim();
  if (configured) return configured;

  const routeSource = String(input.routeOutput || "").match(/(?:^|\s)src\s+(\d+\.\d+\.\d+\.\d+)(?:\s|$)/)?.[1] || "";
  if (isDirectPublicIpv4(routeSource)) return routeSource;

  const candidates = Object.values(input.interfaces || {}).flatMap((addresses) => addresses || [])
    .filter((address) => !address.internal && (address.family === "IPv4" || address.family === 4))
    .map((address) => String(address.address || "").trim())
    .filter(isDirectPublicIpv4)
    .sort();
  return candidates[0] || "";
}

let cachedHost = "";
let cachedAt = 0;

export function resolveLinkSpeedHost() {
  const configured = String(process.env.FORWARDX_LINK_SPEED_HOST || "").trim();
  if (configured) return configured;
  const now = Date.now();
  if (cachedHost && now - cachedAt < 5 * 60_000) return cachedHost;
  let routeOutput = "";
  try {
    routeOutput = execFileSync("ip", ["-4", "route", "get", "1.1.1.1"], {
      encoding: "utf8",
      timeout: 1_500,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Fall back to Node's interface inventory on hosts without iproute2.
  }
  cachedHost = selectLinkSpeedHost({
    routeOutput,
    interfaces: os.networkInterfaces() as InterfaceMap,
  });
  cachedAt = now;
  return cachedHost;
}
