import request from "@/utils/request";

export function exportBackup(data: FormData) {
  return request({
    url: "/api/v1/backup/export",
    method: "post",
    data,
    responseType: "arraybuffer",
    headers: { "Content-Type": "multipart/form-data" },
  });
}

export function importBackup(data: FormData) {
  return request({
    url: "/api/v1/backup/import",
    method: "post",
    data,
    headers: { "Content-Type": "multipart/form-data" },
  });
}
