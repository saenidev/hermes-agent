import { isGatewayReauthRequired, resolveGatewayWsUrl } from '@hermes/shared'
import { useEffect, useRef } from 'react'

import type { HermesConnection } from '@/global'
import { HermesGateway } from '@/hermes'
import { translateNow } from '@/i18n'
import { desktopDefaultCwd } from '@/lib/desktop-fs'
import {
  $desktopBoot,
  applyDesktopBootProgress,
  completeDesktopBoot,
  failDesktopBoot,
  setDesktopBootStep
} from '@/store/boot'
import {
  $gateway,
  closeSecondaryGateways,
  configureGatewayRegistry,
  ensureGatewayForProfile,
  pruneSecondaryGateways,
  reconnectSecondaryGateways,
  reportPrimaryGatewayState,
  setPrimaryGateway,
  touchSecondaryGateways
} from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey, touchActiveGatewayBackend } from '@/store/profile'
import {
  $activeSessionId,
  $attentionSessionIds,
  $connection,
  $currentCwd,
  $sessions,
  $workingSessionIds,
  ensureDefaultWorkspaceCwd,
  setConnection,
  setCurrentBranch,
  setCurrentCwd,
  setSessionsLoading
} from '@/store/session'
import type { RpcEvent } from '@/types/hermes'

// After this many consecutive failed reconnects (≈45s with the 1→15s backoff)
// raise a recoverable boot error. Otherwise a dropped remote gateway loops the
// backoff forever behind the fullscreen CONNECTING overlay with no way to reach
// Settings / sign in / switch to local — the "lost connection breaks the app"
// dead end. The next successful reconnect clears it.
const RECONNECT_ESCALATE_AFTER = 6

interface GatewayBootOptions {
  handleGatewayEvent: (event: RpcEvent) => void
  onConnectionReady: (
    connection: Awaited<ReturnType<NonNullable<typeof window.hermesDesktop>['getConnection']>> | null
  ) => void
  onGatewayReady: (gateway: HermesGateway | null) => void
  refreshHermesConfig: () => Promise<void>
  refreshSessions: () => Promise<void>
}

const INITIAL_CONNECTION_ATTEMPTS = 10
const INITIAL_BOOT_DATA_ATTEMPTS = 4
const INITIAL_BOOT_RECOVERY_RETRY_DELAY_MS = 5_000
const INITIAL_GATEWAY_CONNECT_ATTEMPTS = 3
const INITIAL_GATEWAY_CONNECT_RETRY_DELAY_MS = 1_000
const INITIAL_GATEWAY_CONNECT_MAX_RETRY_DELAY_MS = 15_000
const RECOVERABLE_GATEWAY_RECONNECT_FAILURES = 6
const RETRYABLE_INITIAL_REMOTE_AUTH_ERRORS = [
  'Your remote gateway session has expired',
  'Remote Hermes gateway uses OAuth, but you are not signed in'
]
const RETRYABLE_INITIAL_BOOT_ERRORS = [
  ...RETRYABLE_INITIAL_REMOTE_AUTH_ERRORS,
  'Timed out connecting to Hermes backend',
  'Hermes backend did not become ready',
  'Could not connect to Hermes gateway',
  'Hermes gateway connection closed'
]

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function messageIncludesAny(error: unknown, fragments: string[]) {
  const message = getErrorMessage(error)

  return fragments.some(fragment => message.includes(fragment))
}

function isRetryableInitialConnectionError(error: unknown) {
  return messageIncludesAny(error, RETRYABLE_INITIAL_REMOTE_AUTH_ERRORS)
}

function isRetryableInitialBootError(error: unknown) {
  return messageIncludesAny(error, RETRYABLE_INITIAL_BOOT_ERRORS)
}

export function useGatewayBoot({
  handleGatewayEvent,
  onConnectionReady,
  onGatewayReady,
  refreshHermesConfig,
  refreshSessions
}: GatewayBootOptions) {
  const callbacksRef = useRef({
    handleGatewayEvent,
    onConnectionReady,
    onGatewayReady,
    refreshHermesConfig,
    refreshSessions
  })

  callbacksRef.current = {
    handleGatewayEvent,
    onConnectionReady,
    onGatewayReady,
    refreshHermesConfig,
    refreshSessions
  }

  useEffect(() => {
    let cancelled = false
    const desktop = window.hermesDesktop

    const publish = (next: HermesConnection | null) => {
      callbacksRef.current.onConnectionReady(next)
      setConnection(next)
    }

    if (!desktop) {
      failDesktopBoot('Desktop IPC bridge is unavailable.')
      setSessionsLoading(false)

      return () => void (cancelled = true)
    }

    // --- Reconnect-after-sleep machinery -------------------------------------
    // macOS sleep silently drops the renderer's WebSocket. The backend Python
    // process keeps running, but nothing re-opened the socket on wake, so the
    // composer stayed disabled forever on "Starting Hermes...". Once the
    // initial boot succeeds we treat any non-open state as recoverable and
    // reconnect with backoff, and we nudge a reconnect on the OS/browser
    // signals that fire around wake (power resume, network online, the window
    // becoming visible).
    let bootCompleted = false
    let bootingInitialGateway = false
    let initialBootFailureNotified = false
    let initialBootRetryTimer: ReturnType<typeof setTimeout> | null = null
    let reconnecting = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let reconnectFailureCount = 0
    // Surface "sign in again" once per disconnect episode, not on every backoff
    // tick — a stale OAuth ticket fails every attempt and would otherwise stack
    // identical error toasts (and their haptics). Reset on the next clean open.
    let reauthNotified = false
    // Raised once the reconnect loop crosses RECONNECT_ESCALATE_AFTER so the
    // recovery overlay replaces the dead-end CONNECTING screen. Reset on a clean
    // open or a manual/wake-driven reconnect.
    let escalated = false

    // Wrap the live getter in a call so TS control-flow analysis doesn't narrow
    // `connectionState` to a constant across the early-return guards (the state
    // genuinely changes between reads).
    const gatewayOpen = () => gateway.connectionState === 'open'

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const clearInitialBootRetryTimer = () => {
      if (initialBootRetryTimer !== null) {
        clearTimeout(initialBootRetryTimer)
        initialBootRetryTimer = null
      }
    }

    const waitForInitialGatewayRetry = (attempt: number) =>
      new Promise<void>(resolve => {
        setTimeout(
          resolve,
          Math.min(INITIAL_GATEWAY_CONNECT_MAX_RETRY_DELAY_MS, INITIAL_GATEWAY_CONNECT_RETRY_DELAY_MS * 2 ** attempt)
        )
      })

    const getInitialConnection = async () => {
      let lastError: unknown

      for (let attempt = 0; attempt < INITIAL_CONNECTION_ATTEMPTS; attempt += 1) {
        try {
          return await desktop.getConnection()
        } catch (err) {
          lastError = err

          if (cancelled || !isRetryableInitialConnectionError(err) || attempt === INITIAL_CONNECTION_ATTEMPTS - 1) {
            throw err
          }

          await waitForInitialGatewayRetry(attempt)
        }
      }

      throw lastError
    }

    const connectGatewayWithFreshUrl = async (conn: HermesConnection, attempts = 1) => {
      let lastError: unknown

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const wsUrl = await resolveGatewayWsUrl(desktop, conn)
          await gateway.connect(wsUrl)
          return
        } catch (err) {
          lastError = err

          if (cancelled || isGatewayReauthRequired(err) || attempt === attempts - 1) {
            throw err
          }

          await waitForInitialGatewayRetry(attempt)
        }
      }

      throw lastError
    }

    const runInitialBootDataStep = async (fn: () => Promise<void>) => {
      let lastError: unknown

      for (let attempt = 0; attempt < INITIAL_BOOT_DATA_ATTEMPTS; attempt += 1) {
        try {
          await fn()
          return
        } catch (err) {
          lastError = err

          if (cancelled || attempt === INITIAL_BOOT_DATA_ATTEMPTS - 1) {
            throw err
          }

          await waitForInitialGatewayRetry(attempt)
        }
      }

      throw lastError
    }

    const attemptReconnect = async () => {
      if (cancelled || reconnecting || gatewayOpen()) {
        return
      }

      reconnecting = true

      try {
        // Drop a stale REMOTE backend cache before re-dialing. After sleep/wake a
        // remote backend can become unreachable, but it has no child process
        // whose 'exit' would clear the main process's cached descriptor — without
        // this the renderer re-dials the same dead endpoint forever and stays on
        // "Starting Hermes…". The probe is a no-op for a healthy or local backend.
        await desktop.revalidateConnection?.().catch(() => undefined)

        const conn = await desktop.getConnection($activeGatewayProfile.get())

        if (cancelled) {
          return
        }

        publish(conn)
        // Re-mint the WS URL before reconnecting. OAuth tickets are single-use
        // with a short TTL, so the ticket baked into the cached conn.wsUrl is
        // dead on every reconnect after the initial boot — reusing it surfaces
        // as an opaque "Could not connect to Hermes gateway". resolveGatewayWsUrl
        // mints a fresh ticket (or throws a reauth error in OAuth mode rather
        // than connecting with a stale one). For local/token gateways the URL
        // carries a long-lived token and the re-mint is a cheap no-op.
        await connectGatewayWithFreshUrl(conn)

        if (cancelled) {
          return
        }

        reconnectAttempt = 0
        reconnectFailureCount = 0
        // Resync state that may have moved on the backend while we were asleep.
        await callbacksRef.current.refreshHermesConfig().catch(() => undefined)
        await callbacksRef.current.refreshSessions().catch(() => undefined)
      } catch (err) {
        // OAuth session expired mid-reconnect: surface the actionable "sign in
        // again" message once instead of silently looping the backoff against a
        // ticket that can never succeed. Transport failures fall through to the
        // backoff in the finally block below.
        if (!cancelled && isGatewayReauthRequired(err) && !reauthNotified) {
          reauthNotified = true
          notifyError(err, translateNow('boot.errors.gatewaySignInRequired'))
        }

        if (!cancelled && !isGatewayReauthRequired(err)) {
          reconnectFailureCount += 1

          if (reconnectFailureCount >= RECOVERABLE_GATEWAY_RECONNECT_FAILURES && !$desktopBoot.get().error) {
            failDesktopBoot(translateNow('boot.errors.gatewayReconnectFailed'))
          }
        }
      } finally {
        reconnecting = false

        if (!cancelled && !gatewayOpen()) {
          if (reconnectAttempt >= RECONNECT_ESCALATE_AFTER && !escalated) {
            escalated = true
            failDesktopBoot(translateNow('boot.errors.gatewayConnectionLost'))
          }

          scheduleReconnect()
        }
      }
    }

    function scheduleReconnect() {
      if (cancelled || reconnecting || reconnectTimer !== null || gatewayOpen()) {
        return
      }

      // 1s, 2s, 4s … capped at 15s.
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4))
      reconnectAttempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void attemptReconnect()
      }, delay)
    }

    function scheduleInitialBootRetry() {
      if (cancelled || bootCompleted || initialBootRetryTimer !== null) {
        return
      }

      initialBootRetryTimer = setTimeout(() => {
        initialBootRetryTimer = null

        if (cancelled || bootCompleted) {
          return
        }

        setDesktopBootStep({
          phase: 'renderer.boot',
          message: translateNow('boot.steps.startingDesktopConnection'),
          progress: 6
        })
        void boot()
      }, INITIAL_BOOT_RECOVERY_RETRY_DELAY_MS)
    }

    const reconnectNow = () => {
      if (cancelled || !bootCompleted) {
        return
      }

      clearReconnectTimer()
      reconnectAttempt = 0
      escalated = false
      reconnectSecondaryGateways()

      if (!gatewayOpen()) {
        void attemptReconnect()
      }
    }

    const offBootProgress = desktop.onBootProgress(payload => applyDesktopBootProgress(payload))
    void desktop
      .getBootProgress()
      .then(snapshot => applyDesktopBootProgress(snapshot))
      .catch(() => undefined)

    setDesktopBootStep({
      phase: 'renderer.boot',
      message: translateNow('boot.steps.startingDesktopConnection'),
      progress: 6
    })

    const gateway = new HermesGateway()
    callbacksRef.current.onGatewayReady(gateway)
    setPrimaryGateway(gateway, normalizeProfileKey($activeGatewayProfile.get()))
    // Secondary (background-profile) sockets funnel into the same handler.
    configureGatewayRegistry({ onEvent: event => callbacksRef.current.handleGatewayEvent(event) })

    const offState = gateway.onState(st => {
      // Mirror to the composer only while the primary is the active profile —
      // a background secondary reconnect mustn't flip the foreground state.
      reportPrimaryGatewayState(st)

      if (st === 'open') {
        reconnectAttempt = 0
        reconnectFailureCount = 0
        reauthNotified = false
        escalated = false
        clearReconnectTimer()

        // A revalidate-driven reconnect can rebuild the backend in place when the
        // cached remote was found dead, which re-drives the boot-progress overlay.
        // Unlike the initial boot, nothing calls completeDesktopBoot() afterwards,
        // so dismiss it here once we're open again — otherwise the overlay sticks
        // at ~94%. A no-op on a normal (non-rebuild) reconnect.
        if (bootCompleted) {
          completeDesktopBoot()
        }
      } else if (bootCompleted && (st === 'closed' || st === 'error')) {
        // The socket dropped after a healthy boot (typically sleep/wake). Try
        // to bring it back instead of leaving the composer stuck disabled.
        scheduleReconnect()
      }
    })

    const offEvent = gateway.onEvent(event => callbacksRef.current.handleGatewayEvent(event))

    // Wake signals: power resume (macOS/Windows), network coming back, and the
    // window regaining focus/visibility. Each nudges an immediate reconnect.
    const offPowerResume = desktop.onPowerResume?.(() => reconnectNow())

    const onOnline = () => reconnectNow()

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reconnectNow()
      }
    }

    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)

    // Keep live pool backends alive while this window is open (the main process
    // can't observe the direct renderer↔backend WS). No-op for the primary.
    const keepaliveTimer = setInterval(() => {
      touchActiveGatewayBackend()
      touchSecondaryGateways()
    }, 60_000)

    // Bound concurrency cost to live work: keep a background socket only while
    // its profile has a running (working) or blocked (needs-input) session.
    // Once that profile goes idle its socket is dropped and its backend is free
    // to idle-reap. The active profile is always spared.
    const recomputeKeptGateways = () => {
      const live = new Set([...$workingSessionIds.get(), ...$attentionSessionIds.get()])
      const keep = new Set<string>()

      for (const session of $sessions.get()) {
        if (live.has(session.id)) {
          keep.add(normalizeProfileKey(session.profile))
        }
      }

      pruneSecondaryGateways(keep)
    }

    const offWorking = $workingSessionIds.subscribe(() => recomputeKeptGateways())
    const offAttention = $attentionSessionIds.subscribe(() => recomputeKeptGateways())
    const offActiveProfile = $activeGatewayProfile.subscribe(() => recomputeKeptGateways())

    const offWindowState = desktop.onWindowStateChanged?.(payload => {
      const current = $connection.get()

      if (current) {
        publish({ ...current, ...payload })
      }
    })

    const offExit = desktop.onBackendExit(() => {
      if ($desktopBoot.get().running || $desktopBoot.get().visible) {
        failDesktopBoot(translateNow('boot.errors.backgroundExitedDuringStartup'))
      }

      notify({
        kind: 'error',
        title: translateNow('boot.errors.backendStopped'),
        message: translateNow('boot.errors.backgroundExited'),
        durationMs: 0
      })
    })

    async function boot() {
      if (cancelled || bootCompleted || bootingInitialGateway) {
        return
      }

      bootingInitialGateway = true

      try {
        const conn = await getInitialConnection()

        if (cancelled) {
          return
        }

        setDesktopBootStep({
          phase: 'renderer.gateway.connect',
          message: translateNow('boot.steps.connectingGateway'),
          progress: 95
        })
        publish(conn)
        // Mint a fresh WS URL right before connecting. For OAuth gateways the
        // ticket is single-use with a short TTL, so the ticket baked into
        // conn.wsUrl is stale; resolveGatewayWsUrl() re-mints it and, on
        // failure, throws a reauth error rather than connecting with a dead
        // ticket (which would surface as an opaque "connection closed").
        await connectGatewayWithFreshUrl(conn, INITIAL_GATEWAY_CONNECT_ATTEMPTS)

        if (cancelled) {
          return
        }

        // Record which profile the primary (window) backend booted as, so
        // same-profile resumes are no-op swaps and any reconnect targets the
        // right backend. Best-effort: a missing preference means "default".
        try {
          const pref = await desktop.profile?.get?.()
          const profileKey = (pref?.profile ?? '').trim() || 'default'
          $activeGatewayProfile.set(profileKey)
          setPrimaryGateway(gateway, profileKey)
          void ensureGatewayForProfile(profileKey)
        } catch {
          $activeGatewayProfile.set('default')
        }

        setDesktopBootStep({
          phase: 'renderer.config',
          message: translateNow('boot.steps.loadingSettings'),
          progress: 97
        })
        await ensureDefaultWorkspaceCwd()
        const remoteDefault = await desktopDefaultCwd().catch(() => null)

        if (remoteDefault?.cwd && !$activeSessionId.get() && !$currentCwd.get()) {
          setCurrentCwd(remoteDefault.cwd)
          setCurrentBranch(remoteDefault.branch || '')
        }
        await runInitialBootDataStep(() => callbacksRef.current.refreshHermesConfig())

        if (cancelled) {
          return
        }

        setDesktopBootStep({
          phase: 'renderer.sessions',
          message: translateNow('boot.steps.loadingSessions'),
          progress: 99
        })
        await runInitialBootDataStep(() => callbacksRef.current.refreshSessions())
        completeDesktopBoot()
        bootCompleted = true
        initialBootFailureNotified = false
        clearInitialBootRetryTimer()
      } catch (err) {
        if (!cancelled && !bootCompleted) {
          const message = getErrorMessage(err)
          failDesktopBoot(message)
          if (!initialBootFailureNotified) {
            notifyError(err, translateNow('boot.errors.desktopBootFailed'))
            initialBootFailureNotified = true
          }
          setSessionsLoading(false)

          if (isRetryableInitialBootError(err)) {
            scheduleInitialBootRetry()
          }
        }
      } finally {
        bootingInitialGateway = false
      }
    }

    void boot()

    return () => {
      cancelled = true
      clearInitialBootRetryTimer()
      clearReconnectTimer()
      clearInterval(keepaliveTimer)
      offWorking()
      offAttention()
      offActiveProfile()
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      offPowerResume?.()
      offState()
      offEvent()
      offExit()
      offWindowState?.()
      offBootProgress()
      closeSecondaryGateways()
      gateway.close()
      publish(null)
      callbacksRef.current.onGatewayReady(null)
      setPrimaryGateway(null)
      $gateway.set(null)
    }
  }, [])
}
