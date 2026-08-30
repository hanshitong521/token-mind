# Self-bench: replay this session's real tool outputs through RTK/CC, measure what
# would have entered agent context. Prints numbers only — never dumps content.
import subprocess, sys, re
from pathlib import Path

BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parent
RTK = str(ROOT / "rtk.exe")
CC = ["node", str(ROOT / "context-compress-main" / "dist" / "cli" / "index.js"), "filter", "--mode"]
PLAN = Path("C:/Users/Administrator/Downloads/Cursor Token Optimization — 完整开发、集成与验证闭环方案.md")
REPO = sorted(BENCH.glob("repo_*"))[-1]
NM = ROOT / "context-compress-main" / "node_modules"

def sz(s): return len(s)

def rtk(*args, stdin=None):
    p = subprocess.run([RTK, *args], input=stdin, capture_output=True)
    return p.stdout.decode("utf-8", "replace")

def cc(text, mode):
    p = subprocess.run(CC + [mode], input=text.encode("utf-8"), capture_output=True)
    return p.stdout.decode("utf-8", "replace")

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, cwd=BENCH)
    return p.stdout.decode("utf-8", "replace")

rows = []
def record(name, raw):
    r = rtk("log", stdin=raw.encode()) if name != "plan_doc" else rtk("read", "-l", "aggressive", str(PLAN))
    if name == "plan_doc": raw = PLAN.read_text(encoding="utf-8", errors="replace")
    b = cc(raw, "balanced"); a = cc(raw, "aggressive")
    rows.append((name, sz(raw), sz(r), sz(b), sz(a)))

# 1. the 2535-line plan doc I read in full this session
record("plan_doc", "")
# 2. big git status (120-file repo)
record("git_status_full", run(["git", "status"]) + "")
record("git_status", subprocess.run(["git", "status"], cwd=REPO, capture_output=True).stdout.decode())
# 3. git log 40 (session-real)
record("git_log_40", subprocess.run(["git", "log", "--oneline", "-40"], cwd=REPO, capture_output=True).stdout.decode())
# 4. node_modules listing (real dir dump)
record("node_modules_ls", run(["cmd", "/c", "dir", "/s", "/b", str(NM)]) if NM.exists() else "")
# 5. rtk --help dumps I ran this session
record("rtk_help", subprocess.run([RTK, "--help"], capture_output=True).stdout.decode())
# 6. save-the-token scan JSON (real, ~2KB config dump)
record("stt_scan", subprocess.run([sys.executable, "-m", "save_the_token.cli", "scan", "--root", str(ROOT)],
         capture_output=True, cwd=str(BENCH),
         env={**subprocess.os.environ, "PYTHONPATH": str(ROOT / "Save-The-Token-main" / "src")}).stdout.decode())
# 7. the full FINAL_REPORT re-read scenario
record("final_report", (BENCH / "FINAL_REPORT.md").read_text(encoding="utf-8", errors="replace"))

hdr = f"{'case':<18}{'raw tok':>9}{'rtk tok':>9}{'rtk save':>9}{'cc-bal':>8}{'save':>7}{'cc-aggr':>8}{'save':>7}"
print(hdr); print("-" * len(hdr))
tr = ta = tb = tc = 0
for name, raw, r, b, a in rows:
    tr += raw; ta += r; tb += b; tc += a
    f = lambda x: f"{x // 4:>8}" if x > 0 else f"{0:>8}"
    print(f"{name:<18}{f(raw)}{f(r)}{0 if not raw else (1 - r / raw) * 100:>8.0f}%{f(b)}"
          f"{0 if not raw else (1 - b / raw) * 100:>6.0f}%{f(a)}{0 if not raw else (1 - a / raw) * 100:>6.0f}%")
print("-" * len(hdr))
pct = lambda x: (1 - x / tr) * 100
print(f"{'TOTAL':<18}{tr // 4:>8}{ta // 4:>8}{pct(ta):>8.0f}%{tb // 4:>8}{pct(tb):>6.0f}%{tc // 4:>8}{pct(tc):>6.0f}%")
