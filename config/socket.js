const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { getRedisPubSub } = require("./redis");
const { parseOrigins } = require("../utils/corsOrigins");

let io = null;

function companyRoom(companyId) {
  return `company:${String(companyId)}`;
}

function candidateRoom(userId) {
  return `candidate:${String(userId)}`;
}

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: parseOrigins(process.env.CLIENT_ORIGIN_ADMIN, process.env.CLIENT_ORIGIN_USER),
      credentials: true,
    },
  });

  // Multi-instance real-time: without the Redis adapter, an event emitted on instance
  // B never reaches a socket held on instance A (rooms are per-process). With Redis,
  // emits fan out across all instances. Single-instance dev runs fine without it.
  const pubSub = getRedisPubSub();
  if (pubSub) {
    io.adapter(createAdapter(pubSub.pub, pubSub.sub));
    console.log("[socket] Redis adapter enabled (multi-instance real-time)");
  } else {
    console.warn("[socket] REDIS_URL not set — real-time events only work with a single backend instance");
  }

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication required"));

      const payload = jwt.verify(token, process.env.AUTH_JWT_SECRET);
      const user = await User.findById(payload.userId);
      if (!user) return next(new Error("Account not found"));

      socket.user = user;
      next();
    } catch {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    const { user } = socket;
    if (user.role === "admin" && user.company) {
      socket.join(companyRoom(user.company));
    } else if (user.role === "candidate") {
      socket.join(candidateRoom(user._id));
    }
  });

  console.log("[socket] Socket.io server initialized");
  return io;
}

function getIO() {
  return io;
}

function emitToCompany(companyId, event, payload) {
  if (!io || !companyId) return;
  io.to(companyRoom(companyId)).emit(event, payload);
}

function emitToCandidateUser(userId, event, payload) {
  if (!io || !userId) return;
  io.to(candidateRoom(userId)).emit(event, payload);
}

module.exports = { initSocket, getIO, emitToCompany, emitToCandidateUser };
