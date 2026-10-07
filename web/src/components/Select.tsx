import type { ReactNode } from 'react'
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export type SelectOption<T extends string> = { value: T; label: string; icon?: ReactNode }

type Props<T extends string> = {
  value: T
  onValueChange: (value: T) => void
  options: SelectOption<T>[]
  'aria-label': string
  className?: string
}

/** App dropdown: a thin typed wrapper around the shadcn/ui Select, with an optional icon per option. */
export function Select<T extends string>({ value, onValueChange, options, className, ...rest }: Props<T>) {
  return (
    <UiSelect value={value} onValueChange={(v) => onValueChange(v as T)}>
      <SelectTrigger size="sm" aria-label={rest['aria-label']} className={cn('cursor-pointer', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="font-ui">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="cursor-pointer">
            {o.icon}
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
  )
}
