# Live A/B on shejiuPro: raw vs RTK vs context-compress. Numbers only.
import os, subprocess, sys, time
from pathlib import Path

BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parent
SHEJIU = Path(r"E:\workA\shejiuPro")
RTK = str(ROOT / "rtk.exe")
CC_CLI = ROOT / "context-compress-main" / "dist" / "cli" / "index.js"
STT_SRC = ROOT / "Save-The-Token-main" / "src"
JAVA = SHEJIU / "shejiu-modules" / "shejiu-product" / "src" / "main" / "java" / "com" / "shejiu" / "product" / "service" / "impl" / "TRedPacketTaskServiceImpl.java"
RULES = SHEJIU / ".cursor" / "rules"
OUT = BENCH / "shejiu_live_report.md"
ANSI = __import__("re").compile(r"\x1b\[[0-9;]*[a-zA-Z]")


def clean(b: bytes) -> str:
    return ANSI.sub("", b.decode("utf-8", "replace")).replace("\r\n", "\n")


def run(cmd, cwd=None, stdin=None, timeout=180, env=None):
    t0 = time.time()
    p = subprocess.run(
        cmd,
        input=stdin,
        capture_output=True,
        cwd=cwd,
        timeout=timeout,
        env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return clean(p.stdout), clean(p.stderr), p.returncode, time.time() - t0


def tok(s: str) -> int:
    return len(s) // 4


def cc_filter(text: str, mode: str) -> str:
    out, _, _, _ = run(["node", str(CC_CLI), "filter", "--mode", mode], stdin=text.encode("utf-8"))
    return out


def pct(raw: int, new: int) -> float:
    if raw <= 0:
        return 0.0
    return (1 - new / raw) * 100


rows = []


def add(name, raw, rtk_s, cc_s, note=""):
    rows.append((name, tok(raw), tok(rtk_s), tok(cc_s), note))


print("capturing shejiuPro outputs...", flush=True)

st, _, _, _ = run(["git", "status"], cwd=SHEJIU)
st_rtk, _, _, _ = run([RTK, "git", "status"], cwd=SHEJIU)
add("git_status", st, st_rtk, cc_filter(st, "balanced"))

lg, _, _, _ = run(["git", "log", "--oneline", "-40"], cwd=SHEJIU)
lg_rtk, _, _, _ = run([RTK, "git", "log", "--oneline", "-40"], cwd=SHEJIU)
add("git_log_40", lg, lg_rtk, cc_filter(lg, "balanced"))

ds, _, _, _ = run(["git", "diff", "--stat"], cwd=SHEJIU)
ds_rtk, _, _, _ = run([RTK, "git", "diff", "--stat"], cwd=SHEJIU)
add("git_diff_stat", ds, ds_rtk, cc_filter(ds, "balanced"))

df, _, _, _ = run(["git", "diff"], cwd=SHEJIU)
df_rtk, _, _, _ = run([RTK, "git", "diff"], cwd=SHEJIU)
add("git_diff", df, df_rtk, cc_filter(df, "balanced"), f"raw_chars={len(df)}")

ls, _, _, _ = run(
    ["cmd", "/c", "dir", "/s", "/b", r"shejiu-modules\shejiu-product\src\main\java"],
    cwd=SHEJIU,
)
ls_rtk, _, _, _ = run([RTK, "ls", r"shejiu-modules\shejiu-product\src\main\java"], cwd=SHEJIU)
add("java_tree_product", ls, ls_rtk, cc_filter(ls, "balanced"))

src = JAVA.read_text(encoding="utf-8", errors="replace") if JAVA.exists() else ""
src_rtk, _, _, _ = run([RTK, "read", str(JAVA)]) if JAVA.exists() else ("", "", 0, 0)
add("java_serviceimpl", src, src_rtk, cc_filter(src, "balanced"), f"lines={src.count(chr(10))}")

# typical maven success noise (fixture-like, not a live compile)
mvn = "\n".join(
    [f"[INFO] Downloading from central: https://repo.maven.apache.org/maven2/org/example/lib/{i}/lib-{i}.jar" for i in range(80)]
    + ["[INFO] BUILD SUCCESS", "[INFO] Total time:  42.817 s", "[INFO] Finished at: 2026-08-30T14:00:00"]
)
mvn_rtk, _, _, _ = run([RTK, "log"], stdin=mvn.encode())
add("mvn_success_noise", mvn, mvn_rtk, cc_filter(mvn, "balanced"))

# alwaysApply rules dump (what Cursor injects if agent Read them)
rule_blob = ""
if RULES.exists():
    for p in sorted(RULES.glob("*.mdc")):
        rule_blob += f"\n===== {p.name} =====\n" + p.read_text(encoding="utf-8", errors="replace")
rules_rtk, _, _, _ = run([RTK, "log"], stdin=rule_blob.encode())
add("cursor_rules_all", rule_blob, rules_rtk, cc_filter(rule_blob, "balanced"))

env = {**os.environ, "PYTHONPATH": str(STT_SRC)}
stt_out, stt_err, stt_rc, _ = run(
    [
        sys.executable,
        "-m",
        "save_the_token.cli",
        "eval",
        "--root",
        str(SHEJIU),
        "--task",
        "fix NullPointerException in TRedPacketTaskServiceImpl red packet create",
        "--fallback-instruction",
        "AGENTS.md",
        "--include-guidance",
    ],
    env=env,
    timeout=120,
)

lines = [
    "# shejiuPro live Token-Mind bench",
    "",
    f"date: {time.strftime('%Y-%m-%d %H:%M')}",
    "token estimate = chars/4; content omitted on purpose.",
    "",
    "| case | raw tok | RTK tok | RTK save | CC bal tok | CC save | note |",
    "|---|---:|---:|---:|---:|---:|---|",
]
tr = tt = tc = 0
for name, raw_t, rtk_t, cc_t, note in rows:
    tr += raw_t
    tt += rtk_t
    tc += cc_t
    lines.append(
        f"| {name} | {raw_t} | {rtk_t} | {pct(raw_t, rtk_t):.0f}% | {cc_t} | {pct(raw_t, cc_t):.0f}% | {note} |"
    )
lines += [
    "",
    f"**合计** raw={tr}  RTK={tt} ({pct(tr, tt):.1f}% save)  CC balanced={tc} ({pct(tr, tc):.1f}% save)",
    "",
    "## Save-The-Token eval (instruction layer)",
    "",
    f"exit={stt_rc}",
    "```",
    (stt_out or stt_err)[:4000],
    "```",
    "",
]
OUT.write_text("\n".join(lines), encoding="utf-8")
print("\n".join(lines[: 12 + len(rows) + 4]))
print("wrote", OUT)
