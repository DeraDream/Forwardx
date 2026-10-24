import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function Checkbox({ checked = false, className }: { checked?: boolean; className?: string }) {
  return <span aria-hidden className={cn("grid size-5 shrink-0 place-items-center rounded border", checked ? "border-blue-400 bg-blue-500 text-white" : "border-slate-600 bg-transparent", className)}>{checked && <Check className="size-3.5" />}</span>;
}
