import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Reference = { label: string; count: number };
type Props = {
  open: boolean;
  kind: "策略组" | "规则集";
  previous: string;
  next: string;
  error?: string;
  references?: Reference[];
  onReturn: () => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function RenameConfirmationDialog({ open, kind, previous, next, error, references = [], onReturn, onCancel, onConfirm }: Props) {
  const count = references.reduce((total, item) => total + item.count, 0);
  return <Dialog open={open} onOpenChange={(visible) => !visible && (error ? onReturn() : onCancel())}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{error ? `⚠ ${kind}名称不可用` : `✓ ${kind}名称可用`}</DialogTitle>
        <DialogDescription>{error ? `「${next || "（空名称）"}」无法作为${kind}名称。` : `将「${previous}」重命名为「${next}」。`}</DialogDescription>
      </DialogHeader>
      {error ? <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"><b>原因</b><p className="mt-1 text-muted-foreground">{error}</p></div> : count ? <div className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm"><b>检测到 {count} 处引用，确认后将自动同步：</b><ul className="mt-2 space-y-1 text-muted-foreground">{references.filter((item) => item.count).map((item) => <li key={item.label}>• {item.label}：{item.count} 处</li>)}</ul></div> : <p className="text-sm text-muted-foreground">当前模板中没有其他内容引用该{kind}。</p>}
      {!error && <p className="text-xs text-muted-foreground">不会修改订阅节点名称或其他非{kind}文本。</p>}
      <DialogFooter>{error ? <Button onClick={onReturn}>返回修改</Button> : <><Button variant="outline" onClick={onCancel}>取消</Button><Button onClick={onConfirm}>{count ? `确认并同步 ${count} 处引用` : "确认重命名"}</Button></>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
