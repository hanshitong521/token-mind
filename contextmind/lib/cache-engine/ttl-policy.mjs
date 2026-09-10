/** Wall-clock seconds for cache TTL tiers (Ultimate Cache Engine). */

export function nowSec() {
	return Math.floor(Date.now() / 1000);
}

export function tierForHits(hitCount) {
	if (hitCount >= 5) return "hot";
	if (hitCount >= 2) return "warm";
	return "temporary";
}

export function ttlSecondsForTier(tier, baseTtl = 600) {
	const base = Number(baseTtl) > 0 ? Number(baseTtl) : 600;
	if (tier === "hot") return base * 4;
	if (tier === "warm") return base * 2;
	if (tier === "candidate") return base;
	return base;
}
