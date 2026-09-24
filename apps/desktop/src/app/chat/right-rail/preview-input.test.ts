import { describe, expect, it } from 'vitest'

import { toWebviewInputSpace, webviewAcceptsPoint } from './preview-input'

// #116281: the act engine measures targets in guest CSS pixels, but the
// webview's input space is css × zoom. At the shipped 90 % default an
// unscaled click landed 1/0.9 too far from the origin and missed silently.
describe('toWebviewInputSpace', () => {
  it("scales pointer events by the guest zoom so the reporter's 500,310 target is hit at 90 %", () => {
    const down = toWebviewInputSpace({ button: 'left', clickCount: 1, type: 'mouseDown', x: 500, y: 310 }, 0.9)

    expect(down).toEqual({ button: 'left', clickCount: 1, type: 'mouseDown', x: 450, y: 279 })
    expect(toWebviewInputSpace({ deltaX: 0, deltaY: 600, type: 'mouseWheel', x: 380, y: 467 }, 1.25)).toEqual({
      deltaX: 0,
      deltaY: 600,
      type: 'mouseWheel',
      x: 475,
      y: 584
    })
  })

  // A point that is valid in guest CSS pixels can still leave the native input
  // range once zoom scales it. Refuse at the boundary instead of letting
  // sendInputEvent receive a coordinate outside a signed 32-bit int.
  it('refuses a pointer event whose zoomed coordinate leaves the native input range', () => {
    const edge = { type: 'mouseMove', x: 2_147_483_646, y: 10 } as const

    expect(() => toWebviewInputSpace(edge, 1.25)).toThrow(RangeError)
    expect(() => toWebviewInputSpace({ ...edge, x: -1 }, 1)).toThrow(RangeError)
    expect(() => toWebviewInputSpace({ ...edge, x: Number.NaN }, 0.9)).toThrow(RangeError)
    expect(toWebviewInputSpace({ ...edge, x: 1_000 }, 1.25)).toEqual({ type: 'mouseMove', x: 1_250, y: 13 })
    expect(webviewAcceptsPoint({ x: 2_147_483_646, y: 10 }, 1.25)).toBe(false)
    expect(webviewAcceptsPoint({ x: 2_147_483_646, y: 10 }, 0.5)).toBe(true)
  })

  it('leaves events untouched at 100 %, with an unknown zoom, and for keys', () => {
    const move = { type: 'mouseMove', x: 500, y: 382 } as const
    const key = { keyCode: 'Enter', type: 'keyDown' } as const

    expect(toWebviewInputSpace(move, 1)).toBe(move)
    expect(toWebviewInputSpace(move, undefined)).toBe(move)
    expect(toWebviewInputSpace(move, Number.NaN)).toBe(move)
    expect(toWebviewInputSpace(key, 0.9)).toBe(key)
  })
})
