import request from "@/utils/request";

export interface IPEntry {
  ID: number;
  Alias: string;
  Address: string;
  CreatedAt?: string;
  UpdatedAt?: string;
}

export interface NodeReplacementPreview {
  protocol: "ss" | "vless";
  original_host: string;
  port: number;
  link: string;
  ip_entry: IPEntry;
}

export function getIPEntries() {
  return request({
    url: "/api/v1/ip-library",
    method: "get",
  });
}

export function addIPEntry(data: { alias: string; address: string }) {
  return request({
    url: "/api/v1/ip-library/add",
    method: "post",
    data,
    headers: { "Content-Type": "multipart/form-data" },
  });
}

export function updateIPEntry(data: {
  id: number;
  alias: string;
  address: string;
}) {
  return request({
    url: "/api/v1/ip-library/update",
    method: "post",
    data,
    headers: { "Content-Type": "multipart/form-data" },
  });
}

export function deleteIPEntry(id: number) {
  return request({
    url: "/api/v1/ip-library/delete",
    method: "delete",
    params: { id },
  });
}

export function previewNodeReplacement(data: {
  link: string;
  replace_ip_id: number;
}) {
  return request({
    url: "/api/v1/nodes/replace-preview",
    method: "post",
    data,
    headers: { "Content-Type": "multipart/form-data" },
    skipErrorMessage: true,
  } as any);
}
