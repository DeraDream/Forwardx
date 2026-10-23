import request from "@/utils/request";

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  token_configured: boolean;
  admin_chat_ids: string;
  language: string;
  api_base_url: string;
  public_base_url: string;
}

export function getTelegramConfig() {
  return request({
    url: "/api/v1/telegram/config",
    method: "get",
  });
}

export function updateTelegramConfig(data: TelegramConfig) {
  return request({
    url: "/api/v1/telegram/config",
    method: "post",
    data,
  });
}

export function testTelegramBot(data: TelegramConfig) {
  return request({
    url: "/api/v1/telegram/test",
    method: "post",
    data,
  });
}
