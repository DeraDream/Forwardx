/** Only standard Agents can receive managed Shadowsocks landing services. */
export function supportsManagedLandingSS(host: { agentVersion?: string | null } | null | undefined) {
  const version = String(host?.agentVersion || "").trim();
  return !!version && !/-iptables-only(?:\.|$)/i.test(version);
}
