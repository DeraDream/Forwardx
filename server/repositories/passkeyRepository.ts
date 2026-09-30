import crypto from "crypto";
import { executeRaw, queryRaw, quoteDbIdentifier } from "../dbRuntime";

export type StoredPasskeyCredential = {
  id: number;
  userId: number;
  credentialId: string;
  publicKeyJwk: string;
  algorithm: number;
  counter: number;
  transports: string | null;
  authenticatorAttachment: string | null;
  createdAt: Date | number | null;
  lastUsedAt: Date | number | null;
};

const q = quoteDbIdentifier;

export async function ensureUserPasskeyHandle(userId: number) {
  const rows = await queryRaw<{ passkeyUserHandle?: string | null }>(
    `SELECT ${q("passkeyUserHandle")} AS ${q("passkeyUserHandle")} FROM ${q("users")} WHERE ${q("id")} = ? LIMIT 1`,
    [userId],
  );
  const existing = String(rows[0]?.passkeyUserHandle || "").trim();
  if (existing) return existing;
  const handle = crypto.randomBytes(32).toString("base64url");
  await executeRaw(
    `UPDATE ${q("users")} SET ${q("passkeyUserHandle")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`,
    [handle, new Date(), userId],
  );
  return handle;
}

export async function getUserPasskeyCredentials(userId: number): Promise<StoredPasskeyCredential[]> {
  return queryRaw<StoredPasskeyCredential>(
    `SELECT ${q("id")} AS ${q("id")},
            ${q("userId")} AS ${q("userId")},
            ${q("credentialId")} AS ${q("credentialId")},
            ${q("publicKeyJwk")} AS ${q("publicKeyJwk")},
            ${q("algorithm")} AS ${q("algorithm")},
            ${q("counter")} AS ${q("counter")},
            ${q("transports")} AS ${q("transports")},
            ${q("authenticatorAttachment")} AS ${q("authenticatorAttachment")},
            ${q("createdAt")} AS ${q("createdAt")},
            ${q("lastUsedAt")} AS ${q("lastUsedAt")}
       FROM ${q("passkey_credentials")}
      WHERE ${q("userId")} = ?
      ORDER BY ${q("id")} ASC`,
    [userId],
  );
}

export async function getPasskeyCredentialByCredentialId(credentialId: string): Promise<StoredPasskeyCredential | null> {
  const rows = await queryRaw<StoredPasskeyCredential>(
    `SELECT ${q("id")} AS ${q("id")},
            ${q("userId")} AS ${q("userId")},
            ${q("credentialId")} AS ${q("credentialId")},
            ${q("publicKeyJwk")} AS ${q("publicKeyJwk")},
            ${q("algorithm")} AS ${q("algorithm")},
            ${q("counter")} AS ${q("counter")},
            ${q("transports")} AS ${q("transports")},
            ${q("authenticatorAttachment")} AS ${q("authenticatorAttachment")},
            ${q("createdAt")} AS ${q("createdAt")},
            ${q("lastUsedAt")} AS ${q("lastUsedAt")}
       FROM ${q("passkey_credentials")}
      WHERE ${q("credentialId")} = ?
      LIMIT 1`,
    [credentialId],
  );
  return rows[0] || null;
}

export async function savePasskeyCredential(input: {
  userId: number;
  credentialId: string;
  publicKeyJwk: string;
  algorithm: number;
  counter: number;
  transports?: string[];
  authenticatorAttachment?: string | null;
}) {
  const now = new Date();
  await executeRaw(
    `INSERT INTO ${q("passkey_credentials")} (
       ${q("userId")}, ${q("credentialId")}, ${q("publicKeyJwk")}, ${q("algorithm")},
       ${q("counter")}, ${q("transports")}, ${q("authenticatorAttachment")}, ${q("createdAt")}
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.credentialId,
      input.publicKeyJwk,
      input.algorithm,
      Math.max(0, Math.floor(input.counter || 0)),
      input.transports?.filter(Boolean).join(",") || null,
      input.authenticatorAttachment || null,
      now,
    ],
  );
  await setUserPasskeyEnabled(input.userId, true);
}

export async function updatePasskeyCredentialCounter(id: number, counter: number) {
  await executeRaw(
    `UPDATE ${q("passkey_credentials")}
        SET ${q("counter")} = ?, ${q("lastUsedAt")} = ?
      WHERE ${q("id")} = ?`,
    [Math.max(0, Math.floor(counter || 0)), new Date(), id],
  );
}

export async function deleteUserPasskeyCredential(userId: number, credentialId: string) {
  await executeRaw(
    `DELETE FROM ${q("passkey_credentials")} WHERE ${q("userId")} = ? AND ${q("credentialId")} = ?`,
    [userId, credentialId],
  );
  const remaining = await countUserPasskeys(userId);
  if (remaining === 0) await setUserPasskeyEnabled(userId, false);
  return remaining;
}

export async function countUserPasskeys(userId: number) {
  const rows = await queryRaw<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM ${q("passkey_credentials")} WHERE ${q("userId")} = ?`,
    [userId],
  );
  return Number(rows[0]?.count || 0);
}

export async function setUserPasskeyEnabled(userId: number, enabled: boolean) {
  if (enabled && (await countUserPasskeys(userId)) === 0) {
    throw new Error("该用户尚未绑定 Passkey");
  }
  await executeRaw(
    `UPDATE ${q("users")}
        SET ${q("passkeyEnabled")} = ?, ${q("passkeyEnabledAt")} = ?, ${q("updatedAt")} = ?
      WHERE ${q("id")} = ?`,
    [enabled, enabled ? new Date() : null, new Date(), userId],
  );
}

export async function resetUserPasskeys(userId: number) {
  await executeRaw(`DELETE FROM ${q("passkey_credentials")} WHERE ${q("userId")} = ?`, [userId]);
  await executeRaw(
    `UPDATE ${q("users")}
        SET ${q("passkeyEnabled")} = ?, ${q("passkeyEnabledAt")} = NULL,
            ${q("passkeyUserHandle")} = NULL, ${q("updatedAt")} = ?
      WHERE ${q("id")} = ?`,
    [false, new Date(), userId],
  );
}
