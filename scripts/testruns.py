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
  floor [--require verify]       composite prod gate: curl the live /api/v1/version,
                                 classify it vs HEAD exactly like verify-relay
                                 (DIRTY first / MATCH / BEHIND-by-N / MISMATCH), then
                                 look up the evidence RECORDED AT THE LIVE COMMIT.
                                 Exit 0 iff prod runs a clean commit whose --require
                                 suite has a green record on this machine.

DB: .dev/testruns.db (gitignored, WAL). Every row pins the commit AND the hash of the
WORKING TREE (throwaway index seeded from HEAD, updated from the worktree) plus a dirty
flag — the `-dirty` lesson: suites exercise the working tree, not the commit, so a green
row taken on a dirty tree can never read as "the commit is verified".

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
    """Best-effort: a recording failure must never fail the run it annotates."""
    try:
        commit, tree, dirty = worktree()
        detail = json.dumps(extra or {}, sort_keys=True)
        with connect() as con:
            con.execute(
                "INSERT INTO runs(ts,rev,tree,dirty,suite,result,host,detail)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (int(time.time()), commit, tree, dirty, suite, result,
                 socket.gethostname()[:64], detail),
            )
        return True
    except Exception as e:
        print(f"testruns: WARNING — could not record {suite}={result}: {e}", file=sys.stderr)
        return False


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


def cmd_run(a):
    t0 = time.time()
    try:
        if a.sh is not None:
            rc = subprocess.run(["bash", "-uc", a.sh]).returncode
        else:
            rc = subprocess.run(a.cmd).returncode
    except KeyboardInterrupt:
        rc = 130
    record(a.suite, "pass" if rc == 0 else "fail",
           {"exit": rc, "secs": round(time.time() - t0, 1)})
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

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
