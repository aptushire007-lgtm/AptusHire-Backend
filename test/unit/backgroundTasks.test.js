// Detached work must survive a shutdown, or be named when it can't.
//
// Apply answers 201 and screens afterwards; rescore answers 202; an interview finalises
// after the candidate's last answer. Before the registry these were bare setImmediate
// calls that shutdown() could not see, so a deploy or a free-tier spin-down killed them
// mid-write — and silently, because the alert path inside each task needs the same Mongo
// connection that was just torn down.
//
// The gates below are the two halves of the guarantee: work that CAN finish in the budget
// is waited for, and work that cannot is reported by name rather than vanishing.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const bg = require("../../utils/backgroundTasks");

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => bg._resetForTests());

test("a task scheduled after the response is visible to shutdown", async () => {
  let ran = false;
  bg.runInBackground("screen candidate 1", async () => {
    await tick(20);
    ran = true;
  });

  // Registered synchronously — the whole point is that shutdown can never observe a
  // window where the work exists but the registry is empty.
  assert.equal(bg.pendingCount(), 1);
  assert.deepEqual(bg.pendingLabels(), ["screen candidate 1"]);
  assert.equal(ran, false, "work is deferred past the response, not run inline");

  const { drained, abandoned } = await bg.drain(1000);
  assert.equal(ran, true);
  assert.equal(drained, true);
  assert.deepEqual(abandoned, []);
  assert.equal(bg.pendingCount(), 0);
});

test("ACCEPTANCE GATE: drain waits for in-flight work instead of returning immediately", async () => {
  const order = [];
  bg.runInBackground("screen candidate 2", async () => {
    await tick(60);
    order.push("task finished");
  });

  await bg.drain(1000);
  order.push("drain returned");

  // The bug this replaces: httpServer.close() resolves instantly because the request
  // already finished, so Mongo was disconnected while the screen was still writing.
  assert.deepEqual(order, ["task finished", "drain returned"]);
});

test("work that outlasts the budget is ABANDONED BY NAME, never silently", async () => {
  bg.runInBackground("screen candidate 42", () => tick(5000));
  bg.runInBackground("finalize interview 77", () => tick(5000));

  const { drained, abandoned } = await bg.drain(30);

  // A live-mode screen is several LLM calls and can outlast any budget a SIGTERM
  // allows. That work IS lost — so the labels must carry the record ids, because the
  // recovery is a human re-running Rescore on exactly these.
  assert.equal(drained, false);
  assert.equal(abandoned.length, 2);
  assert.ok(abandoned.some((l) => l.includes("42")), "the candidate id must reach the log line");
  assert.ok(abandoned.some((l) => l.includes("77")));
});

test("a throwing task still releases the drain — one failure cannot hang a shutdown", async () => {
  bg.runInBackground("screen candidate 3", async () => {
    throw new Error("evidence engine exploded");
  });

  const { drained, abandoned } = await bg.drain(1000);
  assert.equal(drained, true, "a rejected task must settle the registry, not leak a slot");
  assert.deepEqual(abandoned, []);
});

test("a background rejection is contained — it must not reach unhandledRejection", async () => {
  // server.js exits the process on unhandledRejection in production. A failing screen
  // for ONE candidate taking down every live interview session is the disaster this
  // catch exists to prevent.
  let unhandled = null;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    bg.runInBackground("screen candidate 4", () => Promise.reject(new Error("boom")));
    await bg.drain(1000);
    await tick(20); // give the rejection a turn to surface if it were going to
    assert.equal(unhandled, null);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("drain on an idle process is a no-op, not a wasted budget", async () => {
  const started = Date.now();
  const { drained, abandoned } = await bg.drain(5000);
  assert.equal(drained, true);
  assert.deepEqual(abandoned, []);
  assert.ok(Date.now() - started < 100, "an empty registry must return at once, not sit out the timeout");
});

test("concurrent tasks sharing a label are counted individually", async () => {
  bg.runInBackground("screen candidate 9", () => tick(10));
  bg.runInBackground("screen candidate 9", () => tick(10));
  assert.equal(bg.pendingCount(), 2);
  assert.deepEqual(bg.pendingLabels(), ["screen candidate 9", "screen candidate 9"]);
  await bg.drain(1000);
  assert.equal(bg.pendingCount(), 0);
});
