import { useReactFlow } from '@xyflow/react'
import { Download, FileCode, FileImage, FileText, LoaderCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useAuth } from '@/auth/store'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { EXPORT_FORMATS, exportDiagram, type ExportFormat } from '../export/exportDiagram'
import { useCloseOnOutsidePointer } from '../hooks/useCloseOnOutsidePointer'
import { useStore } from '../store'
import { showProblem } from './problemToast'

const ICON: Record<ExportFormat, ReactNode> = {
  png: <FileImage size={17} />,
  svg: <FileCode size={17} />,
  pdf: <FileText size={17} />,
}

/** Waits for the screen to be redrawn (twice, to be sure), so a change to the canvas is really in the picture. */
const nextFrames = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

/** Toolbar button + menu: save the whole diagram as a PNG, SVG or PDF picture. */
export function ExportMenu() {
  const { getNodes, getNodesBounds } = useReactFlow()
  const hasTables = useStore((s) => s.nodes.length > 0)
  const title = useAuth((s) => s.diagrams.find((d) => d.id === s.currentId)?.title)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  useCloseOnOutsidePointer(open, () => setOpen(false))

  const run = async (format: ExportFormat) => {
    if (busy) return
    setBusy(format)
    // Which tables / line are picked only matters on screen: take that out of the picture, then put it back.
    const before = useStore.getState()
    const pickedTables = new Set(before.nodes.filter((n) => n.selected).map((n) => n.id))
    const pickedLine = before.selectedEdgeId
    useStore.setState({
      nodes: before.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
      selectedEdgeId: null,
    })
    try {
      await nextFrames()
      await exportDiagram(format, getNodesBounds(getNodes()), title)
      setOpen(false)
    } catch (e) {
      showProblem({
        title: "Couldn't export the diagram",
        reason: (e as Error).message || 'Something went wrong while drawing the picture.',
        fix: 'Try again, or try another format.',
      })
    } finally {
      useStore.setState((s) => ({
        nodes: s.nodes.map((n) => (pickedTables.has(n.id) ? { ...n, selected: true } : n)),
        selectedEdgeId: pickedLine,
      }))
      setBusy(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={!hasTables}
          title={hasTables ? 'Save the diagram as a picture' : 'Add a table first'}
          className={`flex cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 py-1 outline-none focus-visible:ring-1 focus-visible:ring-key disabled:cursor-not-allowed disabled:opacity-50 ${
            open ? 'border-key/60 text-key' : 'border-line text-muted hover:border-key hover:text-key'
          }`}
        >
          <Download className="size-4" aria-hidden />
          Export
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="font-ui w-72 p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
          Save the diagram as
        </p>
        {EXPORT_FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            disabled={!!busy}
            onClick={() => void run(f.id)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-hover focus-visible:bg-hover disabled:cursor-wait disabled:opacity-60"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-hover-strong text-key">
              {busy === f.id ? <LoaderCircle size={17} className="animate-spin" aria-label="Exporting" /> : ICON[f.id]}
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] leading-tight font-medium">{f.label}</span>
              <span className="block truncate text-[12px] leading-tight text-muted">{f.note}</span>
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
