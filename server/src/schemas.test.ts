import { describe, expect, it } from 'vitest'
import { diagramSchema, loginSchema, signupSchema } from './schemas'

describe('signupSchema', () => {
  it('normalises the email and trims the name', () => {
    const r = signupSchema.parse({ email: '  Ada@Example.COM ', password: '12345678', code: ' 123456 ', name: '  Ada ' })
    expect(r).toEqual({ email: 'ada@example.com', password: '12345678', code: '123456', name: 'Ada' })
  })

  it('rejects short passwords and bad emails with readable messages', () => {
    expect(signupSchema.safeParse({ email: 'a@b.co', password: '1234567', code: '123456' }).error?.issues[0].message).toMatch(
      /8/,
    )
    expect(signupSchema.safeParse({ email: 'nope', password: '12345678', code: '123456' }).error?.issues[0].message).toMatch(
      /email/i,
    )
  })

  it('turns an empty name into undefined', () => {
    expect(signupSchema.parse({ email: 'a@b.co', password: '12345678', code: '123456', name: '  ' }).name).toBeUndefined()
  })

  it('needs the 6-digit code', () => {
    for (const code of [undefined, '', '12345', '1234567', 'abcdef', '12 456', '１２３４５６']) {
      expect(signupSchema.safeParse({ email: 'a@b.co', password: '12345678', code }).success, String(code)).toBe(false)
    }
    expect(signupSchema.safeParse({ email: 'a@b.co', password: '12345678', code: '000000' }).success).toBe(true)
  })
})

describe('loginSchema', () => {
  it('accepts any non-empty password (the length rule only applies when choosing one)', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true)
    expect(loginSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false)
  })
})

describe('diagramSchema', () => {
  const column = {
    id: 'c1',
    name: 'id',
    type: 'INT',
    primaryKey: true,
    notNull: true,
    unique: false,
    default: '',
  }
  const node = { id: 't1', position: { x: 0, y: 40 }, data: { id: 't1', name: 'users', columns: [column] } }

  it('accepts a saved workspace', () => {
    expect(diagramSchema.safeParse({ provider: 'postgresql', nodes: [node], manyToMany: [] }).success).toBe(
      true,
    )
  })

  it('keeps a hand-dragged line shape (bend) instead of stripping it', () => {
    const withBend = {
      ...node,
      data: {
        ...node.data,
        columns: [{ ...column, references: { tableId: 't2', columnId: 'c2', bend: { x: 40, y: -20 } } }],
      },
    }
    const r = diagramSchema.parse({
      provider: 'postgresql',
      nodes: [withBend],
      manyToMany: [{ id: 'm', aTableId: 'a', bTableId: 'b', bend: { x: 5, y: 6 } }],
    })
    expect(r.nodes[0].data.columns[0].references?.bend).toEqual({ x: 40, y: -20 })
    expect(r.manyToMany[0].bend).toEqual({ x: 5, y: 6 })
  })

  it('rejects unknown databases, missing fields and non-numeric positions', () => {
    expect(diagramSchema.safeParse({ provider: 'oracle', nodes: [], manyToMany: [] }).success).toBe(false)
    expect(
      diagramSchema.safeParse({ provider: 'mysql', nodes: [{ ...node, data: { id: 't1' } }], manyToMany: [] })
        .success,
    ).toBe(false)
    expect(
      diagramSchema.safeParse({
        provider: 'mysql',
        nodes: [{ ...node, position: { x: 'a', y: 0 } }],
        manyToMany: [],
      }).success,
    ).toBe(false)
  })
})
