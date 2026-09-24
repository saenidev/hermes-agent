import type { PreviewScriptRunner } from './preview-script-runner'

// Stable import: preview-act itself is cache-busted per dev request. The real
// pointer is renderer-global, and inventories/annotations also change the holder.
let busy = false

export function beginPreviewAction() {
  if (busy) {
    return null
  }

  busy = true
  let finished = false
  let pending = 0

  const release = () => {
    if (finished && pending === 0) {
      busy = false
    }
  }

  return {
    finish() {
      finished = true
      release()
    },
    track(run: PreviewScriptRunner): PreviewScriptRunner {
      return code => {
        const work = run(code)
        pending++

        // A host timeout does not cancel guest JS. Keep excluding new work until
        // the underlying call settles, even after its caller has returned.
        return work.finally(() => {
          pending--
          release()
        })
      }
    }
  }
}
