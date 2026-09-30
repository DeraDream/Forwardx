import crypto from "crypto";

type PasskeyChallenge = {
  challenge: string;
  kind: "register" | "login";
  userId?: number;
  rpId: string;
  origin: string;
  expiresAt: number;
};

type CborResult = { value: any; offset: number };

const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSKEY_MAX_CHALLENGES = 20_000;
const challenges = new Map<string, PasskeyChallenge>();

function pruneChallenges(now = Date.now()) {
  for (const [key, value] of challenges) {
    if (value.expiresAt <= now) challenges.delete(key);
  }
  while (challenges.size > PASSKEY_MAX_CHALLENGES) {
    const first = challenges.keys().next().value;
    if (!first) break;
    challenges.delete(first);
  }
}

function base64url(buffer: Buffer | Uint8Array) {
  return Buffer.from(buffer).toString("base64url");
}

function fromBase64url(value: string) {
  return Buffer.from(String(value || ""), "base64url");
}

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestHost(req: any) {
  const forwarded = String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwarded || String(req?.headers?.host || "").trim();
  return host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
}

export function passkeyRequestContext(req: any) {
  const rpId = requestHost(req);
  if (!rpId) throw new Error("无法确定 Passkey RP ID");
  const protoHeader = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const protocol = protoHeader || (req?.secure ? "https" : "http");
  const hostHeader = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || rpId).split(",")[0].trim();
  const origin = `${protocol}://${hostHeader}`;
  return { rpId, origin };
}

function createChallenge(input: Omit<PasskeyChallenge, "challenge" | "expiresAt">) {
  pruneChallenges();
  const challenge = crypto.randomBytes(32).toString("base64url");
  challenges.set(challenge, { ...input, challenge, expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS });
  return challenge;
}

function getChallenge(challenge: string, kind: PasskeyChallenge["kind"]) {
  pruneChallenges();
  const record = challenges.get(challenge);
  if (!record || record.kind !== kind || record.expiresAt <= Date.now()) return null;
  return record;
}

function consumeChallenge(challenge: string) {
  challenges.delete(challenge);
}

function readLength(buffer: Buffer, offset: number, additional: number) {
  if (additional < 24) return { length: additional, offset };
  if (additional === 24) return { length: buffer.readUInt8(offset), offset: offset + 1 };
  if (additional === 25) return { length: buffer.readUInt16BE(offset), offset: offset + 2 };
  if (additional === 26) return { length: buffer.readUInt32BE(offset), offset: offset + 4 };
  if (additional === 27) {
    const value = Number(buffer.readBigUInt64BE(offset));
    if (!Number.isSafeInteger(value)) throw new Error("CBOR integer is too large");
    return { length: value, offset: offset + 8 };
  }
  throw new Error("Unsupported indefinite CBOR value");
}

function decodeCbor(buffer: Buffer, offset = 0): CborResult {
  if (offset >= buffer.length) throw new Error("Unexpected end of CBOR");
  const first = buffer[offset++];
  const major = first >> 5;
  const additional = first & 0x1f;
  if (major === 0 || major === 1) {
    const read = readLength(buffer, offset, additional);
    return { value: major === 0 ? read.length : -1 - read.length, offset: read.offset };
  }
  if (major === 2 || major === 3) {
    const read = readLength(buffer, offset, additional);
    const end = read.offset + read.length;
    if (end > buffer.length) throw new Error("Invalid CBOR length");
    const raw = buffer.subarray(read.offset, end);
    return { value: major === 2 ? Buffer.from(raw) : raw.toString("utf8"), offset: end };
  }
  if (major === 4) {
    const read = readLength(buffer, offset, additional);
    const values: any[] = [];
    let cursor = read.offset;
    for (let i = 0; i < read.length; i++) {
      const item = decodeCbor(buffer, cursor);
      values.push(item.value);
      cursor = item.offset;
    }
    return { value: values, offset: cursor };
  }
  if (major === 5) {
    const read = readLength(buffer, offset, additional);
    const map = new Map<any, any>();
    let cursor = read.offset;
    for (let i = 0; i < read.length; i++) {
      const key = decodeCbor(buffer, cursor);
      const value = decodeCbor(buffer, key.offset);
      map.set(key.value, value.value);
      cursor = value.offset;
    }
    return { value: map, offset: cursor };
  }
  if (major === 6) {
    const read = readLength(buffer, offset, additional);
    return decodeCbor(buffer, read.offset);
  }
  if (major === 7) {
    if (additional === 20) return { value: false, offset };
    if (additional === 21) return { value: true, offset };
    if (additional === 22 || additional === 23) return { value: null, offset };
  }
  throw new Error("Unsupported CBOR type");
}

function parseClientData(value: string, expectedType: string) {
  const raw = fromBase64url(value);
  let parsed: any;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Passkey clientDataJSON 无效");
  }
  if (parsed?.type !== expectedType) throw new Error("Passkey 操作类型不匹配");
  if (!parsed?.challenge || !parsed?.origin) throw new Error("Passkey 客户端数据不完整");
  if (parsed.crossOrigin === true) throw new Error("不允许跨站 Passkey 操作");
  return { raw, parsed };
}

function verifyContext(record: PasskeyChallenge, clientData: any) {
  if (clientData.challenge !== record.challenge) throw new Error("Passkey challenge 不匹配");
  if (clientData.origin !== record.origin) throw new Error("Passkey Origin 不匹配");
}

function parseAuthenticatorData(authData: Buffer, expectedRpId: string, requireAttestedCredential = false) {
  if (authData.length < 37) throw new Error("Passkey authenticatorData 过短");
  const expectedHash = crypto.createHash("sha256").update(expectedRpId).digest();
  if (!safeEqual(authData.subarray(0, 32), expectedHash)) throw new Error("Passkey RP ID 校验失败");
  const flags = authData[32];
  if ((flags & 0x01) === 0) throw new Error("Passkey 未确认用户在场");
  if ((flags & 0x04) === 0) throw new Error("Passkey 未完成人员验证");
  const counter = authData.readUInt32BE(33);
  if (!requireAttestedCredential) return { flags, counter };
  if ((flags & 0x40) === 0) throw new Error("Passkey 注册数据缺少凭据");
  let offset = 37 + 16;
  if (offset + 2 > authData.length) throw new Error("Passkey 注册数据不完整");
  const credentialIdLength = authData.readUInt16BE(offset);
  offset += 2;
  const credentialEnd = offset + credentialIdLength;
  if (credentialEnd > authData.length) throw new Error("Passkey credential ID 无效");
  const credentialId = Buffer.from(authData.subarray(offset, credentialEnd));
  const cose = decodeCbor(authData, credentialEnd);
  if (!(cose.value instanceof Map)) throw new Error("Passkey 公钥格式无效");
  return { flags, counter, credentialId, coseKey: cose.value as Map<any, any> };
}

function coseToJwk(cose: Map<any, any>) {
  const kty = Number(cose.get(1));
  const alg = Number(cose.get(3));
  if (kty === 2 && alg === -7) {
    const crv = Number(cose.get(-1));
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error("暂不支持此 EC Passkey 公钥");
    return { algorithm: alg, jwk: { kty: "EC", crv: "P-256", x: base64url(x), y: base64url(y), ext: true } };
  }
  if (kty === 3 && alg === -257) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error("暂不支持此 RSA Passkey 公钥");
    return { algorithm: alg, jwk: { kty: "RSA", n: base64url(n), e: base64url(e), ext: true } };
  }
  if (kty === 1 && alg === -8) {
    const crv = Number(cose.get(-1));
    const x = cose.get(-2);
    if (crv !== 6 || !Buffer.isBuffer(x)) throw new Error("暂不支持此 EdDSA Passkey 公钥");
    return { algorithm: alg, jwk: { kty: "OKP", crv: "Ed25519", x: base64url(x), ext: true } };
  }
  throw new Error(`暂不支持此 Passkey 算法 (kty=${kty}, alg=${alg})`);
}

export function beginPasskeyRegistration(input: {
  req: any;
  userId: number;
  username: string;
  displayName?: string | null;
  userHandle: string;
  existingCredentialIds: string[];
}) {
  const { rpId, origin } = passkeyRequestContext(input.req);
  const challenge = createChallenge({ kind: "register", userId: input.userId, rpId, origin });
  return {
    challenge,
    rp: { id: rpId, name: "ForwardX" },
    user: {
      id: input.userHandle,
      name: input.username,
      displayName: input.displayName || input.username,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
      { type: "public-key", alg: -8 },
    ],
    timeout: PASSKEY_CHALLENGE_TTL_MS,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    excludeCredentials: input.existingCredentialIds.map((id) => ({ id, type: "public-key" })),
  };
}

export function finishPasskeyRegistration(input: {
  userId: number;
  credential: any;
}) {
  const response = input.credential?.response;
  const client = parseClientData(String(response?.clientDataJSON || ""), "webauthn.create");
  const record = getChallenge(client.parsed.challenge, "register");
  if (!record || record.userId !== input.userId) throw new Error("Passkey 注册请求已过期，请重试");
  verifyContext(record, client.parsed);
  const attestationRaw = fromBase64url(String(response?.attestationObject || ""));
  const decoded = decodeCbor(attestationRaw);
  if (!(decoded.value instanceof Map)) throw new Error("Passkey attestationObject 无效");
  const authData = decoded.value.get("authData");
  if (!Buffer.isBuffer(authData)) throw new Error("Passkey attestationObject 缺少 authenticatorData");
  const parsed = parseAuthenticatorData(authData, record.rpId, true);
  const rawId = fromBase64url(String(input.credential?.rawId || input.credential?.id || ""));
  if (!parsed.credentialId || !safeEqual(parsed.credentialId, rawId)) throw new Error("Passkey credential ID 不一致");
  const publicKey = coseToJwk(parsed.coseKey!);
  consumeChallenge(record.challenge);
  return {
    credentialId: base64url(parsed.credentialId),
    publicKeyJwk: JSON.stringify(publicKey.jwk),
    algorithm: publicKey.algorithm,
    counter: parsed.counter,
    transports: Array.isArray(response?.transports) ? response.transports.map(String) : [],
    authenticatorAttachment: String(input.credential?.authenticatorAttachment || "") || null,
  };
}

export function beginPasskeyLogin(req: any) {
  const { rpId, origin } = passkeyRequestContext(req);
  const challenge = createChallenge({ kind: "login", rpId, origin });
  return {
    challenge,
    rpId,
    timeout: PASSKEY_CHALLENGE_TTL_MS,
    userVerification: "required",
  };
}

export function finishPasskeyLogin(input: {
  credential: any;
  publicKeyJwk: string;
  algorithm: number;
  storedCounter: number;
}) {
  const response = input.credential?.response;
  const client = parseClientData(String(response?.clientDataJSON || ""), "webauthn.get");
  const record = getChallenge(client.parsed.challenge, "login");
  if (!record) throw new Error("Passkey 登录请求已过期，请重试");
  verifyContext(record, client.parsed);
  const authData = fromBase64url(String(response?.authenticatorData || ""));
  const parsed = parseAuthenticatorData(authData, record.rpId, false);
  const signature = fromBase64url(String(response?.signature || ""));
  const clientHash = crypto.createHash("sha256").update(client.raw).digest();
  const signedData = Buffer.concat([authData, clientHash]);
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(input.publicKeyJwk);
  } catch {
    throw new Error("Passkey 公钥记录无效");
  }
  const key = crypto.createPublicKey({ key: jwk as any, format: "jwk" });
  let verified = false;
  if (input.algorithm === -8) verified = crypto.verify(null, signedData, key, signature);
  else verified = crypto.verify("sha256", signedData, key, signature);
  consumeChallenge(record.challenge);
  if (!verified) throw new Error("Passkey 签名验证失败");
  const previous = Math.max(0, Number(input.storedCounter || 0));
  if (previous > 0 && parsed.counter > 0 && parsed.counter <= previous) {
    throw new Error("Passkey 计数器异常，请重置该 Passkey");
  }
  return { counter: Math.max(previous, parsed.counter), userHandle: String(response?.userHandle || "") };
}
