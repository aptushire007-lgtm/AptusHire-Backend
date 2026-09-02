// Express 4 does not forward a rejected promise from an async route handler to next(err).
// The rejection escapes to process.on("unhandledRejection"), which logs and returns — so the
// HTTP request is NEVER answered and the client hangs until httpServer.requestTimeout (30s)
// kills the socket. The global error handler in server.js is unreachable from those paths.
//
// `asyncHandler` fixes this one handler at a time, but it only helps where someone remembered
// to apply it (historically: 1 router out of 16). This wraps every handler already registered
// on a router in one call, so:
//   - existing routes are fixed without touching ~70 call sites, and
//   - a route added later is covered automatically instead of depending on memory.
//
// Call it ONCE at the bottom of a router file, after every route is registered:
//     module.exports = wrapRouter(router);
//
// Idempotent (safe on routers already using asyncHandler explicitly) and arity-aware
// (leaves 4-arg error-handling middleware alone).

const WRAPPED = Symbol("asyncWrapped");

function wrapHandler(fn) {
  // Error-handling middleware is identified by arity 4; wrapping it would change its
  // signature to 3 and Express would stop routing errors to it.
  if (typeof fn !== "function" || fn.length >= 4 || fn[WRAPPED]) return fn;

  const wrapped = function (req, res, next) {
    // Guard against next() being called twice — once by the handler itself and again by our
    // .catch — which would otherwise produce a double response ("headers already sent").
    let settled = false;
    const once = (err) => {
      if (settled) return;
      settled = true;
      next(err);
    };
    try {
      return Promise.resolve(fn.call(this, req, res, once)).catch(once);
    } catch (err) {
      // A synchronous throw before the promise is even created.
      once(err);
      return undefined;
    }
  };

  wrapped[WRAPPED] = true;
  // Preserve the original name so stack traces and route introspection stay readable.
  Object.defineProperty(wrapped, "name", { value: fn.name || "anonymous", configurable: true });
  return wrapped;
}

function wrapRouter(router) {
  if (!router || !Array.isArray(router.stack)) {
    throw new TypeError("wrapRouter expects an Express router");
  }
  for (const layer of router.stack) {
    // Route layers (router.get/post/...) hold their handler chain in layer.route.stack.
    if (layer.route && Array.isArray(layer.route.stack)) {
      for (const sub of layer.route.stack) {
        sub.handle = wrapHandler(sub.handle);
      }
    }
    // Router-level middleware (router.use(...)) sits directly on the layer.
    else if (typeof layer.handle === "function") {
      layer.handle = wrapHandler(layer.handle);
    }
  }
  return router;
}

module.exports = wrapRouter;
module.exports.wrapHandler = wrapHandler;
