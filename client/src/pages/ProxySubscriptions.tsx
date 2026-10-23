import { useEffect, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Tabs } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import DataSectionLoading from "@/components/DataSectionLoading";
import { useTheme } from "@/contexts/ThemeContext";
import { FileCode2, Link2, Network, Server } from "lucide-react";
import { cn } from "@/lib/utils";

type ProxySubscriptionSection = "subscriptions" | "node-subscriptions" | "nodes" | "templates";

const sections: Array<SlidingTabItem<ProxySubscriptionSection> & { hash: string }> = [
  { value: "subscriptions", label: "订阅列表", icon: Link2, hash: "/subs/index" },
  { value: "node-subscriptions", label: "节点订阅", icon: Network, hash: "/node-subs/index" },
  { value: "nodes", label: "节点列表", icon: Server, hash: "/nodes/index" },
  { value: "templates", label: "订阅模板", icon: FileCode2, hash: "/templates/index" },
];

/** SublinkX keeps its data UI intact; ForwardX supplies the native page shell. */
export default function ProxySubscriptionsPage() {
  const { resolvedTheme } = useTheme();
  const [activeSection, setActiveSection] = useState<ProxySubscriptionSection>("subscriptions");
  const [modalOpen, setModalOpen] = useState(false);
  const [loadingSection, setLoadingSection] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadingTimerRef = useRef<number | undefined>(undefined);

  const finishSectionLoading = (delay = 180) => {
    window.clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = window.setTimeout(() => setLoadingSection(false), delay);
  };

  useEffect(() => () => window.clearTimeout(loadingTimerRef.current), []);

  const syncEmbeddedTheme = () => {
    iframeRef.current?.contentWindow?.postMessage({
      source: "forwardx",
      type: "theme",
      theme: resolvedTheme,
    }, window.location.origin);
  };

  useEffect(() => {
    syncEmbeddedTheme();
  }, [resolvedTheme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.source !== "sublinkx" || event.data?.type !== "modal") return;
      setModalOpen(event.data.open === true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const switchSection = (value: string) => {
    const next = value as ProxySubscriptionSection;
    const section = sections.find((item) => item.value === next);
    if (!section) return;
    setActiveSection(next);
    setLoadingSection(true);
    // This only changes the hash inside the already-warm Vue application; it
    // does not recreate the iframe or reload a subscription business page.
    const frameWindow = iframeRef.current?.contentWindow;
    if (frameWindow) frameWindow.location.hash = `#${section.hash}`;
    // SublinkX retains the page instances. Keep a short, stable native
    // placeholder while the selected list becomes active instead of exposing
    // the iframe's transient blank frame.
    finishSectionLoading(420);
  };

  return (
    <DashboardLayout>
      <div className="-m-3 flex min-h-[calc(100svh-3.5rem)] flex-col bg-background sm:-m-6">
        <div className="space-y-4 border-b border-border/60 px-3 pb-4 pt-3 sm:px-6 sm:pt-5">
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">代理订阅</h1>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">管理订阅源、节点与订阅模板</p>
          </div>
          <Tabs value={activeSection} onValueChange={switchSection}>
            <SlidingTabsList items={sections} activeValue={activeSection} ariaLabel="代理订阅" minItemWidthRem={7.5} />
          </Tabs>
        </div>
        <div className={cn("relative min-h-0 flex-1", modalOpen && "fixed inset-0 z-[100] bg-background")}>
          <iframe
            ref={iframeRef}
            src={`/proxy-subscription?__forwardx_embed=1&forwardx_theme=${resolvedTheme}#/subs/index`}
            title="代理订阅"
            className={cn(
              "h-full min-h-[36rem] w-full border-0 bg-background transition-opacity duration-200",
              loadingSection ? "opacity-0" : "route-content-enter opacity-100",
              modalOpen && "min-h-0",
            )}
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts allow-storage-access-by-user-activation"
            allow="clipboard-read; clipboard-write; fullscreen"
            referrerPolicy="no-referrer"
            onLoad={() => {
              syncEmbeddedTheme();
              finishSectionLoading(220);
            }}
          />
          {loadingSection && !modalOpen && (
            <div className="absolute inset-0 z-10 bg-background px-3 py-4 sm:px-6 sm:py-6">
              <DataSectionLoading label={`正在加载${sections.find((item) => item.value === activeSection)?.label || "订阅数据"}`} minHeight="h-full min-h-[260px]" />
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
