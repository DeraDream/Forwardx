const METHODS = new Set([
  "aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305",
]);

const decodeBase64 = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
};

export function parseShadowsocksUri(value: string) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("ss://")) throw new Error("请输入 ss:// 开头的 Shadowsocks 链接");
  const [body, fragment = ""] = raw.slice(5).split("#", 2);
  const decodedFragment = fragment ? decodeURIComponent(fragment) : "";
  let credentials = "";
  let address = "";
  try {
    const url = new URL(`ss://${body}`);
    const username = decodeURIComponent(url.username);
    try { const decoded = decodeBase64(username); credentials = decoded.includes(":") ? decoded : `${username}:${decodeURIComponent(url.password)}`; } catch { credentials = `${username}:${decodeURIComponent(url.password)}`; }
    address = url.host;
  } catch {
    try {
      const decoded = decodeBase64(body.split("?")[0]);
      const separator = decoded.lastIndexOf("@");
      if (separator < 1) throw new Error();
      credentials = decoded.slice(0, separator);
      address = decoded.slice(separator + 1);
    } catch {
      throw new Error("SS 链接格式无效");
    }
  }
  const separator = credentials.indexOf(":");
  const method = credentials.slice(0, separator);
  const password = credentials.slice(separator + 1);
  const hostPort = new URL(`ss://${address}`);
  const port = Number(hostPort.port);
  if (!METHODS.has(method) || !password || !hostPort.hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SS 链接缺少或包含不支持的加密、密码、地址或端口");
  return { protocol: method.startsWith("2022-") ? "ss2022" as const : "ss" as const, method, password, endpoint: hostPort.hostname.replace(/^\[|\]$/g, ""), port, name: decodedFragment };
}
