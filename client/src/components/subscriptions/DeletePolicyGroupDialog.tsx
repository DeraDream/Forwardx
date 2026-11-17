import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Reference = { label: string; count: number };
type Props = { open: boolean; name: string; references: Reference[]; onCancel: () => void; onRemoveRules: () => void; onUseDirect: () => void };

export function DeletePolicyGroupDialog({ open, name, references, onCancel, onRemoveRules, onUseDirect }: Props) {
  const count = references.reduce((total, item) => total + item.count, 0);
  return <Dialog open={open} onOpenChange={(visible) => !visible && onCancel()}>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>删除策略组？</DialogTitle><DialogDescription>将删除「{name}」。</DialogDescription></DialogHeader>
      {count > 0 && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><b>检测到 {count} 处引用：</b><ul className="mt-2 space-y-1 text-muted-foreground">{references.filter((item) => item.count).map((item) => <li key={item.label}>• {item.label}：{item.count} 处</li>)}</ul></div>}
      <p className="text-xs text-muted-foreground">嵌套策略组成员引用会一并移除。请选择如何处理其余路由目标。</p>
      <DialogFooter className="flex-wrap sm:justify-end"><Button variant="outline" onClick={onCancel}>取消</Button><Button variant="destructive" onClick={onRemoveRules}>删除关联规则</Button><Button onClick={onUseDirect}>改为 DIRECT</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
