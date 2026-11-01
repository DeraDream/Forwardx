import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getSetting, setSetting } from "../repositories/settingsRepository";
import { getDb } from "../dbRuntime";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { parseTopologyAnnotations, topologyAnnotationsSchema } from "../topologyAnnotations";
export { parseTopologyAnnotations, topologyAnnotationSchema, topologyAnnotationsSchema } from "../topologyAnnotations";

// Annotations are private to the authenticated account and never affect routing.

export const topologyAnnotationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (!await getDb()) throw new Error("数据库不可用，无法读取外部标注");
    return parseTopologyAnnotations(await getSetting(`topologyAnnotations:${ctx.user.id}`));
  }),
  save: protectedProcedure.input(z.object({ items: topologyAnnotationsSchema, expected: topologyAnnotationsSchema })).mutation(async ({ ctx, input }) => {
    if (!await getDb()) throw new Error("数据库不可用，无法保存外部标注");
    const key = `topologyAnnotations:${ctx.user.id}`;
    return withKeyedTaskLock(key, async () => {
      const current = parseTopologyAnnotations(await getSetting(key));
      if (JSON.stringify(current) !== JSON.stringify(input.expected)) throw new Error("标注已在其他页面修改，请刷新后重试");
      await setSetting(key, JSON.stringify(input.items));
      return input.items;
    });
  }),
});
