import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { listTelegramSubscriptions, resetTelegramSubscriptionToken } from "./sublinkService";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Telegram subscription listing uses server-only authentication", async () => {
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), "http://127.0.0.1:8000/api/v1/subcription/get");
    assert.match(String((options?.headers as Record<string, string>).Authorization), /^Bearer /);
    return new Response(JSON.stringify({ code: "00000", data: [{ ID: 3, Name: "示例", Token: "secret" }] }), { status: 200 });
  }) as typeof fetch;
  const items = await listTelegramSubscriptions();
  assert.equal(items[0].ID, 3);
});

test("Telegram subscription reset sends the selected ID to SublinkX", async () => {
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), "http://127.0.0.1:8000/api/v1/subcription/reset-token");
    assert.equal(options?.method, "POST");
    assert.equal(String(options?.body), "id=3");
    assert.match(String((options?.headers as Record<string, string>).Authorization), /^Bearer /);
    return new Response(JSON.stringify({ code: "00000" }), { status: 200 });
  }) as typeof fetch;
  await resetTelegramSubscriptionToken(3);
});

test("Telegram subscription listing rejects upstream failures", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: "error" }), { status: 200 })) as typeof fetch;
  await assert.rejects(listTelegramSubscriptions(), /订阅列表获取失败/);
});
