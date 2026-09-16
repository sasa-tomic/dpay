#!/usr/bin/env python3
"""testruns.py — automatic test-run annotations: the durable record of WHICH suites ran,
and passed, against WHICH exact tree. Replaces the hand-bumped AGENTS.md "floor".

ONE stdlib-only file, the ONLY interface to the record — query it via `report`/`floor`,
never by opening the DB directly:

  run <suite> -- <cmd...>        run the command (or --sh '<shell>'), record pass/fail,
                                 exit with the command's own code — recording can never
                                 flip a result
  record <suite> pass|fail       record a verdict for the current tree without running
                                 anything (composite recipes like check/verify use this:
                                 it is only reached when their deps already passed)
  report [commit] [--json]       per-suite latest status at a commit (default HEAD);
                                 a missing row is "unknown", never "fail"
  timing [suite] [commit]      per-test timing breakdown (slowest first) of the latest
                               recorded run; bare `timing` lists every suite by wall time.
                               Suites feed it via $DPAY_TESTRUNS_TIMING
                               (nextest libtest-json / jest --json / e2e per-flow JSON)
  floor [--require verify]       composite prod gate: curl the live /api/v1/version,
                                 classify it vs HEAD exactly like verify-relay
                                 (DIRTY first / BEHIND-by-N / MISMATCH), then
                                 look up the evidence RECORDED AT THE LIVE COMMIT.
                                 Exit 0 iff prod runs a clean commit whose --require
                                 suite has a green record on this machine.

DB: .dev/testruns.db (gitignored, WAL). Every `runs` row pins the commit AND the hash of the
WORKING TREE (throwaway index seeded from HEAD, updated from the worktree) plus a dirty
flag — the `-dirty` lesson: suites exercise the working tree, not the commit, so a green
row taken on a dirty tree can never read as "the commit is verified". Each run also
records wall + CPU seconds (os.times, children included); when the suite writes a timing
file to $DPAY_TESTRUNS_TIMING, per-test/per-flow durations land in the `tests` table
keyed by run — where the time went, per suite, queryable via `timing`.

Unwired by design: e2e-watch / e2e-watch-filter (interactive, Ctrl-C), e2e-visual-seed
(baseline regen, not a gate), e2e-live-testnet (opt-in, special env).
"""

import argparse
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

DB_REL = os.path.join(".dev", "testruns.db")
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
DEFAULT_URL = "https://dpay.kalaj.org"


def git(*args, env=None):
    return subprocess.run(["git", *args], capture_output=True, text=True, env=env)


def repo_root():
    r = git("rev-parse", "--show-toplevel")
    return r.stdout.strip() if r.returncode == 0 else None


def db_path():
    root = repo_root()
    base = root if root else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    return os.path.join(base, DB_REL)


def connect():
    path = db_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    con = sqlite3.connect(path, timeout=10)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute(
        """CREATE TABLE IF NOT EXISTS runs(
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            rev TEXT NOT NULL,
            tree TEXT NOT NULL,
            dirty INTEGER NOT NULL,
            suite TEXT NOT NULL,
            result TEXT NOT NULL,
            host TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '')"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS tests(
            id INTEGER PRIMARY KEY,
            run_id INTEGER NOT NULL REFERENCES runs(id),
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            secs REAL NOT NULL DEFAULT 0)"""
    )
    return con


def worktree():
    """(commit, tree, dirty) — tree is the hash of the WORKING TREE via a throwaway index
    seeded from HEAD and updated from the worktree (respects .gitignore), so uncommitted
    and untracked-but-real source changes are part of the tested identity."""
    head = git("rev-parse", "HEAD")
    commit = head.stdout.strip() if head.returncode == 0 else ""
    with tempfile.NamedTemporaryFile(prefix="dpay-testruns-index-") as tf:
        env = dict(os.environ, GIT_INDEX_FILE=tf.name)
        git("read-tree", commit or EMPTY_TREE, env=env)
        git("add", "-A", env=env)
        tree = git("write-tree", env=env).stdout.strip()
    head_tree = git("rev-parse", f"{commit}^{{tree}}").stdout.strip() if commit else EMPTY_TREE
    return commit, tree, int(tree != head_tree)


def record(suite, result, extra=None):
    """Best-effort: a recording failure must never fail the run it annotates.
    Returns the inserted run id (or None) so per-test timings can attach to it."""
    try:
        commit, tree, dirty = worktree()
        detail = json.dumps(extra or {}, sort_keys=True)
        with connect() as con:
            cur = con.execute(
                "INSERT INTO runs(ts,rev,tree,dirty,suite,result,host,detail)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (int(time.time()), commit, tree, dirty, suite, result,
                 socket.gethostname()[:64], detail),
            )
            return cur.lastrowid
    except Exception as e:
        print(f"testruns: WARNING — could not record {suite}={result}: {e}", file=sys.stderr)
        return None


def resolve_commit(ref):
    if not ref:
        h = git("rev-parse", "HEAD")
        return h.stdout.strip() if h.returncode == 0 else ""
    r = git("rev-parse", "--verify", f"{ref}^{{commit}}")
    return r.stdout.strip() if r.returncode == 0 else ref


def latest_at(commit):
    """{suite: row} — the newest row per suite recorded at exactly this commit."""
    with connect() as con:
        rows = con.execute(
            """SELECT r.suite, r.result, r.ts, r.dirty, r.host, r.tree, r.detail FROM runs r
               JOIN (SELECT MAX(id) AS m FROM runs WHERE rev=? GROUP BY suite) x
                 ON r.id = x.m
               ORDER BY r.suite""",
            (commit,),
        ).fetchall()
    return {r[0]: {"suite": r[0], "result": r[1], "ts": r[2], "dirty": r[3],
                   "host": r[4], "tree": r[5], "detail": r[6]} for r in rows}


def age(ts):
    s = max(0, int(time.time()) - int(ts))
    for div, unit in ((60, "s"), (60, "m"), (24, "h")):
        if s < div:
            return f"{s}{unit}"
        s //= div
    return f"{s}d"


def commit_tree(commit):
    return git("rev-parse", f"{commit}^{{tree}}").stdout.strip() if commit else EMPTY_TREE


def evidence_ok(rows, suite, commit):
    """A suite counts as green at a commit iff its latest record is a pass taken on the
    commit's exact tree — `git commit` never changes the worktree, so a run made just
    before committing matches, while any edit after the run makes the tree hashes diverge
    and the record stale. This is what keeps a green row from reading as more than it is."""
    r = rows.get(suite)
    if not r:
        return False, "unknown"
    if r["result"] != "pass":
        return False, r["result"]
    if r["tree"] != commit_tree(commit):
        return False, "stale-tree"
    return True, "pass"


def print_evidence(commit, label):
    rows = latest_at(commit)
    print(f"== recorded evidence at {label} {commit[:12]}:")
    if not rows:
        print("   (no recorded runs at this commit — unknown is NOT green)")
        return {}
    for name in sorted(rows):
        r = rows[name]
        d = r["detail"]
        d = f"  {d}" if d and d != "{}" else ""
        print(f"   {name:<22} {r['result']:<6} {age(r['ts']):>5}"
              f"  dirty={'yes' if r['dirty'] else 'no'}  {r['host']}{d}")
    return rows


def parse_timing_file(path):
    """[(name, status, secs)] from whatever the suite left at $DPAY_TESTRUNS_TIMING —
    auto-detected among nextest libtest-json (NDJSON), jest --json, and the e2e
    harness's {format:'e2e-flows'} dump. Anything unparseable/absent → []."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            raw = f.read().strip()
    except OSError:
        return []
    if not raw:
        return []

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = None

    if isinstance(data, dict):
        if data.get("format") == "e2e-flows":
            return [(str(f.get("name", "?"))[:200], "pass" if f.get("ok") else "fail",
                     float(f.get("secs") or 0)) for f in data.get("flows", [])]
        tests = []
        for suite in data.get("testResults") or []:
            base = os.path.basename(suite.get("name") or suite.get("testFilePath") or "?")
            for t in suite.get("testResults") or []:
                status = {"passed": "pass", "failed": "fail"}.get(t.get("status"), "skip")
                name = t.get("fullName") or t.get("title") or "?"
                secs = (t.get("duration") or 0) / 1000.0
                tests.append((f"{base}::{name}"[:200], status, secs))
        return tests

    tests = []
    status_of = {"ok": "pass", "failed": "fail", "timeout": "fail",
                 "skipped": "skip", "ignored": "skip"}
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "test" and ev.get("event") in status_of:
            tests.append((str(ev.get("name", "?"))[:200], status_of[ev["event"]],
                          float(ev.get("exec_time") or 0)))
    return tests


def ingest_timing(run_id, path):
    """Attach per-test durations to the recorded run. Best-effort, like record()."""
    if not run_id or not path:
        return
    try:
        tests = parse_timing_file(path)
        if not tests:
            return
        with connect() as con:
            con.executemany(
                "INSERT INTO tests(run_id,name,status,secs) VALUES(?,?,?,?)",
                [(run_id, n, s, round(x, 3)) for n, s, x in tests],
            )
    except Exception as e:
        print(f"testruns: WARNING — could not record per-test timings: {e}", file=sys.stderr)


def cpu_now():
    """Total CPU seconds (self + children) — children are where suite time lives."""
    t = os.times()
    return t.user + t.system + t.children_user + t.children_system


def cmd_run(a):
    t0 = time.time()
    c0 = cpu_now()
    # Per-test timing seam: the child MAY write a machine-readable timing file here
    # (nextest libtest-json, jest --json, e2e per-flow JSON). Absent → wall/CPU only.
    timing_path = None
    env = dict(os.environ)
    if a.sh is not None or a.cmd:
        with tempfile.NamedTemporaryFile(prefix="dpay-testruns-timing-", delete=False) as tf:
            timing_path = tf.name
        env["DPAY_TESTRUNS_TIMING"] = timing_path
    try:
        if a.sh is not None:
            rc = subprocess.run(["bash", "-uc", a.sh], env=env).returncode
        else:
            rc = subprocess.run(a.cmd, env=env).returncode
    except KeyboardInterrupt:
        rc = 130
    run_id = record(a.suite, "pass" if rc == 0 else "fail",
                    {"exit": rc, "secs": round(time.time() - t0, 1),
                     "cpu": round(cpu_now() - c0, 1)})
    ingest_timing(run_id, timing_path)
    if timing_path:
        try:
            os.unlink(timing_path)
        except OSError:
            pass
    sys.exit(rc)


def cmd_record(a):
    if a.result not in ("pass", "fail"):
        sys.exit("testruns: result must be 'pass' or 'fail'")
    extra = json.loads(a.detail) if a.detail else {}
    sys.exit(0 if record(a.suite, a.result, extra) else 1)


def cmd_report(a):
    commit = resolve_commit(a.commit)
    rows = latest_at(commit)
    if a.json:
        print(json.dumps({"commit": commit,
                          "suites": {k: {**v, "age_s": max(0, int(time.time()) - v["ts"])}
                                     for k, v in rows.items()}}, sort_keys=True))
        return
    print(f"== testruns @ {commit[:12] if commit else '(no commits yet)'}")
    if not rows:
        print("   no records for this commit — unknown is NOT fail")
        return
    print_evidence(commit, "commit")
    ok, status = evidence_ok(rows, "verify", commit)
    if ok:
        print(f"overall: VERIFIED — verify pass ({age(rows['verify']['ts'])} old,"
              f" tree matches HEAD)")
    else:
        why = {"stale-tree": "tree ≠ HEAD tree (edits since the run — re-run on the committed tree)",
               "unknown": "no record"}.get(status, f"last record: {status}")
        print(f"overall: NOT VERIFIED — verify: {why}")


def cmd_floor(a):
    head = resolve_commit(None)
    if not head:
        sys.exit("testruns floor: not a git checkout (no HEAD) — cannot evaluate.")
    url = os.environ.get("DPAY_RELAY_URL", DEFAULT_URL).rstrip("/") + "/api/v1/version"
    print(f"== local HEAD: {head}")
    try:
        # A UA is mandatory: Cloudflare 403s the default `Python-urllib/x` agent.
        req = urllib.request.Request(url, headers={"User-Agent": "dpay-testruns/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"floor: could not reach {url}: {e}")
        sys.exit(2)
    raw = str(data.get("commit", ""))
    print(f"== live relay: {raw or '(no commit field)'}  ({url})")
    dirty = raw.endswith("-dirty")
    live = raw[: -len("-dirty")] if dirty else raw
    if len(live) != 40:
        print("floor: live /version did not return a 40-char commit — unparseable.")
        sys.exit(2)
    if dirty:
        print(f"floor: FAIL — the live relay was built from a DIRTY working tree"
              f" ({raw}); no commit describes what prod is running, so no evidence"
              f" can apply. Redeploy from a committed tree (docs/OPS.md section 3).")
        sys.exit(1)

    ahead = git("merge-base", "--is-ancestor", live, head)
    if live == head:
        fid = "MATCH (live == HEAD)"
    elif ahead.returncode == 0:
        n = git("rev-list", "--count", f"{live}..{head}").stdout.strip()
        fid = f"BEHIND by {n} commit(s)"
    else:
        fid = "MISMATCH (live is NOT an ancestor of HEAD — divergent/force-push)"

    rows = print_evidence(live, "live commit")
    ok, req_status = evidence_ok(rows, a.require, live)
    if fid.startswith("BEHIND"):
        log = git("log", "--oneline", f"{live}..{head}").stdout.splitlines()
        print(f"== unshipped at HEAD ({len(log)} commit(s)):")
        for line in log[:20]:
            print(f"   {line}")
        if len(log) > 20:
            print(f"   … and {len(log) - 20} more")
        head_rows = latest_at(head)
        hok, hstatus = evidence_ok(head_rows, a.require, head)
        print(f"== HEAD {a.require}: {hstatus}" + (f" ({age(head_rows[a.require]['ts'])} old)" if hok else ""))
    print(f"== fidelity: {fid}")
    print(f"== floor requirement '{a.require}' at the LIVE commit: {req_status}")
    if ok:
        print(f"FLOOR OK — prod runs a clean commit whose '{a.require}' record is green"
              f" on its exact tree ({age(rows[a.require]['ts'])} old).")
        sys.exit(0)
    why = {"stale-tree": f"the '{a.require}' record at this commit was taken on a DIFFERENT"
                         " tree (edits since the run) — re-run the suite on the committed tree",
           "unknown": f"no '{a.require}' record at the live commit"}.get(
              req_status, f"last '{a.require}' record: {req_status}")
    print(f"FLOOR NOT MET — {why}.")
    sys.exit(1)


def cmd_timing(a):
    commit = resolve_commit(a.commit)
    if a.suite is None:
        # List mode: latest run of EVERY suite, wall-desc — the "where does the time go" overview.
        with connect() as con:
            rows = con.execute(
                """SELECT r.suite, r.result, r.ts, r.detail, r.rev,
                          (SELECT COUNT(*) FROM tests t WHERE t.run_id = r.id)
                   FROM runs r
                   JOIN (SELECT MAX(id) AS m FROM runs GROUP BY suite) x ON x.m = r.id""").fetchall()
        if not rows:
            print("== timing: no runs recorded yet")
            return
        parsed = []
        for suite, result, ts, detail, rev, ntests in rows:
            try:
                d = json.loads(detail) if detail else {}
            except json.JSONDecodeError:
                d = {}
            if not isinstance(d, dict):
                d = {}
            parsed.append((float(d.get("secs") or 0), suite, result, ts, d, rev or "?", ntests))
        parsed.sort(key=lambda r: r[0], reverse=True)
        print(f"== {len(parsed)} suites (latest run each) — wall desc; drill in: just timing <suite>")
        for secs, suite, result, ts, d, rev, ntests in parsed:
            tcol = f"{ntests:>4} tests" if ntests else "      ·"
            print(f"   {suite:<20} {result:<5} wall={secs:>7.1f}s  "
                  f"cpu={float(d.get('cpu') or 0):>7.1f}s  {tcol}  {age(ts)} old  @ {rev[:12]}")
        return
    with connect() as con:
        row = con.execute(
            """SELECT id, result, ts, detail FROM runs
               WHERE rev=? AND suite=? ORDER BY id DESC LIMIT 1""",
            (commit, a.suite),
        ).fetchone()
    if not row:
        print(f"== timing: no '{a.suite}' record at {commit[:12] or '(no commits)'}"
              f" — unknown is NOT fail")
        return
    run_id, result, ts, detail = row
    try:
        d = json.loads(detail) if detail else {}
        if not isinstance(d, dict):
            d = {}
    except json.JSONDecodeError:
        d = {}
    with connect() as con:
        tests = con.execute(
            "SELECT name, status, secs FROM tests WHERE run_id=? ORDER BY secs DESC",
            (run_id,),
        ).fetchall()
    if a.json:
        print(json.dumps({"suite": a.suite, "commit": commit, "result": result, "ts": ts,
                          "detail": d,
                          "tests": [{"name": n, "status": s, "secs": x}
                                    for n, s, x in tests]}, sort_keys=True))
        return
    print(f"== {a.suite} @ {commit[:12]}  {result}  {age(ts)} old  "
          f"wall={d.get('secs', '?')}s  cpu={d.get('cpu', '?')}s  exit={d.get('exit', '?')}")
    if not tests:
        print("   (no per-test timings recorded for this run)")
        return
    total = sum(x for _, _, x in tests)
    print(f"   {len(tests)} tests, Σ {total:.1f}s — slowest {min(a.top, len(tests))}:")
    for name, status, secs in tests[: a.top]:
        mark = {"pass": "✓", "fail": "✗"}.get(status, "·")
        print(f"   {mark} {secs:>8.2f}s  {status:<5} {name}")


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="run a suite command and record its result")
    r.add_argument("suite")
    r.add_argument("--sh", help="run this shell string via bash -uc instead of argv")
    r.add_argument("cmd", nargs="*", help="command to run (after --)")
    r.set_defaults(fn=cmd_run)

    r = sub.add_parser("record", help="record a verdict without running anything")
    r.add_argument("suite")
    r.add_argument("result", choices=["pass", "fail"])
    r.add_argument("--detail", help="JSON blob (e.g. counts)")
    r.set_defaults(fn=cmd_record)

    r = sub.add_parser("report", help="per-suite latest status at a commit (default HEAD)")
    r.add_argument("commit", nargs="?")
    r.add_argument("--json", action="store_true")
    r.set_defaults(fn=cmd_report)

    r = sub.add_parser("floor", help="composite prod gate: live commit -> recorded evidence")
    r.add_argument("--require", default="verify", help="suite that must be green (default verify)")
    r.set_defaults(fn=cmd_floor)

    r = sub.add_parser("timing",
                       help="per-test timing breakdown of a recorded run; bare: list suites by wall")
    r.add_argument("suite", nargs="?", default=None)
    r.add_argument("commit", nargs="?")
    r.add_argument("--top", type=int, default=20, help="how many slowest tests to show")
    r.add_argument("--json", action="store_true")
    r.set_defaults(fn=cmd_timing)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
