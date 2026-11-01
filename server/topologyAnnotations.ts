import { z } from "zod";

export const topologyAnnotationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().max(255),
  target: z.string().trim().min(1).max(120),
  targetNodeId: z.string().regex(/^host:[1-9]\d*$/).nullable().optional(),
  note: z.string().trim().max(300),
});
export const topologyAnnotationsSchema = z.array(topologyAnnotationSchema).max(50).superRefine((items, ctx) => {
  if (new Set(items.map((item) => item.id)).size !== items.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "标注 ID 重复" });
});
export function parseTopologyAnnotations(value: string | null) {
  if (!value) return [];
  try { return topologyAnnotationsSchema.parse(JSON.parse(value)); }
  catch { throw new Error("外部拓扑标注数据无法解析，请联系管理员检查，未覆盖原始数据"); }
}

/** Account and host IDs must follow migration mappings, never the old numeric IDs. */
export function remapTopologyAnnotationSetting(key: string, value: string | null, mapUser: (id: number) => number | null, mapHost: (id: number) => number | null) {
  const match = key.match(/^topologyAnnotations:([1-9]\d*)$/);
  if (!match) return null;
  const userId = mapUser(Number(match[1]));
  if (!userId) return null;
  const items = parseTopologyAnnotations(value).map((item) => {
    if (!item.targetNodeId) return item;
    const hostId = mapHost(Number(item.targetNodeId.slice("host:".length)));
    return { ...item, targetNodeId: hostId ? `host:${hostId}` : null };
  });
  return { key: `topologyAnnotations:${userId}`, value: JSON.stringify(items) };
}
