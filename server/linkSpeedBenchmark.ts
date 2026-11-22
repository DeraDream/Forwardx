import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { getLinkSpeedBenchmarkLease } from "./linkSpeedTasks";

const UDP_HEADER = 49;
const UDP_PACKET_SIZE = 1200;
const SAMPLE_INTERVAL_MS = 100;

type MeterResult = {
  bytes: number;
  durationMs: number;
  mbps: number;
  peakMbps: number;
  packets?: number;
  sentPackets?: number;
  lostPackets?: number;
  lossPercent?: number;
  jitterMs?: number;
};

function measurement(bytes: number, startedAt: number, peakMbps: number): MeterResult {
  const durationMs = Math.max(1, Date.now() - startedAt);
  return { bytes, durationMs, mbps: bytes * 8 / durationMs / 1000, peakMbps };
}

function writeFrame(socket: net.Socket, payload: Buffer) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return socket.write(Buffer.concat([header, payload]));
}

async function sendTcpDownload(socket: net.Socket, duration: number, rateMbps: number) {
  const payload = crypto.randomBytes(64 * 1024);
  const startedAt = Date.now();
  let bytes = 0;
  while (Date.now() - startedAt < duration * 1000 && !socket.destroyed) {
    if (!writeFrame(socket, payload)) await new Promise<void>((resolve) => socket.once("drain", resolve));
    bytes += payload.length;
    if (rateMbps > 0) {
      const expectedMs = bytes * 8 / rateMbps / 1000;
      const wait = expectedMs - (Date.now() - startedAt);
      if (wait > 1) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  writeFrame(socket, Buffer.alloc(0));
}

function handleTcp(socket: net.Socket) {
  socket.setNoDelay(true);
  socket.setTimeout(75_000, () => socket.destroy());
  let buffer = Buffer.alloc(0);
  let authenticated = false;
  let operation = "";
  let frameLength: number | null = null;
  let bytes = 0;
  let startedAt = 0;
  let lastAt = 0;
  let lastBytes = 0;
  let peakMbps = 0;
  const sendUpdate = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!authenticated) {
      if (buffer.length < 65) return;
      const token = buffer.subarray(0, 64).toString("ascii");
      const lease = getLinkSpeedBenchmarkLease(token);
      if (!lease) return socket.destroy();
      operation = String.fromCharCode(buffer[64]);
      buffer = buffer.subarray(65);
      authenticated = true;
      startedAt = lastAt = Date.now();
      socket.write(Buffer.from([1]));
      if (operation === "D") {
        void sendTcpDownload(socket, lease.duration, lease.rateMbps).catch(() => socket.destroy());
        return;
      }
      if (operation !== "U") return socket.destroy();
    }
    if (operation !== "U") return;
    while (true) {
      if (frameLength === null) {
        if (buffer.length < 4) return;
        frameLength = buffer.readUInt32BE(0);
        buffer = buffer.subarray(4);
        if (frameLength > 64 * 1024) return socket.destroy();
        if (frameLength === 0) {
          sendUpdate({ result: measurement(bytes, startedAt, peakMbps) });
          return;
        }
      }
      if (buffer.length < frameLength) return;
      bytes += frameLength;
      buffer = buffer.subarray(frameLength);
      frameLength = null;
      const now = Date.now();
      if (now - lastAt >= SAMPLE_INTERVAL_MS) {
        const mbps = (bytes - lastBytes) * 8 / (now - lastAt) / 1000;
        peakMbps = Math.max(peakMbps, mbps);
        sendUpdate({ sample: { direction: "upload", elapsedMs: now - startedAt, bytes, mbps } });
        lastAt = now;
        lastBytes = bytes;
      }
    }
  });
  socket.on("error", () => undefined);
}

type UdpStats = {
  token: string;
  peer: dgram.RemoteInfo;
  firstAt: number;
  lastAt: number;
  bytes: number;
  packets: number;
  seen: Set<bigint>;
  lastSenderNs: bigint;
  lastArrivalNs: bigint;
  jitterMs: number;
  peakMbps: number;
  sampleAt: number;
  sampleBytes: number;
  downloadStarted: boolean;
  downloadDone: boolean;
  downloadSent: number;
  downloadDurationMs: number;
};

function samePeer(a: dgram.RemoteInfo, b: dgram.RemoteInfo) {
  return a.address === b.address && a.port === b.port;
}

function udpResult(stats: UdpStats, sentPackets: number, durationMs?: number): MeterResult {
  const actualDuration = Math.max(1, durationMs || stats.lastAt - stats.firstAt || 1);
  const lostPackets = Math.max(0, sentPackets - stats.packets);
  return {
    bytes: stats.bytes,
    durationMs: actualDuration,
    mbps: stats.bytes * 8 / actualDuration / 1000,
    peakMbps: stats.peakMbps || stats.bytes * 8 / actualDuration / 1000,
    packets: stats.packets,
    sentPackets,
    lostPackets,
    lossPercent: sentPackets > 0 ? lostPackets * 100 / sentPackets : 0,
    jitterMs: stats.jitterMs,
  };
}

function startUdpServer(port: number) {
  const socket = dgram.createSocket("udp4");
  const states = new Map<string, UdpStats>();
  const packet = (token: Buffer, op: string, sequence = 0n, timestamp = 0n, payload = Buffer.alloc(0)) => {
    const value = Buffer.allocUnsafe(UDP_HEADER + payload.length);
    token.copy(value, 0);
    value[32] = op.charCodeAt(0);
    value.writeBigUInt64BE(sequence, 33);
    value.writeBigUInt64BE(BigInt.asUintN(64, timestamp), 41);
    payload.copy(value, UDP_HEADER);
    return value;
  };
  const reply = (token: Buffer, peer: dgram.RemoteInfo, result: MeterResult, done: boolean) => {
    const payload = Buffer.from(JSON.stringify({ result, done }));
    socket.send(packet(token, "R", 0n, 0n, payload), peer.port, peer.address);
  };
  socket.on("message", (message, peer) => {
    if (message.length < UDP_HEADER) return;
    const tokenBuffer = message.subarray(0, 32);
    const token = tokenBuffer.toString("hex");
    const lease = getLinkSpeedBenchmarkLease(token);
    if (!lease) return;
    const key = `${token}:${peer.address}:${peer.port}`;
    let stats = states.get(key);
    if (!stats) {
      stats = {
        token, peer, firstAt: Date.now(), lastAt: Date.now(), bytes: 0, packets: 0,
        seen: new Set(), lastSenderNs: 0n, lastArrivalNs: 0n, jitterMs: 0,
        peakMbps: 0, sampleAt: Date.now(), sampleBytes: 0,
        downloadStarted: false, downloadDone: false, downloadSent: 0, downloadDurationMs: 0,
      };
      states.set(key, stats);
    }
    if (!samePeer(stats.peer, peer)) return;
    const op = String.fromCharCode(message[32]);
    const sequence = message.readBigUInt64BE(33);
    const timestamp = message.readBigUInt64BE(41);
    if (op === "P") return reply(tokenBuffer, peer, measurement(0, Date.now(), 0), false);
    if (op === "U") {
      if (sequence === 0n || stats.seen.has(sequence)) return;
      stats.seen.add(sequence);
      const now = Date.now();
      const arrivalNs = process.hrtime.bigint();
      if (stats.lastArrivalNs > 0n) {
        const arrivalDelta = arrivalNs - stats.lastArrivalNs;
        const senderDelta = BigInt.asIntN(64, timestamp - stats.lastSenderNs);
        const deltaMs = Math.abs(Number(arrivalDelta - senderDelta) / 1e6);
        stats.jitterMs += (deltaMs - stats.jitterMs) / 16;
      }
      stats.lastArrivalNs = arrivalNs;
      stats.lastSenderNs = timestamp;
      stats.lastAt = now;
      stats.bytes += message.length;
      stats.packets++;
      if (now - stats.sampleAt >= SAMPLE_INTERVAL_MS) {
        const mbps = (stats.bytes - stats.sampleBytes) * 8 / (now - stats.sampleAt) / 1000;
        stats.peakMbps = Math.max(stats.peakMbps, mbps);
        stats.sampleAt = now;
        stats.sampleBytes = stats.bytes;
      }
      return;
    }
    if (op === "S" || op === "F") {
      const sent = Number(sequence);
      const durationMs = op === "F" ? Number(BigInt.asIntN(64, timestamp)) : undefined;
      return reply(tokenBuffer, peer, udpResult(stats, sent, durationMs), op === "F");
    }
    if (op === "D" && !stats.downloadStarted) {
      stats.downloadStarted = true;
      const startedAt = Date.now();
      const payload = crypto.randomBytes(UDP_PACKET_SIZE - UDP_HEADER);
      const timer = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= lease.duration * 1000) {
          clearInterval(timer);
          stats!.downloadDone = true;
          stats!.downloadDurationMs = Math.max(1, elapsedMs);
          return;
        }
        const expected = Math.floor(elapsedMs / 1000 * lease.rateMbps * 1e6 / 8 / UDP_PACKET_SIZE);
        const batchEnd = Math.min(expected, stats!.downloadSent + 256);
        while (stats!.downloadSent < batchEnd) {
          stats!.downloadSent++;
          socket.send(packet(tokenBuffer, "d", BigInt(stats!.downloadSent), BigInt((Date.now() - startedAt) * 1_000_000), payload), peer.port, peer.address);
        }
      }, 1);
      timer.unref?.();
      return;
    }
    if (op === "Q") {
      return reply(tokenBuffer, peer, {
        bytes: 0,
        durationMs: stats.downloadDurationMs,
        mbps: 0,
        peakMbps: 0,
        sentPackets: stats.downloadSent,
      }, stats.downloadDone);
    }
  });
  socket.on("error", (error) => console.error("[LinkSpeed] UDP benchmark server error:", error));
  socket.bind(port, "0.0.0.0", () => console.info(`[LinkSpeed] UDP benchmark listening on 0.0.0.0:${port}`));
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [key, state] of states) if (state.lastAt < cutoff) states.delete(key);
  }, 60_000);
  cleanup.unref?.();
  return socket;
}

export function startLinkSpeedBenchmarkServer() {
  const port = Number.parseInt(process.env.FORWARDX_LINK_SPEED_PORT || "5202", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn("[LinkSpeed] Invalid FORWARDX_LINK_SPEED_PORT; benchmark receiver disabled");
    return null;
  }
  const tcp = net.createServer(handleTcp);
  tcp.on("error", (error) => console.error("[LinkSpeed] TCP benchmark server error:", error));
  tcp.listen(port, "0.0.0.0", () => console.info(`[LinkSpeed] TCP benchmark listening on 0.0.0.0:${port}`));
  const udp = startUdpServer(port);
  return { tcp, udp, port };
}
