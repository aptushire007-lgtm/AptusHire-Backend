// Registry for work that outlives the HTTP request that started it.
//
// Several endpoints answer immediately and finish the real work afterwards — apply
// returns 201 and screens in the background, rescore returns 202, an interview
// finalises after the candidate's last answer. Before this registry existed those
// were bare `setImmediate(...)` calls, invisible to the process: shutdown() closed
// the HTTP server (which resolves instantly, the request having already finished),
// disconnected Mongo, and exited — killing whatever was mid-flight. On Render that
// happens on every deploy and on every free-tier spin-down, and the failure is
// silent, because the alert path inside each task also needs the Mongo connection
// that was just torn down.
//
// The honest limit: a live-mode screen is several LLM calls and can run for
// minutes, while a SIGTERM gives us tens of seconds. Draining everything is not
// possible, so drain() does not pretend to. It waits out its budget, then RETURNS
// the labels of whatever is still running so the caller can log exactly which
// candidates need a re-run. Losing work silently is the thing we are fixing; losing
// it loudly, with the candidate id in the log line, is a recoverable operational
// event.

const logger = require("./logger");

// label -> count of in-flight tasks carrying that label.
const inFlight = new Map();
// task id -> a promise that settles when that task finishes (never rejects).
const pending = new Map();
let nextId = 1;

function add(label) {
  inFlight.set(label, (inFlight.get(label) || 0) + 1);
}

function remove(label) {
  const n = inFlight.get(label);
  if (n === undefined) return;
  if (n <= 1) inFlight.delete(label);
  else inFlight.set(label, n - 1);
}

/**
 * Schedule `fn` to run after the current response is flushed, tracked so shutdown
 * can wait for it.
 *
 * `label` is what an operator reads when a drain times out, so make it identify the
 * unit of work, not the function — "screen candidate 65f…" beats "runPostApply".
 *
 * Callers keep their own error handling; the catch here is a last resort that stops
 * a background rejection from reaching process.on("unhandledRejection"), which in
 * production exits the process.
 */
function runInBackground(label, fn) {
  const id = nextId++;
  const tracked = new Promise((resolve) => {
    setImmediate(() => {
      Promise.resolve()
        .then(fn)
        .catch((err) => {
          logger.error("background task failed", {
            task: label,
            err: { name: err?.name, message: err?.message, stack: err?.stack },
          });
        })
        .finally(() => {
          remove(label);
          pending.delete(id);
          resolve();
        });
    });
  });
  add(label);
  pending.set(id, tracked);
  return tracked;
}

/** Labels of everything currently in flight, one entry per task. */
function pendingLabels() {
  const out = [];
  for (const [label, n] of inFlight) for (let i = 0; i < n; i++) out.push(label);
  return out;
}

function pendingCount() {
  return pending.size;
}

/**
 * Wait up to `timeoutMs` for in-flight tasks to finish.
 *
 * Resolves { drained, abandoned } — `abandoned` is the label list of tasks still
 * running when the budget ran out. A non-empty `abandoned` is not an error the
 * process can fix; it is a list of work an operator has to re-trigger.
 */
async function drain(timeoutMs) {
  if (pending.size === 0) return { drained: true, abandoned: [] };
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  await Promise.race([Promise.all([...pending.values()]), expired]);
  clearTimeout(timer);
  const abandoned = pendingLabels();
  return { drained: abandoned.length === 0, abandoned };
}

// Tests need a clean registry between cases.
function _resetForTests() {
  inFlight.clear();
  pending.clear();
}

module.exports = { runInBackground, drain, pendingCount, pendingLabels, _resetForTests };
