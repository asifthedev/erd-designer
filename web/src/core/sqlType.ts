import type { Provider } from './model'

export type PrismaScalar =
  | 'String'
  | 'Int'
  | 'BigInt'
  | 'Float'
  | 'Decimal'
  | 'Boolean'
  | 'DateTime'
  | 'Json'
  | 'Bytes'

export type ParsedType = {
  /** Normalised upper-case base type, e.g. `VARCHAR`. */
  base: string
  args: number[]
  enumValues?: string[]
  unsigned: boolean
  array: boolean
}

export type ResolvedType = {
  scalar: PrismaScalar | 'Enum'
  /** Native type attribute without the leading `@db.`, e.g. `VarChar(255)`. */
  native?: string
  /** SERIAL-style types imply an auto-increment default. */
  autoIncrement: boolean
  enumValues?: string[]
  array: boolean
}

export type TypeResult = { ok: true; value: ResolvedType } | { ok: false; error: string }

const ALIASES: Record<string, string> = {
  INTEGER: 'INT',
  INT4: 'INT',
  INT8: 'BIGINT',
  INT2: 'SMALLINT',
  BOOL: 'BOOLEAN',
  'CHARACTER VARYING': 'VARCHAR',
  CHARACTER: 'CHAR',
  'DOUBLE PRECISION': 'DOUBLE',
  FLOAT8: 'DOUBLE',
  FLOAT4: 'REAL',
  DEC: 'DECIMAL',
  NUMERIC: 'DECIMAL',
  'TIMESTAMP WITHOUT TIME ZONE': 'TIMESTAMP',
  'TIMESTAMP WITH TIME ZONE': 'TIMESTAMPTZ',
  BYTEA: 'BLOB',
  BINARY: 'BLOB',
  VARBINARY: 'BLOB',
  SERIAL4: 'SERIAL',
  SERIAL8: 'BIGSERIAL',
}

type Native = (args: number[]) => string | undefined
type Def = {
  scalar: PrismaScalar
  autoIncrement?: boolean
  postgresql?: Native
  mysql?: Native
}

const fixed =
  (name: string): Native =>
  () =>
    name
const sized =
  (name: string): Native =>
  (args) =>
    args.length ? `${name}(${args.join(', ')})` : name

/** Native types follow the Prisma docs' per-connector scalar mapping. */
const DEFS: Record<string, Def> = {
  INT: { scalar: 'Int' },
  SERIAL: { scalar: 'Int', autoIncrement: true },
  SMALLINT: { scalar: 'Int', postgresql: fixed('SmallInt'), mysql: fixed('SmallInt') },
  TINYINT: { scalar: 'Int', mysql: fixed('TinyInt') },
  MEDIUMINT: { scalar: 'Int', mysql: fixed('MediumInt') },
  BIGINT: { scalar: 'BigInt' },
  BIGSERIAL: { scalar: 'BigInt', autoIncrement: true },
  VARCHAR: { scalar: 'String', postgresql: sized('VarChar'), mysql: sized('VarChar') },
  CHAR: { scalar: 'String', postgresql: sized('Char'), mysql: sized('Char') },
  TEXT: { scalar: 'String', mysql: fixed('Text') },
  MEDIUMTEXT: { scalar: 'String', mysql: fixed('MediumText') },
  LONGTEXT: { scalar: 'String', mysql: fixed('LongText') },
  UUID: { scalar: 'String', postgresql: fixed('Uuid'), mysql: fixed('Char(36)') },
  BOOLEAN: { scalar: 'Boolean' },
  DECIMAL: { scalar: 'Decimal', postgresql: sized('Decimal'), mysql: sized('Decimal') },
  FLOAT: { scalar: 'Float', mysql: fixed('Float') },
  REAL: { scalar: 'Float', postgresql: fixed('Real'), mysql: fixed('Float') },
  DOUBLE: { scalar: 'Float', postgresql: fixed('DoublePrecision'), mysql: fixed('Double') },
  DATE: { scalar: 'DateTime', postgresql: fixed('Date'), mysql: fixed('Date') },
  TIME: { scalar: 'DateTime', postgresql: fixed('Time'), mysql: fixed('Time') },
  TIMESTAMP: { scalar: 'DateTime', postgresql: sized('Timestamp'), mysql: sized('Timestamp') },
  DATETIME: { scalar: 'DateTime', postgresql: sized('Timestamp'), mysql: sized('DateTime') },
  TIMESTAMPTZ: { scalar: 'DateTime', postgresql: sized('Timestamptz') },
  JSON: { scalar: 'Json', postgresql: fixed('Json'), mysql: fixed('Json') },
  JSONB: { scalar: 'Json', postgresql: fixed('JsonB') },
  BLOB: { scalar: 'Bytes', mysql: fixed('Blob') },
}

const UNSIGNED_MYSQL: Record<string, string> = {
  INT: 'UnsignedInt',
  SMALLINT: 'UnsignedSmallInt',
  TINYINT: 'UnsignedTinyInt',
  MEDIUMINT: 'UnsignedMediumInt',
  BIGINT: 'UnsignedBigInt',
}

export const SQL_TYPE_SUGGESTIONS = [
  'INT',
  'SERIAL',
  'BIGINT',
  'BIGSERIAL',
  'SMALLINT',
  'VARCHAR(255)',
  'CHAR(1)',
  'TEXT',
  'BOOLEAN',
  'DECIMAL(10, 2)',
  'FLOAT',
  'DOUBLE',
  'DATE',
  'TIMESTAMP',
  'DATETIME',
  'TIMESTAMPTZ',
  'UUID',
  'JSON',
  'JSONB',
  'BLOB',
  "ENUM('a', 'b')",
]

export function parseSqlType(input: string): { ok: true; value: ParsedType } | { ok: false; error: string } {
  let text = input.trim()
  if (!text) return { ok: false, error: 'Type is empty' }

  let array = false
  if (text.endsWith('[]')) {
    array = true
    text = text.slice(0, -2).trim()
  }

  let unsigned = false
  text = text.replace(/\s+unsigned$/i, () => {
    unsigned = true
    return ''
  })

  const paren = text.indexOf('(')
  if (paren === -1) {
    return { ok: true, value: { base: normaliseBase(text), args: [], unsigned, array } }
  }
  if (!text.endsWith(')')) return { ok: false, error: 'Missing closing )' }

  const base = normaliseBase(text.slice(0, paren))
  const inner = text.slice(paren + 1, -1).trim()

  if (base === 'ENUM') {
    const values = [...inner.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
    if (!values.length) return { ok: false, error: "ENUM needs quoted values, e.g. ENUM('a', 'b')" }
    return { ok: true, value: { base, args: [], enumValues: values, unsigned, array } }
  }

  const args = inner ? inner.split(',').map((p) => Number(p.trim())) : []
  if (args.some((n) => !Number.isInteger(n) || n < 0)) {
    return { ok: false, error: 'Type arguments must be non-negative integers' }
  }
  return { ok: true, value: { base, args, unsigned, array } }
}

function normaliseBase(raw: string): string {
  const upper = raw.trim().replace(/\s+/g, ' ').toUpperCase()
  return ALIASES[upper] ?? upper
}

export function resolveSqlType(input: string, provider: Provider): TypeResult {
  const parsed = parseSqlType(input)
  if (!parsed.ok) return parsed
  const { base, args, enumValues, array } = parsed.value

  if (array && provider !== 'postgresql') {
    return { ok: false, error: 'Array types are only supported on PostgreSQL' }
  }

  if (base === 'ENUM') {
    if (provider === 'sqlite') return { ok: false, error: 'SQLite does not support enums' }
    return { ok: true, value: { scalar: 'Enum', autoIncrement: false, enumValues, array } }
  }

  const def = DEFS[base]
  if (!def) return { ok: false, error: `Unknown type "${base}"` }

  let native = provider === 'sqlite' ? undefined : def[provider]?.(args)
  if (parsed.value.unsigned) {
    const unsignedNative = UNSIGNED_MYSQL[base]
    if (provider !== 'mysql' || !unsignedNative) {
      return { ok: false, error: 'UNSIGNED is only supported on MySQL integer types' }
    }
    native = unsignedNative
  }
  return {
    ok: true,
    value: { scalar: def.scalar, native, autoIncrement: def.autoIncrement ?? false, array },
  }
}
