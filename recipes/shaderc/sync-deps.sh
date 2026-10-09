#!/usr/bin/env bash
# shaderc_sync_deps: fetch shaderc's pinned third_party sources, VERIFIED. Sourced by build.sh.
# Ported from devenvy/ffmpeg scripts/lib.sh (shaderc_sync_deps + resolve_python).
#
# shaderc's utils/git-sync-deps clones its DEPS (abseil, effcee, googletest, glslang, re2,
# SPIRV-Headers, SPIRV-Tools) in worker THREADS whose exceptions are never propagated, so a clone
# that dies on a GitHub 504 still lets the script exit 0. Retrying on the exit status therefore
# retried nothing: CI failed later in CMake with "SPIRV-Headers was not found" (both the host glslc
# build in 03_install_packages.sh and deps/shaderc.sh, which had no retry at all). Success is now
# decided by checking every DEPS entry on disk -- a git checkout whose HEAD is the pinned
# revision -- the same way git-sync-deps itself parses DEPS. Failed entries are removed and the
# sync retried with backoff.

GIT_CLONE_ATTEMPTS="${GIT_CLONE_ATTEMPTS:-6}"

# resolve a python interpreter that actually RUNS.
# `command -v python3` answers "is something named python3 on PATH", not "does it work" -- the
# same intent-vs-reality gap this repo's capability checks exist to close. On Windows, python3 is
# usually a Microsoft Store alias stub: it resolves, then exits 49 with a "not found, install from
# the Store" message. A script that trusts `command -v` dies later with that message instead of a
# usable error. Probe by EXECUTING the interpreter, and prefer python3 over python.
# Echoes the interpreter name; returns 1 (and says why) when neither works.
resolve_python() {
  local _py
  for _py in python3 python; do
    if command -v "${_py}" >/dev/null 2>&1 && "${_py}" -c 'import sys' >/dev/null 2>&1; then
      printf '%s\n' "${_py}"; return 0
    fi
  done
  echo "ERROR: no working python3/python on PATH (a name that resolves but fails to run, such as" >&2
  echo "  the Windows Store 'python3' alias stub, does not count)." >&2
  return 1
}

# shaderc_sync_deps <shaderc-source-dir>
shaderc_sync_deps() {
  local dir="$1" py n=1 delay=4 bad d
  py="$(resolve_python)" || return 1
  while :; do
    # GIT_TERMINAL_PROMPT=0: a moved/deleted repo makes GitHub ask for credentials; never block on it.
    ( cd "${dir}" && GIT_TERMINAL_PROMPT=0 "${py}" ./utils/git-sync-deps ) || true
    bad="$( cd "${dir}" && "${py}" - <<'PY'
import os, subprocess
# Evaluate DEPS the way git-sync-deps does: it is Python, with Var() resolving from vars.
g = {}
exec(compile(open("DEPS").read(), "DEPS", "exec"), {"Var": lambda k: g["vars"][k]}, g)
for rel, spec in sorted(g.get("deps", {}).items()):
    url, _, rev = spec.partition("@")
    ok = False
    if os.path.isdir(os.path.join(rel, ".git")) or os.path.isfile(os.path.join(rel, ".git")):
        r = subprocess.run(["git", "-C", rel, "rev-parse", "HEAD"], capture_output=True, text=True)
        ok = r.returncode == 0 and r.stdout.strip() == rev
    if not ok:
        print(rel)
PY
    )" || bad="DEPS-unreadable"
    if [ -z "${bad}" ]; then
      echo "shaderc third_party sources verified at their pinned revisions."
      return 0
    fi
    if [ "${n}" -ge "${GIT_CLONE_ATTEMPTS}" ]; then
      echo "ERROR: shaderc third_party not synced after ${n} attempts: $(echo ${bad})" >&2
      return 1
    fi
    echo "  shaderc git-sync-deps incomplete (attempt ${n}/${GIT_CLONE_ATTEMPTS}): $(echo ${bad}) -- retrying" >&2
    for d in ${bad}; do [ "${d}" = DEPS-unreadable ] || rm -rf "${dir:?}/${d}"; done
    sleep $(( delay + (RANDOM % 5) ))
    delay=$(( delay * 2 )); n=$(( n + 1 ))
  done
}
