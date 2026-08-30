/**

 * Shared judge for Session Replay / Query Bank eval.

 */

export function judgeSearchHit(sc, hits, registryResolver = null) {

  const deprecated = [];

  const expectedKeys =

    sc.expected?.canonical_keys ||

    sc.expected_canonical_keys ||

    null;

  const matchMode = sc.expected?.match || sc.match || "top1";

  const k = sc.expected?.k ?? sc.k ?? 3;



  if (expectedKeys?.length && registryResolver?.canonicalKeyFromHitPath) {

    const slice = hits?.slice(0, matchMode === "top1" ? 1 : k) || [];

    const keys = slice.map((h) =>

      registryResolver.canonicalKeyFromHitPath(h?.p ?? h?.path ?? ""),

    );

    let hitOk = false;

    if (matchMode === "top1") {

      hitOk = keys[0] && expectedKeys.includes(keys[0]);

    } else {

      hitOk = keys.some((key) => key && expectedKeys.includes(key));

    }

    if (sc.expectSub || sc.expect_top3) deprecated.push("DEPRECATED_JUDGE_PATH_PRESENT");

    return {

      hitOk,

      judgeMode: hitOk ? `canonical_${matchMode}` : null,

      topPath: hits?.[0]?.p ?? hits?.[0]?.path ?? "",

      deprecated,

    };

  }



  const top = hits?.[0];

  const topPath = top?.p ?? top?.path ?? "";

  let hitOk = sc.expectSub

    ? topPath.toLowerCase().includes(sc.expectSub.toLowerCase())

    : !!topPath;

  let judgeMode = hitOk ? "expectSub_top1" : null;

  if (!hitOk && sc.expect_top3 && hits) {

    const top3Paths = hits.slice(0, 3).map((h) => (h?.p ?? h?.path ?? "").toLowerCase());

    hitOk = sc.expect_top3.some((sub) =>

      top3Paths.some((p) => p.includes(sub.toLowerCase())),

    );

    if (hitOk) judgeMode = "expect_top3";

  }

  if (!sc.expectSub && !sc.expect_top3) {

    hitOk = !!topPath;

    judgeMode = hitOk ? "any_top1" : null;

  }

  if (!expectedKeys?.length) deprecated.push("DEPRECATED_JUDGE_PATH");

  return { hitOk, judgeMode, topPath, deprecated };

}



export const basename = (p) => (p || "").replace(/\\/g, "/").split("/").pop() || "";



export const estDeliveryTok = (hits) => {

  const body = (hits || []).map((h) => h?.p || h?.path || "").join("\n");

  return Math.round((body.length || 0) / 4);

};


