import request from "@/utils/request";

export function getNodeSubscriptions() {
  return request({
    url: "/api/v1/node-subscription/get",
    method: "get",
  });
}

export function addNodeSubscription(data: any) {
  return request({
    url: "/api/v1/node-subscription/add",
    method: "post",
    data,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}

export function updateNodeSubscription(data: any) {
  return request({
    url: "/api/v1/node-subscription/update",
    method: "post",
    data,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}

export function deleteNodeSubscription(data: any) {
  return request({
    url: "/api/v1/node-subscription/delete",
    method: "delete",
    params: data,
  });
}

export function resetNodeSubscriptionToken(data: any) {
  return request({
    url: "/api/v1/node-subscription/reset-token",
    method: "post",
    data,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}

export function setNodeSubscriptionRevoked(data: any) {
  return request({
    url: "/api/v1/node-subscription/revoked",
    method: "post",
    data,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}
