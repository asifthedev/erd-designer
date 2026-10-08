import { Settings } from 'lucide-react'
import { useAuth } from '@/auth/store'
import { link, SETTINGS_PATH } from '../lib/route'

/**
 * The gear that opens the Settings page. `inSidebar` is the quiet one at the foot of the diagram list; the
 * default is the bordered toolbar button. Whatever is still unsaved is sent first, since the editor goes away.
 */
export function SettingsLink({ inSidebar = false }: { inSidebar?: boolean }) {
  return (
    <a
      href={SETTINGS_PATH}
      title="Settings"
      aria-label="Settings"
      onClick={(e) => {
        void useAuth.getState().saveNow()
        link(SETTINGS_PATH)(e)
      }}
      className={
        inSidebar
          ? 'grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted outline-none hover:bg-hover hover:text-ink focus-visible:ring-1 focus-visible:ring-key'
          : 'grid size-8 cursor-pointer place-items-center rounded-md border border-line text-muted outline-none hover:border-key hover:text-key focus-visible:ring-1 focus-visible:ring-key'
      }
    >
      <Settings size={16} />
    </a>
  )
}
