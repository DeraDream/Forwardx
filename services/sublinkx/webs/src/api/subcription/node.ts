import request from "@/utils/request";
export function getNodes(params?: any){
  return request({
    url: "/api/v1/nodes/get",
    method: "get",
    params,
  });
}

export function exportNodes(){
  return request({
    url: "/api/v1/nodes/export",
    method: "get",
    responseType: "arraybuffer",
  });
}

export function importNodes(data: FormData){
  return request({
    url: "/api/v1/nodes/import",
    method: "post",
    data,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}

export function AddNodes(data: any){
  return request({
    url: "/api/v1/nodes/add",
    method: "post",
    data,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}
export function UpdateNode(data: any){
  return request({
    url: "/api/v1/nodes/update",
    method: "post",
    data,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}
export function DelNode(data: any){
  return request({
    url: "/api/v1/nodes/delete",
    method: "delete",
    params: data,
  });
}
export function setNodeDisabled(data: any){
  return request({
    url: "/api/v1/nodes/disabled",
    method: "post",
    data,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}
// 获取全部分组
export function GetGroup(){
  return request({
    url: "/api/v1/nodes/group/get",
    method: "get",
  });
}
// 设置关联分组
export function SetGroup(data: any){
  return request({
    url: "/api/v1/nodes/group/set",
    method: "post",
    data,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}
// 删除分组

export function DelGroup(data: any){
  return request({
    url: "/api/v1/nodes/group/delete",
    method: "delete",
    params: data,
  });
}
