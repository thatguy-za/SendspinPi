"""Small helpers: subprocess wrapper and background job runner."""
import os
import subprocess
import threading
import time
import uuid


def run(args, timeout=30, env=None):
    """Run argv (never a shell). Returns (returncode, stdout, stderr)."""
    e = os.environ.copy()
    e.update(env or {})
    e["LC_ALL"] = "C"
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=e)
    except FileNotFoundError:
        return 127, "", "command not found: %s" % args[0]
    except subprocess.TimeoutExpired:
        return 124, "", "timed out after %ss" % timeout
    return p.returncode, p.stdout, p.stderr


# ---------------------------------------------------------------- cache
_cache = {}


def cached(key, ttl, fn, fail_ttl=None):
    """Return fn()'s result, remembered for ttl seconds (fail_ttl if the result is falsy)."""
    now = time.time()
    hit = _cache.get(key)
    if hit and now < hit[0]:
        return hit[1]
    val = fn()
    _cache[key] = (now + (ttl if val or fail_ttl is None else fail_ttl), val)
    return val


def cache_clear():
    _cache.clear()


# ---------------------------------------------------------------- jobs
class Busy(Exception):
    pass


_lock = threading.Lock()
_jobs = {}
_current = None
MAX_LINES = 20000


def start_job(title, steps, env=None):
    """steps: list of argv lists or callables(log). One job at a time."""
    global _current
    with _lock:
        if _current and _jobs[_current]["status"] == "running":
            raise Busy()
        jid = uuid.uuid4().hex[:10]
        job = {"id": jid, "title": title, "status": "running", "lines": [],
               "started": time.time()}
        _jobs[jid] = job
        _current = jid
        for old in sorted(_jobs, key=lambda k: _jobs[k]["started"])[:-5]:
            _jobs.pop(old, None)
    threading.Thread(target=_run_job, args=(job, steps, env), daemon=True).start()
    return jid


def _log(job, text):
    if len(job["lines"]) < MAX_LINES:
        job["lines"].append(text.rstrip("\n"))


def _run_job(job, steps, env):
    full_env = os.environ.copy()
    full_env.update(env or {})
    try:
        for step in steps:
            if callable(step):
                step(lambda t: _log(job, t))
                continue
            _log(job, "$ " + " ".join(step))
            try:
                p = subprocess.Popen(step, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, env=full_env)
            except FileNotFoundError:
                _log(job, "command not found: %s" % step[0])
                job["status"] = "failed"
                return
            for line in p.stdout:
                _log(job, line)
            if p.wait() != 0:
                _log(job, "exit code %d" % p.returncode)
                job["status"] = "failed"
                return
        job["status"] = "ok"
    except Exception as exc:  # noqa: BLE001
        _log(job, "error: %s" % exc)
        job["status"] = "failed"
    finally:
        cache_clear()


def job_state(jid, since=0):
    job = _jobs.get(jid)
    if not job:
        return None
    return {"id": jid, "title": job["title"], "status": job["status"],
            "lines": job["lines"][since:], "next": len(job["lines"])}


def active_job():
    if _current and _jobs.get(_current, {}).get("status") == "running":
        return {"id": _current, "title": _jobs[_current]["title"]}
    return None
