# Token optimization tool bench: measures real compression saving and critical-evidence fidelity.
# Usage: python run_bench.py
import os, re, subprocess, sys, time, shutil
from pathlib import Path

BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parent
RTK = ROOT / "rtk.exe"
CC_CLI = ROOT / "context-compress-main" / "dist" / "cli" / "index.js"
FIND_BIN = "C:/Program Files/Git/usr/bin/find.exe"
FX = BENCH / "fixtures"
REPO = BENCH / "repo"
REPORT = BENCH / "report.md"
ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")


def clean(b: bytes) -> str:
    return ANSI.sub("", b.decode("utf-8", "replace")).replace("\r\n", "\n").replace("\r", "\n")


def run(cmd, stdin=None, cwd=None, timeout=120):
    t0 = time.time()
    p = subprocess.run(cmd, input=stdin, capture_output=True, cwd=cwd, timeout=timeout,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    dt = time.time() - t0
    return clean(p.stdout), clean(p.stderr), p.returncode, dt


def est_tokens(s: str) -> int:
    return len(s) // 4


def cc_filter(text, mode):
    out, err, rc, dt = run(["node", str(CC_CLI), "filter", "--mode", mode],
                           stdin=text.encode("utf-8"), timeout=120)
    return out, rc, dt


def cc_wrap(cmdline, mode, cwd):
    out, err, rc, dt = run(["node", str(CC_CLI), "wrap", "--mode", mode, cmdline], cwd=cwd)
    return out, rc, dt


# ---------- fixtures ----------

def gen_repo():
    global REPO
    REPO = BENCH / f"repo_{int(time.time())}"
    if REPO.exists():
        try:
            shutil.rmtree(REPO)
        except Exception:
            pass
    (REPO / "src").mkdir(parents=True)
    for i in range(120):
        mod = REPO / "src" / f"mod{i % 6}"
        mod.mkdir(exist_ok=True)
        body = "\n".join(f"def func_{i}_{j}(x):\n    return x + {j}  # impl {i}.{j}"
                         for j in range(8))
        (mod / f"file_{i}.py").write_text(body + "\n")
    env = os.environ.copy()
    env.update({"GIT_AUTHOR_NAME": "bench", "GIT_AUTHOR_EMAIL": "b@b",
                "GIT_COMMITTER_NAME": "bench", "GIT_COMMITTER_EMAIL": "b@b"})
    def git(*a):
        subprocess.run(["git", *a], cwd=REPO, env=env, capture_output=True)
    git("init", "-q")
    git("add", "-A")
    git("commit", "-q", "-m", "initial")
    for i in range(5):
        (REPO / "src" / f"mod{i}" / f"file_{i}.py").write_text("# modified\n", encoding="utf-8")
    for i in range(8):
        (REPO / f"untracked_{i}.tmp").write_text("x" * 200)
    git("add", "src/mod0/file_0.py")
    git("commit", "-q", "-m", "second commit")
    git("tag", "v0.1")
    for i in range(40):
        p = REPO / "src" / "mod0" / f"filler_{i}.py"
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(f"# filler {i}\n")
        git("commit", "--allow-empty", "-q", "-m", f"chore: iteration {i} on feature branch {i % 3}")


def gen_fixtures():
    FX.mkdir(exist_ok=True)
    lines = ["[INFO] Scanning for projects..."]
    for i in range(300):
        lines.append(f"[INFO] Downloading from central: https://repo.maven.apache.org/dependency-{i}.jar ({i * 13} kB)")
        lines.append(f"[INFO] Downloaded from central: https://repo.maven.apache.org/dependency-{i}.jar ({i * 13} kB) at {i * 7} kB/s")
    lines += ["[INFO] Compiling 247 source files to /target/classes",
              "[INFO] -------------------------------------------------------------",
              "[INFO] BUILD SUCCESS",
              "[INFO] Total time:  42.817 s",
              "[INFO] Finished at: 2026-08-29T18:00:00+08:00"]
    (FX / "build_success.log").write_text("\n".join(lines) + "\n")

    py = [f"============================= test session starts ==============================",
          "platform win32 -- Python 3.14.6, pytest-8.4.1",
          "collected 128 items", ""]
    for i in range(120):
        py.append(f"tests/test_module_{i}.py::test_case_{i} PASSED                            [ {i}%]")
    py += ["tests/test_order_service.py::test_discount_rule FAILED                      [ 95%]",
           "",
           "=================================== FAILURES ===================================",
           "___________________________ test_discount_rule ________________________________",
           "",
           "    def test_discount_rule():",
           ">       assert calc_discount(vip=True, amount=200) == 30",
           "E       AssertionError: assert 20 == 30",
           "E        +  where 20 = calc_discount(amount=200, vip=True)",
           "",
           "tests/test_order_service.py:42: AssertionError",
           "=========================== short test summary info ============================",
           "FAILED tests/test_order_service.py::test_discount_rule - AssertionError: assert 20 == 30",
           "========================= 1 failed, 127 passed in 3.42s ========================="]
    (FX / "pytest_fail.log").write_text("\n".join(py) + "\n")

    java = ["Exception in thread \"main\" java.lang.NullPointerException: Cannot invoke method on null order",
            "\tat com.shop.order.OrderServiceImpl.applyDiscount(OrderServiceImpl.java:142)",
            "\tat com.shop.order.OrderController.checkout(OrderController.java:87)",
            "\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)",
            "\tat java.base/java.lang.reflect.Method.invoke(Method.java:580)"]
    java += [f"\tat org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:{200 + i})" for i in range(18)]
    java += ["\tat org.apache.tomcat.util.threads.TaskThread$WrappingRunnable.run(TaskThread.java:61)",
             "\tat java.base/java.lang.Thread.run(Thread.java:1583)"]
    (FX / "java_stacktrace.log").write_text("\n".join(java) + "\n")

    big = []
    for i in range(3000):
        lvl = "WARN" if i % 50 == 0 else ("ERROR" if i == 2747 else "INFO")
        msg = "Connection pool near capacity, retry backoff 200ms" if lvl == "WARN" else (
            "Failed to flush batch to storage: timeout after 30000ms" if lvl == "ERROR"
            else f"Processed request id=req-{i:06d} path=/api/v1/items status=200 latency={i % 90}ms")
        big.append(f"2026-08-29T18:{i // 60 % 60:02d}:{i % 60:02d}.{i % 1000:03d} [{lvl}] app-server-{i % 4} {msg}")
    (FX / "big_log.log").write_text("\n".join(big) + "\n")


# ---------- cases ----------

def cases():
    F = str(FX).replace("\\", "/")
    R = str(REPO).replace("\\", "/")
    return [
        ("git_status", ["git", "status"], [str(RTK), "git", "status"], "cmd", REPO,
         ["modified:", "untracked_7.tmp"]),
        ("git_log_40", ["git", "log", "--oneline", "-40"], [str(RTK), "git", "log", "--oneline", "-40"], "cmd", REPO,
         ["iteration 37", "second commit"]),
        ("grep_hit", ["grep", "-rn", "func_6_4", f"{R}/src"], [str(RTK), "grep", "-rn", "func_6_4", f"{R}/src"], "cmd", BENCH,
         ["func_6_4"]),
        ("build_success_log", ["cat", f"{F}/build_success.log"], [str(RTK), "log", f"{F}/build_success.log"], "cmd", BENCH,
         ["BUILD SUCCESS", "Total time:  42.817 s"]),
        ("pytest_fail_log", ["cat", f"{F}/pytest_fail.log"], [str(RTK), "log", f"{F}/pytest_fail.log"], "cmd", BENCH,
         ["AssertionError: assert 20 == 30", "tests/test_order_service.py:42",
          "FAILED tests/test_order_service.py::test_discount_rule", "1 failed, 127 passed"]),
        ("java_stacktrace_log", ["cat", f"{F}/java_stacktrace.log"], [str(RTK), "log", f"{F}/java_stacktrace.log"], "cmd", BENCH,
         ["java.lang.NullPointerException", "OrderServiceImpl.applyDiscount(OrderServiceImpl.java:142)",
          "OrderController.checkout(OrderController.java:87)"]),
        ("big_log", ["cat", f"{F}/big_log.log"], [str(RTK), "log", f"{F}/big_log.log"], "cmd", BENCH,
         ["Failed to flush batch to storage: timeout after 30000ms", "req-002747"]),
        ("source_read", ["cat", f"{R}/src/mod4/file_10.py"], [str(RTK), "read", f"{R}/src/mod4/file_10.py"], "cmd", BENCH,
         ["func_10_7"]),
    ]


def main():
    gen_repo()
    gen_fixtures()
    results = []
    for name, raw_cmd, rtk_cmd, kind, cwd, critical in cases():
        raw_out, raw_err, rc_raw, dt_raw = run(raw_cmd, cwd=cwd)
        raw_full = raw_out + ("\n[stderr]\n" + raw_err if raw_err.strip() else "")
        raw_chars = len(raw_full)

        row = {"case": name, "raw_chars": raw_chars, "raw_tokens": est_tokens(raw_full)}
        out, err, rc, dt = run(rtk_cmd, cwd=cwd)
        row["rtk_chars"] = len(out)
        row["rtk_save"] = 1 - len(out) / raw_chars if raw_chars else 0
        row["rtk_lost"] = [c for c in critical if c not in out]

        for mode in ("balanced", "aggressive"):
            if raw_cmd[:1] == ["cat"]:
                src = Path(raw_cmd[1]).read_text(encoding="utf-8", errors="replace")
                cout, crc, cdt = cc_filter(src, mode)
            else:
                cout, crc, cdt = cc_wrap(" ".join(raw_cmd), mode, cwd)
            row[f"cc_{mode}_chars"] = len(cout)
            row[f"cc_{mode}_save"] = 1 - len(cout) / raw_chars if raw_chars else 0
            row[f"cc_{mode}_lost"] = [c for c in critical if c not in cout]
        results.append(row)
        print(f"[done] {name}: raw={raw_chars}ch rtk={row['rtk_chars']}ch "
              f"cc_b={row['cc_balanced_chars']}ch cc_a={row['cc_aggressive_chars']}ch", flush=True)

    lines = ["# Token Tool Bench — measured results", "",
             f"date: {time.strftime('%Y-%m-%d %H:%M')}", "",
             "| case | raw tok | RTK tok | RTK save | RTK lost | CC balanced tok | save | lost | CC aggressive tok | save | lost |",
             "|---|---:|---:|---:|---|---:|---:|---|---:|---:|---|"]
    tot = {"raw": 0, "rtk": 0, "b": 0, "a": 0}
    for r in results:
        tot["raw"] += r["raw_chars"]; tot["rtk"] += r["rtk_chars"]
        tot["b"] += r["cc_balanced_chars"]; tot["a"] += r["cc_aggressive_chars"]
        lines.append(f"| {r['case']} | {r['raw_tokens']} | {r['rtk_chars'] // 4} | {r['rtk_save']:.0%} | "
                     f"{'OK' if not r['rtk_lost'] else 'LOST: ' + '; '.join(r['rtk_lost'])} | "
                     f"{r['cc_balanced_chars'] // 4} | {r['cc_balanced_save']:.0%} | "
                     f"{'OK' if not r['cc_balanced_lost'] else 'LOST: ' + '; '.join(r['cc_balanced_lost'])} | "
                     f"{r['cc_aggressive_chars'] // 4} | {r['cc_aggressive_save']:.0%} | "
                     f"{'OK' if not r['cc_aggressive_lost'] else 'LOST: ' + '; '.join(r['cc_aggressive_lost'])} |")
    lines += ["", "## Weighted totals (char-based)", "",
              f"- raw total: {tot['raw']} chars (~{tot['raw'] // 4} tok)",
              f"- RTK: {tot['rtk']} chars, saving {1 - tot['rtk'] / tot['raw']:.1%}",
              f"- CC balanced: {tot['b']} chars, saving {1 - tot['b'] / tot['raw']:.1%}",
              f"- CC aggressive: {tot['a']} chars, saving {1 - tot['a'] / tot['raw']:.1%}",
              "", "token estimate = chars / 4; saving measured on cleaned (ANSI-stripped) output."]
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nreport written: {REPORT}")


if __name__ == "__main__":
    main()
