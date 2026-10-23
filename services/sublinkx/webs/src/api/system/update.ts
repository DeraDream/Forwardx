import request from "@/utils/request";

export interface SystemUpdateStatus {
  state:
    | "idle"
    | "queued"
    | "downloading"
    | "installing"
    | "restarting"
    | "completed"
    | "failed";
  message: string;
  progress: number;
  current_version: string;
  target_version: string;
  updated_at?: string;
}

export interface SystemUpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  supported: boolean;
  unsupported_reason: string;
  status: SystemUpdateStatus;
}

export function checkSystemUpdate() {
  return request({
    url: "/api/v1/system/update/check",
    method: "get",
    skipErrorMessage: true,
  } as any);
}

export function getSystemUpdateStatus() {
  return request({
    url: "/api/v1/system/update/status",
    method: "get",
    timeout: 10000,
    skipErrorMessage: true,
  } as any);
}

export function startSystemUpdate() {
  return request({
    url: "/api/v1/system/update/start",
    method: "post",
  });
}
