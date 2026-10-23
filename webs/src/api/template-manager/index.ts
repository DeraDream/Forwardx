import request from "@/utils/request";

export interface VisualTemplateItem {
  file: string;
  updated_at: string;
  type: "clash" | "egern" | "loon";
}

export interface VisualTemplatePayload {
  filename: string;
  old_name?: string;
  content: string;
  type?: "clash" | "egern" | "loon";
}

export const listVisualTemplates = () =>
  request({ url: "/api/v1/template-manager/list", method: "get" });

export const getVisualTemplate = (filename: string) =>
  request({ url: "/api/v1/template-manager/content", method: "get", params: { filename } });

export const createVisualTemplate = (data: VisualTemplatePayload) =>
  request({ url: "/api/v1/template-manager/create", method: "post", data });

export const updateVisualTemplate = (data: VisualTemplatePayload) =>
  request({ url: "/api/v1/template-manager/update", method: "post", data });

export const deleteVisualTemplate = (filename: string) =>
  request({ url: "/api/v1/template-manager/delete", method: "post", data: { filename } });

export const fetchVisualTemplateSource = (url: string) =>
  request({ url: "/api/v1/template-manager/fetch", method: "post", data: { url } });
