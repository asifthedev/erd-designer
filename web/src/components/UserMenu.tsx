import { Check, CloudAlert, CloudUpload, LoaderCircle, LogIn, LogOut } from 'lucide-react'
import { useAuth } from '@/auth/store'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** Save status + account menu for the toolbar. Guests get a "Log in to save" button instead. */
export function UserMenu() {
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const save = useAuth((s) => s.save)
  const logout = useAuth((s) => s.logout)
  const showSignIn = useAuth((s) => s.showSignIn)

  if (status === 'guest') {
    return (
      <Button variant="outline" size="sm" className="cursor-pointer" onClick={showSignIn}>
        <LogIn />
        Log in to save
      </Button>
    )
  }
  if (status !== 'authed' || !user) return null

  const label = user.name || user.email
  const initial = label.trim().charAt(0).toUpperCase()

  const saveInfo = {
    idle: { icon: <CloudUpload size={15} />, text: 'Saved to your account', tone: 'text-muted' },
    saving: {
      icon: <LoaderCircle size={15} className="animate-spin" />,
      text: 'Saving…',
      tone: 'text-muted',
    },
    saved: { icon: <Check size={15} />, text: 'Saved', tone: 'text-link' },
    error: { icon: <CloudAlert size={15} />, text: 'Not saved', tone: 'text-danger' },
  }[save]

  return (
    <div className="flex items-center gap-3">
      <span
        className={`flex items-center gap-1.5 text-[13px] ${saveInfo.tone}`}
        role="status"
        title={saveInfo.text}
      >
        {saveInfo.icon}
        <span className="hidden md:inline">{saveInfo.text}</span>
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className="grid size-8 cursor-pointer place-items-center rounded-full bg-key/20 font-semibold text-key hover:bg-key/30"
          >
            {initial}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="font-ui w-64 p-2">
          <div className="px-2 py-1.5">
            {user.name && <p className="truncate font-medium">{user.name}</p>}
            <p className="truncate text-muted-foreground">{user.email}</p>
          </div>
          <div className="my-1.5 h-px bg-border" />
          <button
            type="button"
            onClick={() => void logout()}
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-white/8"
          >
            <LogOut size={15} />
            Log out
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
