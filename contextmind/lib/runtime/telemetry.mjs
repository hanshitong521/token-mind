/** Runtime-side counters. Never throw; never block the Agent. */

export function createRuntimeTelemetry() {
	const counters = {
		rpc_ok: 0,
		rpc_fail: 0,
		minimal_mode: 0,
		daemon_start: 0,
		cache_hit: 0,
		cache_lookup: 0,
	};
	const fails = [];
	return {
		inc(name, n = 1) {
			if (counters[name] == null) counters[name] = 0;
			counters[name] += n;
		},
		fail(event) {
			counters.rpc_fail += 1;
			fails.push({ ts: Date.now(), ...event });
			if (fails.length > 50) fails.shift();
		},
		snapshot() {
			return { counters: { ...counters }, recentFails: fails.slice(-10) };
		},
	};
}
