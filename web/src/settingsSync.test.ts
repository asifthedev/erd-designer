import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()
vi.mock('./auth/api', () => ({ api: (...args: unknown[]) => api(...args) }))

import { DEFAULT_SETTINGS, pickSettings, useSettings, type Settings } from './settings'
import { retrySettingsSync, startSettingsSync, stopSettingsSync, SYNC_DELAY_MS, useSettingsSync } from './settingsSync'

const local = () => pickSettings(useSettings.getState())
const puts = () => api.mock.calls.filter(([path, opts]) => path === '/settings' && opts?.method === 'PUT')
const wait = (ms = SYNC_DELAY_MS) => vi.advanceTimersByTimeAsync(ms)
const serverHas = (settings: Partial<Settings> | null) =>
  api.mockImplementation(async (_path, opts) => (opts?.method === 'PUT' ? {} : { settings }))

beforeEach(() => {
  vi.useFakeTimers()
  api.mockReset()
  stopSettingsSync()
  useSettings.getState().replace(DEFAULT_SETTINGS)
})

describe('settings sync', () => {
  it('applies the settings saved on the account when someone logs in', async () => {
    serverHas({ theme: 'violet', tableFont: 'jetbrains-mono', tableWeight: 500, edgeStyle: 'curved' })
    await startSettingsSync()
    expect(local()).toEqual({ theme: 'violet', tableFont: 'jetbrains-mono', tableWeight: 500, edgeStyle: 'curved' })
    expect(useSettingsSync.getState().state).toBe('saved')
    await wait()
    expect(puts()).toHaveLength(0) // nothing to send back
  })

  it('does not save the defaults on an account that has no settings yet', async () => {
    serverHas(null)
    await startSettingsSync()
    await wait()
    expect(puts()).toHaveLength(0)
    expect(useSettingsSync.getState().state).toBe('saved')
  })

  it("lets an account with no settings adopt this browser's choices", async () => {
    useSettings.getState().replace({ ...DEFAULT_SETTINGS, theme: 'eraser', edgeStyle: 'curved' })
    serverHas(null)
    await startSettingsSync()
    expect(useSettingsSync.getState().state).toBe('saving')
    await wait()
    expect(puts()).toHaveLength(1)
    expect(puts()[0][1].body).toEqual({ ...DEFAULT_SETTINGS, theme: 'eraser', edgeStyle: 'curved' })
    expect(useSettingsSync.getState().state).toBe('saved')
  })

  it('fills in what the account has not stored yet from this browser, and sends the complete set back', async () => {
    useSettings.getState().replace({ ...DEFAULT_SETTINGS, tableWeight: 300 })
    serverHas({ theme: 'warm' })
    await startSettingsSync()
    expect(local()).toEqual({ ...DEFAULT_SETTINGS, theme: 'warm', tableWeight: 300 })
    await wait()
    expect(puts()[0][1].body).toEqual({ ...DEFAULT_SETTINGS, theme: 'warm', tableWeight: 300 })
  })

  it('ignores values from the server that this version does not know', async () => {
    serverHas({ theme: 'retired' as never, edgeStyle: 'curved' })
    await startSettingsSync()
    expect(local().theme).toBe(DEFAULT_SETTINGS.theme)
    expect(local().edgeStyle).toBe('curved')
  })

  it('turns a burst of clicks into one request carrying the final choice', async () => {
    serverHas({ ...DEFAULT_SETTINGS })
    await startSettingsSync()
    const s = useSettings.getState()
    s.setTheme('dracula')
    await wait(200)
    s.setTheme('vercel')
    s.setEdgeStyle('curved')
    expect(useSettingsSync.getState().state).toBe('saving')
    await wait(SYNC_DELAY_MS - 1)
    expect(puts()).toHaveLength(0) // still waiting: the last click restarted the delay
    await wait(1)
    expect(puts()).toHaveLength(1)
    expect(puts()[0][1].body).toEqual({ ...DEFAULT_SETTINGS, theme: 'vercel', edgeStyle: 'curved' })
    expect(useSettingsSync.getState().state).toBe('saved')
  })

  it('stays on "saving" and sends again when something changes while a request is on its way', async () => {
    serverHas({ ...DEFAULT_SETTINGS })
    await startSettingsSync()
    let finish!: () => void
    api.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({}))))
    useSettings.getState().setTheme('dracula')
    await wait()
    useSettings.getState().setTheme('warm') // while the first request is still open
    finish()
    await wait(0)
    expect(useSettingsSync.getState().state).toBe('saving') // the first reply must not claim everything is saved
    await wait()
    expect(puts().at(-1)![1].body.theme).toBe('warm')
    expect(useSettingsSync.getState().state).toBe('saved')
  })

  it('keeps the choices here and shows an error when the server cannot be reached, and retries on request', async () => {
    useSettings.getState().replace({ ...DEFAULT_SETTINGS, theme: 'eraser' })
    api.mockRejectedValue(new Error('offline'))
    await startSettingsSync()
    expect(useSettingsSync.getState().state).toBe('error')
    expect(local().theme).toBe('eraser') // nothing was lost or reset

    serverHas({ theme: 'eraser' })
    await retrySettingsSync()
    expect(useSettingsSync.getState().state).toBe('saved')
  })

  it('shows an error when a save fails, then recovers on retry', async () => {
    serverHas({ ...DEFAULT_SETTINGS })
    await startSettingsSync()
    api.mockRejectedValue(new Error('500'))
    useSettings.getState().setTheme('violet')
    await wait()
    expect(useSettingsSync.getState().state).toBe('error')
    serverHas({ ...DEFAULT_SETTINGS })
    await retrySettingsSync()
    expect(useSettingsSync.getState().state).toBe('saved')
    expect(puts().at(-1)![1].body.theme).toBe('violet')
  })

  it('stops completely: nothing is sent after logout, and a late reply from before is ignored', async () => {
    let reply!: (v: unknown) => void
    api.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)))
    const starting = startSettingsSync()
    stopSettingsSync() // logged out while the first request was still open
    reply({ settings: { theme: 'violet' } })
    await starting
    expect(local().theme).toBe(DEFAULT_SETTINGS.theme) // the late reply was not applied
    expect(useSettingsSync.getState().state).toBe('off')

    serverHas({ ...DEFAULT_SETTINGS })
    await startSettingsSync()
    useSettings.getState().setTheme('dracula')
    stopSettingsSync()
    await wait()
    expect(puts()).toHaveLength(0) // the waiting send was cancelled
  })
})
