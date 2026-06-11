import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $desktopBoot } from '@/store/boot'
import { $gatewayState } from '@/store/session'

import { useGatewayBoot } from './use-gateway-boot'

// End-to-end-ish repro of the "remote VPS → stuck on CONNECTING, no Settings"
// bug that drives the REAL useGatewayBoot hook + REAL HermesGateway through a
// fake WebSocket we fully control. No Docker / no real port: from the desktop's
// point of view a "remote VPS" is just a WebSocket that opens once and later
// refuses to reopen, so that is exactly (and only) what we fake.
//
// The previous test (gateway-connecting-overlay.test.tsx) hand-set the stores
// and asserted the overlays; this one proves the HOOK actually PRODUCES that
// stuck store combo — closing the "inferred by reading code" gap on the
// post-boot reconnect loop.

type Listener = (ev: unknown) => void

// Minimal WebSocket stand-in implementing only what json-rpc-gateway.connect()
// touches: readyState, add/removeEventListener('open'|'error'|'close'), close().
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  // Flipped by the test: 'open' = next socket connects; 'fail' = next socket
  // errors (a dead remote). Mirrors a VPS going away after the first connect.
  static mode: 'open' | 'fail' = 'open'
  static sequence: Array<'open' | 'fail'> = []
  static instances: FakeWebSocket[] = []

  readyState = 0
  private listeners: Record<string, Set<Listener>> = {}

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
    const willOpen = (FakeWebSocket.sequence.shift() ?? FakeWebSocket.mode) === 'open'
    // Resolve on the next microtask/macrotask so connect()'s promise wiring is
    // in place before open/error fires (matches real async socket handshake).
    setTimeout(() => {
      if (willOpen) {
        this.readyState = FakeWebSocket.OPEN
        this.emit('open', {})
      } else {
        this.readyState = FakeWebSocket.CLOSED
        this.emit('error', {})
      }
    }, 0)
  }

  addEventListener(type: string, fn: Listener) {
    ;(this.listeners[type] ??= new Set()).add(fn)
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners[type]?.delete(fn)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  // Force-drop an open socket, as a sleeping laptop / restarted remote would.
  drop() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  private emit(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) {
      fn(ev)
    }
  }
}

function fakeDesktop() {
  const conn = {
    authMode: 'token' as const,
    baseUrl: 'https://vps.example.com',
    profile: 'default',
    token: 't',
    wsUrl: 'wss://vps.example.com/api/ws?token=t'
  }

  return {
    getConnection: vi.fn(async () => conn),
    getGatewayWsUrl: vi.fn(async () => conn.wsUrl),
    getBootProgress: vi.fn(async () => ({
      error: null,
      fakeMode: false,
      message: '',
      phase: 'init',
      progress: 0,
      running: true,
      timestamp: Date.now()
    })),
    onBootProgress: vi.fn(() => () => undefined),
    onBackendExit: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    onWindowStateChanged: vi.fn(() => () => undefined),
    touchBackend: vi.fn(async () => undefined),
    profile: { get: vi.fn(async () => ({ profile: 'default' })) }
  }
}

function Harness({
  refreshHermesConfig = async () => undefined,
  refreshSessions = async () => undefined
}: {
  refreshHermesConfig?: () => Promise<void>
  refreshSessions?: () => Promise<void>
}) {
  useGatewayBoot({
    handleGatewayEvent: () => undefined,
    onConnectionReady: () => undefined,
    onGatewayReady: () => undefined,
    refreshHermesConfig,
    refreshSessions
  })

  return null
}

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.mode = 'open'
  FakeWebSocket.sequence = []
  FakeWebSocket.instances = []
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = fakeDesktop()
  $gatewayState.set('idle')
  $desktopBoot.set({
    error: null,
    fakeMode: false,
    message: '',
    phase: 'init',
    progress: 0,
    running: true,
    timestamp: Date.now(),
    visible: true
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  ;(globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

// Let pending microtasks (awaits) AND the queued 0ms socket open/error fire.
async function flushAsync() {
  await act(async () => {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  })
}

// Drive the exponential backoff forward by its full cap so the next scheduled
// reconnect attempt actually runs (1s,2s,4s,8s,15s,15s…). Returns after the
// attempt's async work settles.
async function advanceBackoff() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
}

describe('useGatewayBoot remote reconnect loop (real hook, fake socket)', () => {
  it('FIX: initial boot retries a transient remote OAuth getConnection auth miss', async () => {
    const desktop = {
      ...fakeDesktop(),
      getConnection: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Your remote gateway session has expired. Open Settings → Gateway and click "Sign in" again.')
        )
        .mockResolvedValueOnce({
          authMode: 'oauth' as const,
          baseUrl: 'https://vps.example.com',
          profile: 'default',
          wsUrl: 'wss://vps.example.com/api/ws?ticket=stale'
        })
    }
    desktop.getGatewayWsUrl = vi.fn(async () => 'wss://vps.example.com/api/ws?ticket=fresh')
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    await flushAsync()
    await flushAsync()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    expect(desktop.getConnection).toHaveBeenCalledTimes(2)
  })

  it('FIX: initial boot keeps retrying remote OAuth auth misses long enough for refresh', async () => {
    const authMiss = 'Your remote gateway session has expired. Open Settings → Gateway and click "Sign in" again.'
    const getConnection = vi.fn()

    for (let i = 0; i < 6; i += 1) {
      getConnection.mockRejectedValueOnce(new Error(authMiss))
    }

    getConnection.mockResolvedValueOnce({
      authMode: 'oauth' as const,
      baseUrl: 'https://vps.example.com',
      profile: 'default',
      wsUrl: 'wss://vps.example.com/api/ws?ticket=stale'
    })

    const desktop = {
      ...fakeDesktop(),
      getConnection
    }
    desktop.getGatewayWsUrl = vi.fn(async () => 'wss://vps.example.com/api/ws?ticket=fresh')
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
      await flushAsync()
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    expect(desktop.getConnection).toHaveBeenCalledTimes(7)
  })

  it('FIX: initial boot retries a failed gateway handshake with a fresh WS URL', async () => {
    FakeWebSocket.sequence = ['fail', 'open']
    const desktop = {
      ...fakeDesktop(),
      getConnection: vi.fn(async () => ({
        authMode: 'oauth' as const,
        baseUrl: 'https://vps.example.com',
        profile: 'default',
        wsUrl: 'wss://vps.example.com/api/ws?ticket=stale'
      }))
    }
    let ticket = 0
    desktop.getGatewayWsUrl = vi.fn(async () => `wss://vps.example.com/api/ws?ticket=fresh-${++ticket}`)
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    await flushAsync()
    await flushAsync()
    await flushAsync()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    expect(desktop.getGatewayWsUrl).toHaveBeenCalledTimes(2)
    expect(FakeWebSocket.instances.map(socket => socket.url)).toEqual([
      'wss://vps.example.com/api/ws?ticket=fresh-1',
      'wss://vps.example.com/api/ws?ticket=fresh-2'
    ])
  })

  it('FIX: initial boot retries transient session refresh timeouts before failing', async () => {
    const refreshSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timed out connecting to Hermes backend after 60000ms'))
      .mockResolvedValueOnce(undefined)

    render(<Harness refreshSessions={refreshSessions} />)
    await flushAsync()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    await flushAsync()

    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    expect(refreshSessions).toHaveBeenCalledTimes(2)
  })

  it('FIX: retryable initial boot failures keep retrying and clear once auth recovers', async () => {
    const authMiss = 'Your remote gateway session has expired. Open Settings → Gateway and click "Sign in" again.'
    const getConnection = vi.fn()

    for (let i = 0; i < 10; i += 1) {
      getConnection.mockRejectedValueOnce(new Error(authMiss))
    }

    getConnection.mockResolvedValueOnce({
      authMode: 'oauth' as const,
      baseUrl: 'https://vps.example.com',
      profile: 'default',
      wsUrl: 'wss://vps.example.com/api/ws?ticket=stale'
    })

    const desktop = {
      ...fakeDesktop(),
      getConnection
    }
    desktop.getGatewayWsUrl = vi.fn(async () => 'wss://vps.example.com/api/ws?ticket=fresh')
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
      await flushAsync()
    }

    expect($desktopBoot.get().error).toContain('session has expired')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    await flushAsync()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    expect(desktop.getConnection).toHaveBeenCalledTimes(11)
  })

  it('INITIAL boot against a dead VPS: getConnection hangs (waitForHermes) → app sits in the connecting combo, then fails', async () => {
    // The report's actual path: a fresh launch pointed at an unreachable VPS.
    // startHermes()'s remote branch awaits waitForHermes() for 45s before it
    // throws, so the renderer's `await desktop.getConnection()` stays pending
    // that whole window. During it: gatewayState is still 'idle' (connect was
    // never reached) and boot.error is null → connecting=true → the fullscreen
    // CONNECTING overlay, latched, blocking Settings.
    let rejectConn: (e: Error) => void = () => undefined
    const desktop = fakeDesktop()
    desktop.getConnection = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectConn = reject
        })
    )
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()

    // getConnection is still pending — the dead-VPS wait. No socket was ever
    // created, gatewayState never left idle, boot.error is null.
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect($gatewayState.get()).not.toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    // ^ connecting === true here → fullscreen CONNECTING, no Settings.

    // After ~45s waitForHermes gives up and getConnection rejects → boot()
    // catch → failDesktopBoot → the BootFailureOverlay recovery surface.
    await act(async () => {
      rejectConn(new Error('Hermes backend did not become ready: timeout'))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect($desktopBoot.get().error).toBeTruthy()
  })

  it('a remote that drops post-boot keeps looping with NO boot.error (the dead-end CONNECTING combo)', async () => {
    render(<Harness />)
    await flushAsync()

    // Initial boot connected.
    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(1)

    // The remote VPS goes away: drop the live socket, and make every reopen
    // fail from here on.
    FakeWebSocket.mode = 'fail'
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    // Burn a couple backoff cycles BEFORE the escalation threshold (<6 attempts,
    // ~the first ~15s). This is the window where stock and fixed behave the
    // same: socket down, hook retrying, gatewayState non-open, boot.error still
    // null → CONNECTING covers the screen with no recovery surface. (Past ~45s
    // the fix raises boot.error; that's asserted in the next test.)
    await advanceBackoff()

    expect($gatewayState.get()).not.toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    // It is actively retrying, not idle — more sockets were minted.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1)
  })

  it('FIX: after the prolonged drop the hook raises a recoverable boot error (the escape hatch)', async () => {
    render(<Harness />)
    await flushAsync()
    expect($desktopBoot.get().error).toBeNull()

    FakeWebSocket.mode = 'fail'
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    // Walk the backoff past the >=6 attempt threshold (~45s of failures).
    for (let i = 0; i < 8; i += 1) {
      await advanceBackoff()
    }

    // The hook surfaced the recoverable error → BootFailureOverlay (Use local
    // gateway / Sign in / Retry) becomes reachable instead of CONNECTING.
    expect($desktopBoot.get().error).toBeTruthy()
  })

  it('FIX: a successful reconnect clears the recoverable error', async () => {
    render(<Harness />)
    await flushAsync()

    FakeWebSocket.mode = 'fail'
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    for (let i = 0; i < 8; i += 1) {
      await advanceBackoff()
    }

    expect($desktopBoot.get().error).toBeTruthy()

    // The remote comes back: next reconnect attempt opens.
    FakeWebSocket.mode = 'open'
    await advanceBackoff()

    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
  })
})
