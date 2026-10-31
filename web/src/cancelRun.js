// Cancel and start afresh on the Record screen. A "run" is one thing in flight
// (a recording being turned into WAV, then the request). Cancelling aborts its
// request, and anything that arrives late is ignored because the run is no
// longer current. Plain JavaScript so the web tests can use it under node.
export const CANCELLED_MESSAGE = "Cancelled";
export const CANCELLED_MS = 2000;

// What a mic tap does, given the screen's state: while processing it cancels
// and records at once; otherwise it starts or stops as usual.
export function micAction({ busy, recording, sheetOpen, canRecord }) {
  if (busy) return canRecord ? ["cancel", "start"] : ["cancel"];
  if (sheetOpen || !canRecord) return [];
  return [recording ? "stop" : "start"];
}

export function createRunTracker() {
  let active = null;
  return {
    // Starts a run; any run still in flight is cancelled first.
    begin() {
      active?.controller.abort();
      const controller = new AbortController();
      const run = { signal: controller.signal, controller, isCurrent: () => active === run };
      active = run;
      return run;
    },
    // Aborts the run in flight. True when there was one.
    cancel() {
      const run = active;
      if (!run) return false;
      active = null;
      run.controller.abort();
      return true;
    },
    // A run that finished normally lets go of its place.
    end(run) {
      if (active === run) active = null;
    },
    get busy() {
      return active !== null;
    },
  };
}

// The Home quick action's spoken label: "Check, 2 need attention".
export const checkLabel = (count) => (count > 0 ? `Check, ${count} ${count === 1 ? "needs" : "need"} attention` : "Check");
