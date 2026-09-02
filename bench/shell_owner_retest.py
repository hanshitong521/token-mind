# Q3 retest (2026-09-01): corrected shell first-layer A/B.
# Fixes vs bench/shejiu_live_bench.py:
#   1. CC fed with --cmd (command-aware filters were skipped: bare `filter` = ANSI strip only).
#   2. Non-shell-owner cases excluded (ServiceImpl source = Read Guard domain;
#      dir /s /b listing = Read/Glob domain, and RTK ls on Windows errored to 0 tok).
#   3. Adds failure-path cases (pytest fail, java stacktrace) per spec P12.
# Numbers only; token = chars/4 (same estimator as all prior Token-Mind benches).
import subprocess, sys, pathlib, time

ROOT = pathlib.Path(__file__).resolve().parents[1]
CC = ROOT / "context-compress-main" / "dist" / "cli" / "index.js"
RTK = str(ROOT / "rtk.exe")
FX = ROOT / "bench" / "fixtures"
SHEJIU = pathlib.Path(r"E:\workA\shejiuPro")
OUT = ROOT / "bench" / "shell_owner_retest.md"
CREATE_NO_WINDOW = 0x08000000


def run(cmd, stdin=None, cwd=None):
    p = subprocess.run(cmd, input=stdin, capture_output=True, cwd=cwd,
                       creationflags=CREATE_NO_WINDOW, timeout=120)
    return p.stdout.decode("utf-8", "replace")


def tok(s):
    return len(s) // 4


def cc(text, cmd):
    return run(["node", str(CC), "filter", "--cmd", cmd, "--mode", "balanced"],
               stdin=text.encode("utf-8"))


st = run(["git", "status"], cwd=SHEJIU)
lg = run(["git", "log", "--oneline", "-40"], cwd=SHEJIU)
diff = run(["git", "diff", "--no-index", "--",
            str(FX / "build_success.log"), str(FX / "big_log.log")])
pytest_fail = (FX / "pytest_fail.log").read_text(encoding="utf-8", errors="replace")
stack = (FX / "java_stacktrace.log").read_text(encoding="utf-8", errors="replace")
mvn = "\n".join(
    [f"[INFO] Downloading from central: https://repo.maven.apache.org/maven2/org/example/lib/{i}/lib-{i}.jar" for i in range(80)]
    + ["[INFO] BUILD SUCCESS", "[INFO] Total time:  42.817 s"])

# (name, raw, cmd, rtk argv or None for stdin-log)
CASES = [
    ("git_status", st, "git status", ["git", "status"]),
    ("git_log_40", lg, "git log --oneline -40", ["git", "log", "--oneline", "-40"]),
    ("git_diff_large", diff, "git diff", ["git", "diff", "--no-index", "--",
                                          str(FX / "build_success.log"), str(FX / "big_log.log")]),
    ("mvn_success_noise", mvn, "mvn clean package", None),
    ("pytest_fail", pytest_fail, "pytest -q", ["test", "pytest"]),
    ("java_stacktrace", stack, "mvn test", None),
]

rows = []
tot = [0, 0, 0]
fidelity_notes = []
for name, raw, cmd, rtk_argv in CASES:
    b = raw.encode("utf-8")
    cc_out = cc(raw, cmd)
    if rtk_argv:
        rtk_out = run([RTK] + rtk_argv, cwd=SHEJIU)
    else:
        rtk_out = run([RTK, "log"], stdin=b) if name == "mvn_success_noise" else run([RTK, "err", "cat"], stdin=b)
    rows.append((name, tok(raw), tok(cc_out), tok(rtk_out)))
    tot[0] += tok(raw); tot[1] += tok(cc_out); tot[2] += tok(rtk_out)

# failure-path fidelity: key evidence must survive CC balanced (spec P5/P12)
def keep_all(hay, *needles):
    return all(n.lower() in hay.lower() for n in needles)

pf_cc = cc(pytest_fail, "pytest -q")
st_cc = cc(stack, "mvn test")
fidelity_notes.append(("pytest_fail preserved assertion+test name",
                       keep_all(pf_cc, "assert", "test_")))
fidelity_notes.append(("java_stacktrace preserved exception+frame",
                       keep_all(st_cc, "exception", ".java") or keep_all(st_cc, "at ", "exception")))

pct = lambda new, old: f"{(1 - new / old) * 100:.0f}%" if old else "n/a"
lines = [
    "# Shell first-layer corrected A/B (Q3 retest)",
    "",
    f"date: {time.strftime('%Y-%m-%d %H:%M')}  |  token = chars/4  |  CC = balanced + --cmd  |  RTK 0.46",
    "excludes non-shell-owner cases (ServiceImpl source, dir listing) — see DECISIONS-2026-09-01 3C.",
    "",
    "| case | raw tok | CC tok | CC save | RTK tok | RTK save |",
    "|---|---:|---:|---:|---:|---:|",
]
for name, r, c, k in rows:
    lines.append(f"| {name} | {r} | {c} | {pct(c, r)} | {k} | {pct(k, r)} |")
lines += [
    "",
    f"**TOTAL** raw={tot[0]}  CC={tot[1]} ({pct(tot[1], tot[0])})  RTK={tot[2]} ({pct(tot[2], tot[0])})",
    "",
    "## failure-path fidelity (CC balanced, spec P5/P12)",
    "",
]
for label, ok in fidelity_notes:
    lines.append(f"- {'PASS' if ok else 'FAIL'}: {label}")
lines.append("")
OUT.write_text("\n".join(lines), encoding="utf-8")
print("\n".join(lines))
