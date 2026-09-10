/** Optional Redis mirror for L0 — no hard dependency; fails open. */

export async function redisGet(_url, _key) {
	return null;
}

export async function redisSet(_url, _key, _value, _ttlSec) {
	return false;
}
