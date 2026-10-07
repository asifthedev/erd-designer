import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Join class names and resolve conflicting Tailwind utilities (used by the shadcn/ui components). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
