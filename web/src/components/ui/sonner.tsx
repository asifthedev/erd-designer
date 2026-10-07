import { CheckIcon, InfoIcon, Loader2Icon, TriangleAlertIcon, XIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// The app is always dark, so there is no next-themes here: the theme is fixed and the toast colours come
// from the app's shadcn tokens (see @theme in index.css). The card look (colour wash, stripes, close button)
// is in index.css under "Toasts".

/** Filled round badge with a dark glyph, like the status icons of the toast design. */
function Badge({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="grid size-[18px] shrink-0 place-items-center rounded-full text-canvas"
      style={{ background: color }}
    >
      {children}
    </span>
  )
}

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: (
          <Badge color="var(--color-link)">
            <CheckIcon size={12} strokeWidth={3.5} />
          </Badge>
        ),
        info: (
          <Badge color="var(--color-key)">
            <InfoIcon size={12} strokeWidth={3} />
          </Badge>
        ),
        warning: (
          <Badge color="var(--color-warning)">
            <TriangleAlertIcon size={11} strokeWidth={3} />
          </Badge>
        ),
        error: (
          <Badge color="var(--color-danger)">
            <XIcon size={12} strokeWidth={3.5} />
          </Badge>
        ),
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--color-popover)",
          "--normal-text": "var(--color-popover-foreground)",
          "--normal-border": "var(--color-border)",
          "--border-radius": "14px",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
