// Express 4 does not forward a rejected promise from an async route handler to next(err) —
// it becomes an unhandled promise rejection, which crashes the whole process (Node's default
// since v15). Wrap any async controller with this so its rejection reaches the global error
// handler in server.js instead.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
