import request from "@/utils/request";
import { AxiosPromise } from "axios";
import { LoginData, LoginResult } from "./types";

/**
 * 登录API
 *
 * @param data {LoginData}
 * @returns
 */
export function loginApi(data: LoginData): AxiosPromise<LoginResult> {
  const formData = new FormData();
  formData.append("username", data.username);
  formData.append("password", data.password);
  return request({
    url: "/api/v1/auth/login",
    method: "post",
    data: formData,
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}

/**
 * 注销API
 */
export function logoutApi() {
  return request({
    url: "/api/v1/auth/logout",
    method: "delete",
  });
}

// 获取版本号
export function GetVersion(): AxiosPromise<string> {
  return request({
    url: "/api/v1/version",
    method: "get",
  });
}
