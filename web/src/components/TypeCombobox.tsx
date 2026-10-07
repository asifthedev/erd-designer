import { Command as CommandPrimitive } from 'cmdk'
import { Check, ChevronDown } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { Provider } from '../core/model'
import { resolveSqlType, SQL_TYPE_SUGGESTIONS } from '../core/sqlType'

type Props = {
  value: string
  onChange: (value: string) => void
  provider: Provider
  /** Classes for the text input itself (the arrow button is positioned inside the same box). */
  className?: string
  title?: string
}

/**
 * SQL type field with suggestions: a free-text input (any type can be typed) with an arrow, and a shadcn
 * Command list under it. Opening it (click, arrow button or ArrowDown) shows every type for the current
 * database; once you type, the list filters. Arrow keys + Enter pick, Esc or clicking away closes it.
 * Each suggestion shows the Prisma type it becomes; types the database can't use (ENUM on SQLite) are left out.
 */
export function TypeCombobox({ value, onChange, provider, className = '', title }: Props) {
  const [open, setOpen] = useState(false)
  const field = useRef<HTMLDivElement>(null)
  // Until the user types, show the whole list instead of only what matches the current value.
  const [typed, setTyped] = useState(false)

  const items = useMemo(() => {
    const q = typed ? value.trim().toLowerCase() : ''
    return SQL_TYPE_SUGGESTIONS.flatMap((type) => {
      if (q && !type.toLowerCase().includes(q)) return []
      const r = resolveSqlType(type, provider)
      return r.ok ? [{ type, prisma: r.value.scalar }] : []
    })
  }, [value, typed, provider])

  const show = (next: boolean) => {
    setOpen(next)
    if (!next) setTyped(false)
  }

  return (
    <Popover open={open && items.length > 0} onOpenChange={show}>
      <Command shouldFilter={false} className="h-auto w-auto overflow-visible bg-transparent">
        <PopoverAnchor asChild>
          <div ref={field} className="relative">
            <CommandPrimitive.Input
              aria-label="SQL type"
              title={title}
              value={value}
              spellCheck={false}
              className={`${className} pr-6`}
              onValueChange={(v) => {
                onChange(v)
                setTyped(true)
                setOpen(true)
              }}
              onFocus={() => show(true)}
              // Already focused (e.g. right after picking one): a click must reopen the list.
              onClick={() => show(true)}
              onBlur={() => show(false)}
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label="Show SQL types"
              // mousedown would blur the input before the click lands; keep focus and toggle instead.
              onMouseDown={(e) => {
                e.preventDefault()
                const input = e.currentTarget.parentElement?.querySelector('input')
                input?.focus()
                show(!open)
              }}
              className="nodrag absolute top-1/2 right-1 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-sm text-muted/70 hover:bg-hover hover:text-ink"
            >
              <ChevronDown
                size={14}
                className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
              />
            </button>
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="font-ui w-60 p-1"
          // Keep the caret in the input: no focus steal on open, and clicking an item must not blur it first.
          onOpenAutoFocus={(e) => e.preventDefault()}
          // There is no trigger to give focus back to when closing: leave it in the input instead of on <body>.
          onCloseAutoFocus={(e) => e.preventDefault()}
          // The input sits outside the popover's content, so Radix would treat clicking it as "click away".
          onInteractOutside={(e) => {
            if (field.current?.contains(e.target as Node)) e.preventDefault()
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <CommandList>
            <CommandGroup>
              {items.map(({ type, prisma }) => (
                <CommandItem
                  key={type}
                  value={type}
                  onSelect={() => {
                    onChange(type)
                    show(false)
                  }}
                >
                  <span className="font-mono">{type}</span>
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    {prisma}
                    {type.toLowerCase() === value.trim().toLowerCase() && (
                      <Check size={14} className="text-key" />
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </PopoverContent>
      </Command>
    </Popover>
  )
}
