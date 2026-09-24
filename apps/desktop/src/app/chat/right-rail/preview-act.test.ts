import { types } from 'node:util'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewActHolder } from '@/lib/preview-act/act-in-page'
import { $rightRailActiveTabId } from '@/store/layout'
import { closeRightRail, openPreview, type PreviewTarget } from '@/store/preview'

import { actOnActivePreview } from './preview-act'
import { registerPreviewInput } from './preview-input'
import { registerPreviewNav } from './preview-nav'
import { registerPreviewScriptRunner } from './preview-script-runner'

function urlTarget(url: string): PreviewTarget {
  return { kind: 'url', label: 'Browser', source: url, url }
}

describe('actOnActivePreview (drive_preview tool)', () => {
  // URL targets share the singleton Browser tab id, so anything a test
  // registers would answer the next one.
  let cleanups: Array<() => void> = []
  const viewport = { width: 1024, height: 768 }

  const openBrowserTab = () => {
    openPreview(urlTarget('https://example.com'), 'tool-result')

    return $rightRailActiveTabId.get()!
  }

  const withRunner = (runner: (code: string) => Promise<unknown>) =>
    cleanups.push(registerPreviewScriptRunner(openBrowserTab(), runner))

  beforeEach(() => {
    vi.useRealTimers()

    for (const cleanup of cleanups) {
      cleanup()
    }

    cleanups = []
    closeRightRail()
    window.localStorage.clear()
  })

  it('tells the agent to open a page when no live pane is behind the tab', async () => {
    const result = await actOnActivePreview({ kind: 'elements' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('open_preview')
  })

  it('injects the engine and returns the page’s answer', async () => {
    let injected = ''

    withRunner(async code => {
      injected = code

      return JSON.stringify({
        acted: 'clicked button "Save"',
        elements: [],
        full: true,
        truncated: false,
        success: true
      })
    })

    const result = await actOnActivePreview({ kind: 'click', ref: '@e1' })

    expect(result).toMatchObject({ acted: 'clicked button "Save"', success: true })
    // Self-contained payload: the engine source and the action travel together,
    // and the holder keeps refs alive across calls on the same page.
    expect(injected).toContain('__hermesActHolder')
    expect(injected).toContain('"ref":"@e1"')
  })

  it('re-inventories after a mutating action so the next ref is current', async () => {
    const actions: string[] = []

    withRunner(code => {
      // Stand in for the guest page: run the script's own settle/rescan shape
      // by answering each act() call in order.
      actions.push(...(code.match(/"kind":"(\w+)"/g) ?? []))

      return Promise.resolve(
        JSON.stringify({
          acted: 'clicked',
          elements: [{ label: 'Log out', ref: '@e1', role: 'button', selector: '#out' }],
          full: true,
          truncated: false,
          success: true,
          url: 'https://example.com/app'
        })
      )
    })

    const result = await actOnActivePreview({ kind: 'click', ref: '@e1' })

    expect(result.elements?.[0].label).toBe('Log out')
    expect(result.url).toBe('https://example.com/app')
  })

  it('does not pay the settle delay for a plain inventory', async () => {
    let injected = ''
    withRunner(async code => {
      injected = code

      return JSON.stringify({ elements: [], full: true, truncated: false, success: true })
    })

    await actOnActivePreview({ kind: 'elements' })

    expect(injected).toContain('0 <= 0')
  })

  it('awaits page-owned thenables for inventories and settled actions before crossing Electron IPC', async () => {
    // Zone.js replaces Promise with a non-native thenable. Electron awaits
    // native V8 promises only; otherwise IPC delivers the object's state,
    // losing its prototype and then() instead of delivering the result.
    class PagePromise<T> {
      private pending: Promise<T>

      constructor(executor: ConstructorParameters<typeof Promise<T>>[0]) {
        this.pending = new Promise(executor)
      }

      static resolve<T>(value: T) {
        return new PagePromise<T>(resolve => resolve(value))
      }

      then(onFulfilled: (value: T) => unknown, onRejected?: (reason: unknown) => unknown) {
        return new PagePromise((resolve, reject) => {
          this.pending.then(onFulfilled, onRejected).then(resolve, reject)
        })
      }
    }

    document.body.innerHTML = '<button id="save">Save</button>'
    const clicked = vi.fn()
    document.getElementById('save')!.addEventListener('click', clicked)

    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 40,
      top: 0,
      width: 40,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    withRunner(async code => {
      const raw = new Function('Promise', 'return ' + code)(PagePromise)

      return types.isPromise(raw) ? await raw : JSON.parse(JSON.stringify(raw))
    })

    try {
      const inventory = await actOnActivePreview({ kind: 'elements' })
      expect(inventory.success).toBe(true)
      const save = inventory.elements!.find(element => element.label === 'Save')!
      expect(save).toBeDefined()
      expect(await actOnActivePreview({ kind: 'click', ref: save.ref })).toMatchObject({ success: true })
      expect(clicked).toHaveBeenCalledOnce()
      expect(await actOnActivePreview({ kind: 'click', ref: 'missing-ref' })).toMatchObject({ success: false })
    } finally {
      rect.mockRestore()
      document.body.replaceChildren()
      delete (window as unknown as { __hermesActHolder?: unknown }).__hermesActHolder
    }
  })

  it('reports a page that answers with nothing', async () => {
    withRunner(async () => '')

    expect((await actOnActivePreview({ kind: 'click', ref: '@e1' })).error).toContain('did not answer')
  })

  /** A pane that answers the locate trip with a fixed on-screen point, and the
   *  read-back trip with an empty inventory. Returns the input spy. */
  const withDrivenPane = () => {
    const tabId = openBrowserTab()
    const send = vi.fn()

    cleanups.push(
      registerPreviewScriptRunner(tabId, async code =>
        code.includes('"kind":"locate"')
          ? JSON.stringify({ acted: 'looking at button "Save"', point: { x: 120, y: 80 }, viewport, success: true })
          : // `hit` is the page's witness that the real pointerdown arrived.
            JSON.stringify({
              elements: [],
              full: true,
              truncated: false,
              hit: { tag: 'BUTTON', trusted: true },
              success: true
            })
      )
    )
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))

    return send
  }

  const sentTypes = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([event]) => event.type)

  it('clicks with real input, walking the pointer to where the page said', async () => {
    const send = withDrivenPane()

    const result = await actOnActivePreview({ kind: 'click', ref: '@e1' })
    const types = sentTypes(send)

    // Stepped rather than teleported: a page learns it is hovered from a stream
    // of moves, and one jump to the target skips everything in between.
    expect(types.filter(type => type === 'mouseMove').length).toBeGreaterThan(1)
    expect(types).toContain('mouseDown')
    expect(types).toContain('mouseUp')
    expect(send.mock.calls.map(([event]) => event).find(event => event.type === 'mouseDown')).toMatchObject({
      x: 120,
      y: 80
    })
    expect(result.acted).toBe('clicked button "Save"')
  })

  it('rejects overlapping typing across cache-busted engine instances before input', async () => {
    vi.useFakeTimers()
    const hotPath = './preview-act.ts?hot=single-flight-regression'
    const hot = (await import(/* @vite-ignore */ hotPath)) as { actOnActivePreview: typeof actOnActivePreview }
    const tabId = openBrowserTab()
    const values = { one: '', two: '' }
    let focused: 'one' | 'two' = 'one'

    const run = vi.fn(async (code: string) =>
      JSON.stringify(
        code.includes('"kind":"locate"')
          ? {
              acted: 'looking at input',
              point: { x: code.includes('"ref":"inp-one"') ? 10 : 30, y: 10 },
              viewport,
              success: true,
              typable: true
            }
          : { elements: [], full: true, truncated: false, hit: { tag: 'INPUT', trusted: true }, success: true }
      )
    )

    cleanups.push(registerPreviewScriptRunner(tabId, run))
    cleanups.push(
      registerPreviewInput(tabId, {
        focus: vi.fn(),
        send: event => {
          if (event.type === 'mouseDown') {
            focused = event.x === 10 ? 'one' : 'two'
          }

          if (event.type === 'keyDown' && event.modifiers) {
            values[focused] = ''
          }

          if (event.type === 'char') {
            values[focused] += event.keyCode
          }
        }
      })
    )
    const first = actOnActivePreview({ kind: 'type', ref: 'inp-one', text: 'ABC' })
    const second = hot.actOnActivePreview({ kind: 'type', ref: 'inp-two', text: 'XYZ' })
    await vi.runAllTimersAsync()
    expect(await first).toMatchObject({ success: true })
    expect(await second).toMatchObject({ success: false, note: expect.stringMatching(/no input.*elements/i) })
    expect(values).toEqual({ one: 'ABC', two: '' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('excludes holder-changing operations until timed-out guest work actually settles', async () => {
    vi.useFakeTimers()
    let answer!: (value: unknown) => void

    const pendingGuest = new Promise(resolve => {
      answer = resolve
    })

    const run = vi.fn(() => pendingGuest)
    const nav = { back: vi.fn(), forward: vi.fn(), reload: vi.fn() }
    const tabId = openBrowserTab()

    cleanups.push(registerPreviewScriptRunner(tabId, run))
    cleanups.push(registerPreviewNav(tabId, nav))
    const first = actOnActivePreview({ kind: 'click', ref: 'btn-save' })

    for (const kind of ['elements', 'pin', 'unpin', 'hold', 'strobe', 'back', 'reload', 'type']) {
      expect(await actOnActivePreview({ kind })).toMatchObject({
        success: false,
        note: expect.stringContaining('No input')
      })
    }

    await vi.runAllTimersAsync()
    expect(await first).toMatchObject({ success: false, error: expect.stringMatching(/indeterminate/i) })
    expect(await actOnActivePreview({ kind: 'elements' })).toMatchObject({
      success: false,
      error: expect.stringContaining('still in flight')
    })
    expect(run).toHaveBeenCalledOnce()
    expect(nav.back).not.toHaveBeenCalled()
    expect(nav.reload).not.toHaveBeenCalled()
    answer(JSON.stringify({ success: true, elements: [], full: true, truncated: false }))
    await Promise.resolve()
    await Promise.resolve()
    expect(await actOnActivePreview({ kind: 'elements' })).toMatchObject({ success: true })
  })

  it.each([
    ['hover', { success: true }],
    ['press', { success: true }],
    ['scroll', { success: true }],
    [
      'click',
      {
        success: true,
        elements: 'not-an-inventory',
        full: true,
        truncated: false,
        hit: { tag: 'BUTTON', trusted: true }
      }
    ],
    ['hover', { success: true, elements: [], full: false, truncated: false }],
    ['hover', { success: true, elements: [], full: true, truncated: 'false' }],
    [
      'hover',
      {
        success: true,
        elements: [{ ref: 'x', label: 'X', role: 'input', editable: 'yes' }],
        full: true,
        truncated: false
      }
    ],
    ['hover', { success: true, delta: { removed: [7], same: -1 }, full: false, truncated: false }],
    ['hover', { success: true, delta: { changed: [{ ref: 'x', read_only: 1 }] }, full: false, truncated: false }],
    ['hover', { success: true, elements: [], delta: { same: 0 }, full: true, truncated: false }],
    ['click', { success: true, elements: [], full: true, truncated: false, hit: { trusted: true, tag: 3 } }]
  ])('rejects malformed %s post-dispatch evidence %j', async (kind, reply) => {
    vi.useFakeTimers()
    const tabId = openBrowserTab()

    const run = vi.fn(async () =>
      JSON.stringify(
        run.mock.calls.length === 1
          ? { success: true, acted: 'looking at input', point: { x: 10, y: 10 }, viewport, page: 100, span: 1000 }
          : reply
      )
    )

    const send = vi.fn()
    cleanups.push(registerPreviewScriptRunner(tabId, run))
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))
    const pending = actOnActivePreview({ kind: kind as string, ref: kind === 'scroll' ? undefined : 'inp-one' })
    await vi.runAllTimersAsync()
    const result = await pending
    expect(send).toHaveBeenCalled()
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/indeterminate/i),
      note: expect.stringMatching(/do not repeat/i)
    })
    expect(result.acted).toBeUndefined()
    expect(result.elements).toBeUndefined()
    expect(result.delta).toBeUndefined()
  })

  const member = { ref: 'x', role: 'button', label: 'X' }

  it.each([
    { elements: [member, member], full: true },
    { elements: [{ ...member, ref: '' }], full: true },
    { elements: [{ ...member, ref: ' x ' }], full: true },
    { elements: [{ ...member, unexpected: {} }], full: true },
    ...[
      { added: [member, member] },
      {
        changed: [
          { ref: 'x', label: 'Y' },
          { ref: 'x', value: 'Z' }
        ]
      },
      { removed: ['x', 'x'] },
      { rebound: ['x', 'x'] },
      { removed: [''] },
      { rebound: [''] },
      { changed: [{ ref: '' }] },
      { added: [{ ...member, ref: '' }] },
      { removed: [' '] },
      { added: [member], removed: ['x'] },
      { added: [member], changed: [{ ref: 'x', label: 'Y' }] },
      { added: [member], rebound: ['x'] },
      { removed: ['x'], changed: [{ ref: 'x', label: 'Y' }] },
      { removed: ['x'], rebound: ['x'] },
      { changed: [{ ref: 'x', role: 'button' }] },
      { changed: [{ ref: 'x', selector: '#other' }] },
      { changed: [{ ref: 'x', unexpected: true }] },
      { added: [{ ...member, unexpected: 'value' }] }
    ].map(delta => ({ delta, full: false }))
  ])('rejects incoherent inventory before input or as indeterminate after dispatch: %j', async payload => {
    vi.useFakeTimers()

    for (const stage of ['preflight', 'readback']) {
      const tabId = openBrowserTab()
      const send = vi.fn()
      const located = { point: { x: 120, y: 80 }, viewport, success: true }

      const run = vi.fn(async () =>
        JSON.stringify(
          stage === 'readback' && run.mock.calls.length === 1
            ? located
            : { ...located, ...payload, truncated: true, acted: 'clicked X', hit: { tag: 'BUTTON', trusted: true } }
        )
      )

      cleanups.push(registerPreviewScriptRunner(tabId, run))
      cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))
      const pending = actOnActivePreview({ kind: 'click', ref: 'x' })
      await vi.runAllTimersAsync()
      const result = await pending
      expect(result.success).toBe(false)
      expect(result.error).toMatch(stage === 'preflight' ? /before.*input/i : /indeterminate/i)
      expect(result.acted).toBeUndefined()
      expect(result.elements).toBeUndefined()
      expect(result.delta).toBeUndefined()
      expect(run).toHaveBeenCalledTimes(stage === 'preflight' ? 1 : 2)

      if (stage === 'preflight') {
        expect(send).not.toHaveBeenCalled()
      } else {
        expect(sentTypes(send).filter(type => type === 'mouseDown')).toHaveLength(1)
        expect(result.note).toMatch(/do not repeat/i)
      }
    }
  })

  it.each([
    { elements: [member], full: true },
    { delta: { same: 0 }, full: false },
    {
      delta: { added: [member], removed: ['old'], changed: [{ ref: 'kept', label: 'New' }], rebound: ['recreated'] },
      full: false
    },
    {
      delta: {
        changed: [
          { ref: 'x', editable: true, read_only: false, input_type: 'text', value: 'Y', disabled: false, label: 'Y' }
        ],
        rebound: ['x']
      },
      full: false
    }
  ])('preserves coherent full/delta inventory and metadata: %j', async payload => {
    vi.useFakeTimers()
    const tabId = openBrowserTab()
    const send = vi.fn()

    const run = vi.fn(async () =>
      JSON.stringify(
        run.mock.calls.length === 1
          ? { point: { x: 120, y: 80 }, viewport, success: true }
          : { ...payload, success: true, truncated: true, hit: { tag: 'BUTTON', trusted: true } }
      )
    )

    cleanups.push(registerPreviewScriptRunner(tabId, run))
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))
    const pending = actOnActivePreview({ kind: 'click', ref: 'x' })
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ ...payload, success: true, truncated: true, acted: expect.any(String) })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it.each([{ x: '12', y: 8 }, { x: null, y: 8 }, { x: -1, y: 8 }, {}, true])(
    'rejects malformed locate geometry before input: %j',
    async point => {
      vi.useFakeTimers()
      const tabId = openBrowserTab()
      const send = vi.fn()
      cleanups.push(registerPreviewScriptRunner(tabId, async () => JSON.stringify({ success: true, point, viewport })))
      cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))
      const pending = actOnActivePreview({ kind: 'click', ref: 'btn-save' })
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({ success: false, error: expect.stringMatching(/before.*input/i) })
      expect(send).not.toHaveBeenCalled()
    }
  )

  it.each([
    { point: { x: 1e308, y: 8 } },
    { point: { x: 8, y: 1e308 } },
    { point: { x: 1025, y: 8 } },
    { page: 1e308 },
    { span: 1e308 },
    { amount: 1e308 },
    { amount: -1e308 },
    { amount: Number.NaN },
    { amount: Number.POSITIVE_INFINITY }
  ])('rejects unrepresentable geometry without poisoning the next glide: %j', async invalid => {
    vi.useFakeTimers()
    const tabId = openBrowserTab()
    const send = vi.fn()
    let malformed = false

    const anchor = {
      point: { x: 120, y: 80 },
      viewport: { width: 1024, height: 768 },
      page: 700,
      span: 4000,
      success: true
    }

    const run = vi.fn(async (code: string) =>
      JSON.stringify(
        code.includes('"kind":"locate"') || code.includes('scrollHeight')
          ? { ...anchor, ...(malformed ? invalid : {}) }
          : { elements: [], full: true, truncated: false, success: true }
      )
    )

    cleanups.push(registerPreviewScriptRunner(tabId, run))
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))

    const perform = async (action: Parameters<typeof actOnActivePreview>[0]) => {
      const pending = actOnActivePreview(action)
      await vi.runAllTimersAsync()

      return pending
    }

    expect(await perform({ kind: 'hover', ref: 'x' })).toMatchObject({ success: true })
    send.mockClear()
    run.mockClear()
    malformed = true
    const result = await perform({ kind: 'point' in invalid ? 'hover' : 'scroll', amount: invalid.amount })
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/before.*input/i) })
    expect(send).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledOnce()
    malformed = false
    expect(await perform({ kind: 'hover', ref: 'x' })).toMatchObject({ success: true })
    expect(send.mock.calls.map(([event]) => event)).toEqual([
      { type: 'mouseMove', x: 120, y: 80 },
      { type: 'mouseMove', x: 120, y: 80 },
      { type: 'mouseMove', x: 120, y: 80 }
    ])
    send.mockClear()
    expect(await perform({ kind: 'scroll', amount: -700 })).toMatchObject({ success: true })
    const wheels = send.mock.calls.map(([event]) => event).filter(event => event.type === 'mouseWheel')
    expect(wheels.length).toBeGreaterThan(1)
    expect(wheels.every(event => event.deltaY > 0)).toBe(true)
    expect(wheels.reduce((sum, event) => sum + event.deltaY, 0)).toBe(700)
  })

  it('types by pressing keys, after selecting whatever the field held', async () => {
    const send = withDrivenPane()

    await actOnActivePreview({ kind: 'type', ref: '@e1', submit: true, text: 'hi' })

    const events = send.mock.calls.map(([event]) => event)
    const chars = events.filter(event => event.type === 'char').map(event => event.keyCode)

    // One click to focus, then select-all by keyboard — NOT the triple-click
    // this used to do. A triple-click is a pointer gesture, so it grabs the
    // paragraph under the cursor whenever the target turns out not to be a
    // field, and the agent was leaving pages with their body text highlighted.
    expect(events.filter(event => event.type === 'mouseDown').map(event => event.clickCount)).toEqual([1])
    expect(events.filter(event => event.type === 'keyDown' && event.keyCode === 'a')[0]).toMatchObject({
      modifiers: ['control', 'meta']
    })
    // The chord must not send a `char` phase, or select-all types a literal 'a'.
    expect(chars).toEqual(['h', 'i', 'Enter'])
  })

  it('hovers by walking the pointer over and leaving it there', async () => {
    const send = withDrivenPane()

    const result = await actOnActivePreview({ kind: 'hover', ref: '@e1' })
    const types = sentTypes(send)

    expect(types).toContain('mouseMove')
    // The whole request is "be on it" — a click here would open the dropdown the
    // agent was trying to reveal, or worse, activate it.
    expect(types).not.toContain('mouseDown')
    expect(result.acted).toBe('hovered over button "Save"')
  })

  // The witness only speaks for verbs that put the button down. Demanding one
  // from a key press reported every press as a failure.
  it('does not expect a click witness from a verb that never clicks', async () => {
    const tabId = openBrowserTab()

    cleanups.push(
      registerPreviewScriptRunner(tabId, async code =>
        code.includes('"kind":"locate"')
          ? JSON.stringify({ acted: 'looking at textbox "Search"', point: { x: 40, y: 20 }, viewport, success: true })
          : JSON.stringify({ elements: [], full: true, truncated: false, hit: null, success: true })
      )
    )
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send: vi.fn() }))

    for (const action of [
      { key: 'Escape', kind: 'press', ref: '@e1' },
      { kind: 'hover', ref: '@e1' }
    ]) {
      expect(await actOnActivePreview(action)).toMatchObject({ success: true })
    }
  })

  it('scrolls by wheeling for real, not by scripting the page', async () => {
    const tabId = openBrowserTab()
    const send = vi.fn()
    let scripted = false

    cleanups.push(
      registerPreviewScriptRunner(tabId, async code => {
        scripted ||= code.includes('"kind":"scroll"')

        return code.includes('scrollHeight')
          ? JSON.stringify({ page: 700, point: { x: 500, y: 400 }, viewport, span: 4_000, success: true })
          : JSON.stringify({ elements: [], full: true, truncated: false, success: true })
      })
    )
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))

    await actOnActivePreview({ kind: 'scroll' })

    const wheels = send.mock.calls.map(([event]) => event).filter(event => event.type === 'mouseWheel')

    // A stream of notches, not one delta: scroll-linked headers and lazy loaders
    // only react to the events, so a scripted scrollBy leaves them asleep.
    expect(wheels.length).toBeGreaterThan(1)
    // Electron's wheel delta is wheelDelta-signed, so scrolling DOWN is negative.
    expect(wheels.every(event => event.deltaY < 0)).toBe(true)
    expect(scripted).toBe(false)
  })

  it('says so plainly when the page has nothing to scroll', async () => {
    const tabId = openBrowserTab()

    cleanups.push(
      registerPreviewScriptRunner(tabId, async () =>
        JSON.stringify({ page: 700, point: { x: 500, y: 400 }, viewport, span: 0, success: true })
      )
    )
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send: vi.fn() }))

    expect(await actOnActivePreview({ kind: 'scroll' })).toMatchObject({
      note: expect.stringContaining('nothing to scroll')
    })
  })

  it('does not mistake a missing witness for proof that nothing happened', async () => {
    const tabId = openBrowserTab()

    cleanups.push(
      registerPreviewScriptRunner(tabId, async code =>
        code.includes('"kind":"locate"')
          ? JSON.stringify({ acted: 'looking at button "Save"', point: { x: 12, y: 8 }, viewport, success: true })
          : JSON.stringify({ elements: [], full: true, truncated: false, hit: null, success: true })
      )
    )
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send: vi.fn() }))

    const result = await actOnActivePreview({ kind: 'click', ref: '@e1' })

    // Everything else about this action travels on the script channel and would
    // report success whether or not a single event landed.
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/indeterminate/i)
    expect(result.note).toMatch(/do not repeat/i)
    expect(result.acted).toBeUndefined()
  })

  it.each([
    ['readback', 'full'],
    ['readback', 'delta'],
    ['preflight', 'full'],
    ['preflight', 'delta']
  ])('keeps inventory markers on a %s failure with a %s payload', async (stage, format) => {
    vi.useFakeTimers()
    const tabId = openBrowserTab()
    const element = { label: 'Save', ref: 'btn-save', role: 'button' }

    const inventory = {
      ...(format === 'full' ? { elements: [element] } : { delta: { added: [element], same: 1 } }),
      full: format === 'full',
      truncated: true
    }

    const run = vi.fn(async () =>
      JSON.stringify(
        stage === 'readback' && run.mock.calls.length === 1
          ? { acted: 'looking at button "Save"', point: { x: 12, y: 8 }, viewport, success: true }
          : {
              ...inventory,
              error: stage === 'preflight' ? 'Target unavailable' : undefined,
              hit: null,
              success: stage === 'readback'
            }
      )
    )

    const send = vi.fn()
    cleanups.push(registerPreviewScriptRunner(tabId, run))
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))

    const pending = actOnActivePreview({ kind: 'click', ref: element.ref })
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.acted).toBeUndefined()
    expect(result.error).toMatch(stage === 'readback' ? /indeterminate/i : /before.*input/i)
    expect(sentTypes(send).filter(type => type === 'mouseDown')).toHaveLength(stage === 'readback' ? 1 : 0)
    expect(result).toMatchObject(inventory)
  })

  it.each(['navigated', 'silent', 'rejected', 'malformed', 'read-failed', 'untrusted', 'input-threw'])(
    'reports %s after dispatch as indeterminate without repeating the action',
    async mode => {
      vi.useFakeTimers()
      const tabId = openBrowserTab()
      const beforeUrl = 'https://example.com/before'
      const afterUrl = mode === 'navigated' ? 'https://example.com/after' : beforeUrl

      const run = vi.fn(async () => {
        if (run.mock.calls.length === 1) {
          return JSON.stringify({
            acted: 'looking at button "Save"',
            point: { x: 12, y: 8 },
            viewport,
            success: true,
            url: beforeUrl
          })
        }

        if (mode === 'silent') {
          return new Promise(resolve => cleanups.push(() => resolve(undefined)))
        }

        if (mode === 'rejected') {
          throw new Error('document detached')
        }

        if (mode === 'malformed') {
          return '{broken'
        }

        return JSON.stringify({
          elements: [],
          full: true,
          truncated: false,
          error: mode === 'read-failed' ? 'inventory unavailable' : undefined,
          hit: mode === 'untrusted' ? { tag: 'BUTTON', trusted: false } : null,
          success: mode !== 'read-failed',
          url: afterUrl
        })
      })

      const send = vi.fn(event => {
        if (mode === 'input-threw' && event.type === 'mouseUp') {
          throw new Error('input channel lost after mouseDown')
        }
      })

      cleanups.push(registerPreviewScriptRunner(tabId, run))
      cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))

      const pending = actOnActivePreview({ kind: 'click', ref: '@e1' })
      await vi.runAllTimersAsync()
      const result = await pending
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/indeterminate/i)
      expect(result.note).toMatch(/do not repeat/i)
      expect(result.note).toContain('elements')
      expect(result.acted).toBeUndefined()
      expect(sentTypes(send).filter(type => type === 'mouseDown')).toHaveLength(1)

      if (mode === 'navigated') {
        expect(result.url).toBe(afterUrl)
        expect(result.note).toMatch(/URL changed/i)
      }
    }
  )

  it.each(['click', 'scroll'])('does not claim %s happened when preflight never answered', async kind => {
    vi.useFakeTimers()
    const tabId = openBrowserTab()
    const run = vi.fn(() => new Promise(resolve => cleanups.push(() => resolve(undefined))))
    const send = vi.fn()
    cleanups.push(registerPreviewScriptRunner(tabId, run))
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))

    const pending = actOnActivePreview({ kind, ref: kind === 'click' ? '@e1' : undefined })
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/before.*input/i)
    expect(result.acted).toBeUndefined()
    expect(run).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['scroll', 'silent'],
    ['scroll', 'rejected'],
    ['scroll', 'malformed'],
    ['scroll', 'read-failed'],
    ['scroll', 'input-threw'],
    ['click', 'silent'],
    ['click', 'rejected'],
    ['click', 'malformed'],
    ['click', 'inventory-only'],
    ['elements', 'silent'],
    ['pin', 'silent']
  ])('does not turn a %s %s reply into action success', async (kind, mode) => {
    vi.useFakeTimers()
    const tabId = openBrowserTab()

    const run = vi.fn(async () => {
      if (kind === 'scroll' && run.mock.calls.length === 1) {
        return JSON.stringify({ page: 700, point: { x: 20, y: 30 }, viewport, span: 4_000, success: true })
      }

      if (mode === 'silent') {
        return new Promise(resolve => cleanups.push(() => resolve(undefined)))
      }

      if (mode === 'rejected') {
        throw new Error('document detached')
      }

      if (mode === 'malformed') {
        return '{broken'
      }

      return JSON.stringify({
        elements: [],
        full: true,
        truncated: false,
        error: mode === 'inventory-only' ? undefined : 'inventory unavailable',
        success: mode === 'inventory-only',
        title: 'After',
        url: 'https://example.com/after'
      })
    })

    const send = vi.fn(event => {
      if (mode === 'input-threw' && event.type === 'mouseWheel') {
        throw new Error('input channel lost during wheel gesture')
      }
    })

    cleanups.push(registerPreviewScriptRunner(tabId, run))

    if (kind === 'scroll') {
      cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send }))
    }

    const pending = actOnActivePreview({ kind, ref: kind === 'scroll' ? undefined : '@e1' })

    // Attach before advancing timers so a broken implementation fails this test,
    // not the suite's unhandled-rejection check.
    const settled = pending.then(
      result => ({ result }),
      error => ({ error })
    )

    await vi.runAllTimersAsync()
    const outcome = await settled

    if ('error' in outcome) {
      throw outcome.error
    }

    const { result } = outcome
    expect(result.success).toBe(false)
    expect(result.acted).toBeUndefined()
    expect(result.note).toContain('elements')
    expect(result.note).not.toMatch(/URL changed/i)

    if (kind !== 'elements') {
      expect(result.error).toMatch(/indeterminate/i)
      expect(result.note).toMatch(/do not repeat/i)
    } else {
      expect(result.error).not.toMatch(/indeterminate/i)
    }

    expect(run).toHaveBeenCalledTimes(kind === 'scroll' ? 2 : 1)

    if (mode === 'input-threw') {
      expect(sentTypes(send).filter(type => type === 'mouseWheel')).toHaveLength(1)
    }

    if (mode === 'read-failed' || mode === 'input-threw') {
      expect(result).toMatchObject({ title: 'After', url: 'https://example.com/after' })
    }
  })

  it.each(['removed', 'ambiguous'])('sends no input when the target becomes %s while settling', async mode => {
    document.body.innerHTML = '<button id="save">Save</button><button id="other">Other</button>'
    const save = document.getElementById('save')!
    const guest = window as unknown as { __hermesActHolder?: PreviewActHolder }

    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 40,
      top: 0,
      width: 40,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    // Only the injected preflight's RAF is wrapped. Both locate calls and the
    // engine are real; the target changes after the first successful locate.
    const settleFrame = vi.fn((callback: FrameRequestCallback) =>
      requestAnimationFrame(time => {
        if (mode === 'removed') {
          save.remove()
        } else {
          const book = guest.__hermesActHolder!.book!
          book[1].ref = book[0].ref
        }

        callback(time)
      })
    )

    const run = vi.fn(async code => await new Function('requestAnimationFrame', 'return ' + code)(settleFrame))
    const input = { focus: vi.fn(), send: vi.fn() }
    const tabId = openBrowserTab()
    cleanups.push(registerPreviewScriptRunner(tabId, run))
    cleanups.push(registerPreviewInput(tabId, input))

    try {
      const inventory = await actOnActivePreview({ kind: 'elements' })
      expect(inventory.success).toBe(true)
      const target = inventory.elements!.find(element => element.label === 'Save')!
      expect(target).toBeDefined()
      run.mockClear()

      const result = await actOnActivePreview({ kind: 'click', ref: target.ref })
      expect(settleFrame).toHaveBeenCalledOnce()
      expect(input.send).not.toHaveBeenCalled()
      expect(input.focus).not.toHaveBeenCalled()
      expect(run).toHaveBeenCalledOnce()
      expect(result.success).toBe(false)
      expect(result.acted).toBeUndefined()
      expect(result.error).toMatch(/before.*input/i)
      expect(result.error).toMatch(new RegExp(mode, 'i'))
      expect(result.note).toMatch(/no input was sent/i)
      expect(result.note).toContain('elements')
      expect(result).toMatchObject({ title: document.title, url: document.location.href })
    } finally {
      rect.mockRestore()
      document.body.replaceChildren()
      delete guest.__hermesActHolder
    }
  })

  it.each(['click', 'hover'])('keeps a real %s indeterminate when its injected readback throws', async kind => {
    document.body.innerHTML = '<button id="save">Save</button>'

    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 40,
      top: 0,
      width: 40,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    const scan = vi.spyOn(document, 'querySelectorAll')

    const breakRead = vi.fn(() => {
      scan.mockImplementation(() => {
        throw new Error('inventory unavailable after input')
      })
    })

    document.getElementById('save')!.addEventListener('click', breakRead)
    const tabId = openBrowserTab()
    cleanups.push(registerPreviewScriptRunner(tabId, async code => await new Function('return ' + code)()))

    if (kind === 'hover') {
      cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send: breakRead }))
    }

    try {
      const result = await actOnActivePreview({ kind, selector: '#save' })
      expect(breakRead).toHaveBeenCalled()

      if (kind === 'click') {
        expect(breakRead).toHaveBeenCalledOnce()
      }

      expect(result.success).toBe(false)
      expect(result.acted).toBeUndefined()
      expect(result.error).toMatch(/indeterminate/i)
      expect(result.note).toMatch(/do not repeat/i)
      expect(result.note).toContain('elements')
      expect(result).toMatchObject({ title: document.title, url: document.location.href })
    } finally {
      scan.mockRestore()
      rect.mockRestore()
      document.body.replaceChildren()
      delete (window as unknown as { __hermesActHolder?: unknown }).__hermesActHolder
    }
  })

  it('says so when the overlay itself swallowed the click', async () => {
    const tabId = openBrowserTab()

    cleanups.push(
      registerPreviewScriptRunner(tabId, async code =>
        code.includes('"kind":"locate"')
          ? JSON.stringify({ acted: 'looking at button "Save"', point: { x: 12, y: 8 }, viewport, success: true })
          : JSON.stringify({
              elements: [],
              full: true,
              truncated: false,
              hit: { tag: 'HERMES-WATCH', trusted: true },
              success: true
            })
      )
    )
    cleanups.push(registerPreviewInput(tabId, { focus: vi.fn(), send: vi.fn() }))

    expect((await actOnActivePreview({ kind: 'click', ref: '@e1' })).note).toContain('overlay intercepted')
  })

  it('falls back to scripted events when the pane exposes no input channel', async () => {
    let injected = ''

    withRunner(async code => {
      injected = code

      return JSON.stringify({ acted: 'clicked', elements: [], full: true, truncated: false, success: true })
    })

    await actOnActivePreview({ kind: 'click', ref: '@e1' })

    // The one-trip shape: the engine both acts and re-reads, no locate handshake.
    expect(injected).toContain('"kind":"click"')
    expect(injected).not.toContain('"kind":"locate"')
  })

  it('routes history verbs to the pane instead of the guest page', async () => {
    const back = vi.fn()
    const runner = vi.fn()

    const tabId = openBrowserTab()
    cleanups.push(registerPreviewNav(tabId, { back, forward: vi.fn(), reload: vi.fn() }))
    cleanups.push(registerPreviewScriptRunner(tabId, runner))

    const result = await actOnActivePreview({ kind: 'back' })

    expect(back).toHaveBeenCalledOnce()
    expect(runner).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.note).toContain('elements')
  })

  it('reports history verbs with no pane to drive', async () => {
    expect((await actOnActivePreview({ kind: 'reload' })).error).toContain('open_preview')
  })
})
