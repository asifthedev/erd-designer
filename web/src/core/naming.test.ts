import { describe, expect, it } from 'vitest'
import { pluralizeName, singularizeName } from './naming'

describe('singularizeName', () => {
  it.each([
    ['users', 'user'],
    ['posts', 'post'],
    ['blog_posts', 'blog_post'],
    ['orderItems', 'orderItem'],
    ['OrderItems', 'OrderItem'],
    ['categories', 'category'],
    ['companies', 'company'],
    ['addresses', 'address'],
    ['classes', 'class'],
    ['branches', 'branch'],
    ['boxes', 'box'],
    ['statuses', 'status'],
    ['buses', 'bus'],
    ['movies', 'movie'],
    ['people', 'person'],
    ['children', 'child'],
    ['sessions', 'session'],
    ['cases', 'case'],
    ['databases', 'database'],
    ['responses', 'response'],
    ['sizes', 'size'],
    ['quizzes', 'quiz'],
  ])('%s -> %s', (plural, singular) => expect(singularizeName(plural)).toBe(singular))

  it.each([
    'user',
    'status',
    'address',
    'canvas',
    'news',
    'series',
    'data',
    'analysis',
    'bonus',
    'menu',
    'id',
    'a',
    '',
    'x_1',
  ])('leaves %j alone (already singular, or not clearly a plural)', (word) => {
    expect(singularizeName(word)).toBe(word)
  })
})

describe('pluralizeName', () => {
  it.each([
    ['post', 'posts'],
    ['user', 'users'],
    ['blogPost', 'blogPosts'],
    ['category', 'categories'],
    ['address', 'addresses'],
    ['box', 'boxes'],
    ['status', 'statuses'],
    ['person', 'people'],
    ['key', 'keys'],
    ['day', 'days'],
    ['news', 'news'],
    ['data', 'data'],
  ])('%s -> %s', (singular, plural) => expect(pluralizeName(singular)).toBe(plural))

  it('leaves names that are already plural alone (no "postss")', () => {
    for (const plural of ['posts', 'users', 'categories', 'addresses', 'orderItems', 'tags']) {
      expect(pluralizeName(plural)).toBe(plural)
    }
  })

  it('is stable: pluralize(singularize(x)) gives back a plural, and singularize is idempotent', () => {
    for (const w of ['users', 'categories', 'addresses', 'order_items', 'statuses', 'people']) {
      const s = singularizeName(w)
      expect(singularizeName(s)).toBe(s)
      expect(singularizeName(pluralizeName(s))).toBe(s)
    }
  })
})
