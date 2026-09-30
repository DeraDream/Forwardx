function base64urlToBytes(value: string) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(value: ArrayBuffer | ArrayBufferView | null | undefined) {
  if (!value) return "";
  const view = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function ensureWebAuthn() {
  if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("当前浏览器不支持 Passkey / WebAuthn");
  }
}

export async function createPasskeyCredential(options: any) {
  ensureWebAuthn();
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: base64urlToBytes(options.challenge),
    user: { ...options.user, id: base64urlToBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item: any) => ({
      ...item,
      id: base64urlToBytes(item.id),
    })),
  };
  const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential | null;
  if (!credential) throw new Error("未创建 Passkey");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      attestationObject: bytesToBase64url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
  };
}

export async function getPasskeyCredential(options: any) {
  ensureWebAuthn();
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: base64urlToBytes(options.challenge),
    allowCredentials: options.allowCredentials?.map((item: any) => ({
      ...item,
      id: base64urlToBytes(item.id),
    })),
  };
  const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null;
  if (!credential) throw new Error("未选择 Passkey");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      authenticatorData: bytesToBase64url(response.authenticatorData),
      signature: bytesToBase64url(response.signature),
      userHandle: bytesToBase64url(response.userHandle),
    },
  };
}
