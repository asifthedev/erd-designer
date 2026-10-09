/**
 * The tools the AI assistant may call on the canvas: THE contract between the server and the web app.
 *
 * - The server sends these (name, description, JSON schema) to the model and never executes them.
 * - The web app executes them against the real canvas (web/src/ai/executor.ts), because the canvas, including
 *   an unsaved one, lives in the browser.
 *
 * Plain data and no imports on purpose, so both sides can import this one file and can never drift apart.
 * Tables and columns are addressed by NAME (the model never sees internal ids).
 */

export type JsonSchema = { [key: string]: unknown }

export type ToolSpec = { name: ToolName; description: string; parameters: JsonSchema }

export const TOOL_NAMES = [
  'create_tables',
  'alter_table',
  'drop_tables',
  'set_relation',
  'remove_relation',
  'set_database',
  'auto_layout',
  'create_diagram',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export const REFERENTIAL_ACTIONS = ['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'] as const
export const DATABASES = ['postgresql', 'mysql', 'sqlite'] as const
export const TABLE_COLOR_IDS = ['blue', 'green', 'orange', 'purple', 'red', 'teal', 'pink', 'yellow', 'indigo', 'gray'] as const

const str = (description: string) => ({ type: 'string', description })
const bool = (description: string) => ({ type: 'boolean', description })
const strList = (description: string) => ({ type: 'array', items: { type: 'string' }, description })

const reference = {
  type: 'object',
  description: 'Makes this column a foreign key.',
  properties: {
    table: str('Name of the referenced (parent) table.'),
    column: str('Referenced column. Omit to use the parent table\'s single primary key.'),
    onDelete: { type: 'string', enum: REFERENTIAL_ACTIONS, description: 'ON DELETE action. Default: none (database default).' },
    onUpdate: { type: 'string', enum: REFERENTIAL_ACTIONS, description: 'ON UPDATE action.' },
  },
  required: ['table'],
  additionalProperties: false,
}

const columnProps = {
  name: str('Column name, e.g. "created_at" or "createdAt". Follow the naming style already used on the canvas.'),
  type: str('SQL type, e.g. SERIAL, INT, BIGINT, VARCHAR(255), TEXT, BOOLEAN, DECIMAL(10,2), TIMESTAMP, DATE, UUID, JSONB.'),
  primaryKey: bool('Part of the primary key.'),
  notNull: bool('NOT NULL.'),
  unique: bool('UNIQUE.'),
  default: str('Raw SQL default expression, e.g. now(), 0, false, \'draft\'.'),
}

const columnSpec = {
  type: 'object',
  properties: { ...columnProps, references: reference },
  required: ['name', 'type'],
  additionalProperties: false,
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'create_tables',
    description:
      'Create one or more tables with all their columns and foreign keys in ONE call (preferred over many calls). ' +
      'Foreign keys may point at tables created in the same call. Every table needs a primary key. ' +
      'A foreign key column must have the same type as the column it references (use INT for a SERIAL key, BIGINT for BIGSERIAL).',
    parameters: {
      type: 'object',
      properties: {
        tables: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: str('Table name, e.g. "orders".'),
              icon: str('Optional Lucide icon name in PascalCase, e.g. Users, ShoppingCart, Package, CreditCard.'),
              color: { type: 'string', enum: TABLE_COLOR_IDS, description: 'Optional table colour; group related tables by colour.' },
              columns: { type: 'array', minItems: 1, items: columnSpec },
            },
            required: ['name', 'columns'],
            additionalProperties: false,
          },
        },
      },
      required: ['tables'],
      additionalProperties: false,
    },
  },
  {
    name: 'alter_table',
    description:
      'Change one existing table: rename it, set its icon / colour, add columns, change columns (rename, type, flags, default, ' +
      'foreign key) or drop columns. Several changes may be combined in one call.',
    parameters: {
      type: 'object',
      properties: {
        table: str('Current name of the table.'),
        rename: str('New table name.'),
        icon: str('Lucide icon name in PascalCase.'),
        color: { type: 'string', enum: TABLE_COLOR_IDS },
        addColumns: { type: 'array', items: columnSpec },
        updateColumns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: str('Current name of the column.'),
              rename: str('New column name.'),
              type: columnProps.type,
              primaryKey: columnProps.primaryKey,
              notNull: columnProps.notNull,
              unique: columnProps.unique,
              default: str('New default expression; empty string removes the default.'),
              references: reference,
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        dropColumns: strList('Names of columns to delete.'),
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'drop_tables',
    description: 'Delete tables (and the foreign keys that point at them). Only when the user asked to remove them.',
    parameters: {
      type: 'object',
      properties: { tables: { ...strList('Names of the tables to delete.'), minItems: 1 } },
      required: ['tables'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_relation',
    description:
      'Create or change ONE foreign key: `table`.`column` references another table. The column is created (with the parent key\'s type) ' +
      'when it does not exist yet. For many-to-many, create a junction table with two foreign keys instead.',
    parameters: {
      type: 'object',
      properties: {
        table: str('The child table that holds the foreign key.'),
        column: str('The foreign key column (created when missing).'),
        references: reference,
      },
      required: ['table', 'column', 'references'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_relation',
    description: 'Remove one foreign key (the column stays, it just stops referencing).',
    parameters: {
      type: 'object',
      properties: { table: str('Table that holds the foreign key.'), column: str('The foreign key column.') },
      required: ['table', 'column'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_database',
    description: 'Switch the target database. Existing column types are kept as they are, so review them after switching.',
    parameters: {
      type: 'object',
      properties: { database: { type: 'string', enum: DATABASES } },
      required: ['database'],
      additionalProperties: false,
    },
  },
  {
    name: 'auto_layout',
    description:
      'Re-arrange every table on the canvas so related tables sit next to each other and relation lines do not cross tables. ' +
      'New tables are already placed automatically; call this after large restructurings or when the canvas looks messy.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_diagram',
    description:
      'Start a NEW saved ERD (a separate diagram in the user\'s account) and switch the canvas to it. It starts empty; ' +
      'continue with create_tables. Use it only when the user wants a new / separate diagram, not to edit the current one.',
    parameters: {
      type: 'object',
      properties: { title: str('Short title for the new diagram, e.g. "Online shop".') },
      required: ['title'],
      additionalProperties: false,
    },
  },
]

/** What the web app sends as the current canvas: compact, by name, no ids and no positions. */
export type ColumnSnapshot = {
  name: string
  type: string
  primaryKey?: boolean
  notNull?: boolean
  unique?: boolean
  default?: string
  /** `table.column`, plus the ON DELETE action when one is set. */
  references?: { table: string; column: string; onDelete?: string }
}
export type TableSnapshot = { name: string; icon?: string; color?: string; columns: ColumnSnapshot[] }
export type CanvasSnapshot = {
  provider: (typeof DATABASES)[number]
  tables: TableSnapshot[]
  /** Tables the plan allows in one diagram. */
  maxTables: number
  /** Title of the ERD on the canvas (signed-in accounts), if any. */
  title?: string
}

/** The wire format between the web app and POST /api/ai/chat. */
export type ChatToolCall = { id: string; name: string; arguments: string }
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }
