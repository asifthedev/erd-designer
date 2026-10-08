/**
 * Table colours of the Eraser theme. The actual colours (body, border, divider, name, type) live in index.css under
 * ".erd-table[data-color=...]"; this list only names them and gives the swatch shown in the colour menu. A table
 * with no colour of its own gets one from its id, so a fresh diagram is colourful without any setup.
 */
export const TABLE_COLORS = [
  { id: 'blue', name: 'Blue', swatch: '#407edd' },
  { id: 'green', name: 'Green', swatch: '#64d483' },
  { id: 'orange', name: 'Orange', swatch: '#de9f40' },
  { id: 'purple', name: 'Purple', swatch: '#c03acb' },
  { id: 'red', name: 'Red', swatch: '#ce524a' },
  { id: 'teal', name: 'Teal', swatch: '#45c4cf' },
  { id: 'pink', name: 'Pink', swatch: '#e0558f' },
  { id: 'yellow', name: 'Yellow', swatch: '#d9c43a' },
  { id: 'indigo', name: 'Indigo', swatch: '#7d7df0' },
  { id: 'gray', name: 'Gray', swatch: '#8d939c' },
] as const
export type TableColorId = (typeof TABLE_COLORS)[number]['id']

/** The colour a table is drawn in: its own choice when valid, else a stable pick from its id. */
export function resolveTableColor(tableId: string, color: string | undefined): TableColorId {
  const own = TABLE_COLORS.find((c) => c.id === color)
  if (own) return own.id
  let hash = 0
  for (const ch of tableId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return TABLE_COLORS[hash % 5].id // the five classic colours, so automatic ones look like Eraser's own
}
