// Telegram rejects no-op edits (e.g. polling an unchanged pending probe).
// Only this specific Bot API response is safe to treat as success.
export function isTelegramMessageNotModified(error: unknown): boolean {
  return error instanceof Error && /^Bad Request: message is not modified(?::|$)/i.test(error.message);
}
