/** Inlined to "1" in customer release builds. */
export function isRelease() {
  return process.env.TS_RELEASE_MODE === "1";
}
