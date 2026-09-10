const { getRedisConnection } = require("../config/redis");

async function getJson(key) {
  const redis = getRedisConnection();
  if (!redis) return null;
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    console.warn(`[redisCache] get failed for ${key}:`, err.message);
    return null;
  }
}

async function setJson(key, value, ttlSeconds) {
  const redis = getRedisConnection();
  if (!redis) return false;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    return true;
  } catch (err) {
    console.warn(`[redisCache] set failed for ${key}:`, err.message);
    return false;
  }
}

async function deleteKey(key) {
  const redis = getRedisConnection();
  if (!redis) return false;
  try {
    await redis.del(key);
    return true;
  } catch (err) {
    console.warn(`[redisCache] delete failed for ${key}:`, err.message);
    return false;
  }
}

async function incrementVersion(key) {
  const redis = getRedisConnection();
  if (!redis) return null;
  try {
    return await redis.incr(key);
  } catch (err) {
    console.warn(`[redisCache] version increment failed for ${key}:`, err.message);
    return null;
  }
}

async function getVersion(key) {
  const value = await getJson(key);
  return Number(value) || 0;
}

async function invalidatePublicJobCache(jobId) {
  await deleteKey("public-jobs:list");
  if (jobId) await deleteKey(`public-jobs:detail:${String(jobId)}`);
}

module.exports = { getJson, setJson, deleteKey, incrementVersion, getVersion, invalidatePublicJobCache };
