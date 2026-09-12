import * as React from "react"
import { useTheme } from "@/contexts/ThemeContext"
import { useOverlayContainer } from "@/components/ui/overlay-root"
import { cn } from "@/lib/utils"
import { createPortal } from "react-dom"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ className, style, toastOptions, ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()
  const overlayContainer = useOverlayContainer()

  const toaster = (
    <Sonner
      theme={resolvedTheme}
      position="top-center"
      duration={3000}
      className={cn("toaster group", className)}
      style={{ zIndex: 200, top: "40%", left: "50%", right: "auto", transform: "translate(-50%, -50%)", ...style }}
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast: "group toast !justify-center !rounded-lg !border-0 !bg-white !px-4 !py-3 !text-center !text-zinc-900 !shadow-[0_8px_20px_rgba(15,23,42,0.16)] dark:!bg-white dark:!text-zinc-900",
          content: "!flex-none !text-center",
          title: "!text-center !font-medium",
          description: "!text-center !text-zinc-600",
          icon: "shrink-0",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  )

  return overlayContainer ? createPortal(toaster, overlayContainer) : toaster
}

export { Toaster }
