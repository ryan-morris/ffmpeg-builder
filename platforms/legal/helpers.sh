#!/usr/bin/env bash
# Text helpers for legal/, sourced by platforms/driver.sh (and by the tests, on their own).

# expand_vars <text>: ${NAME} replaced by that variable of the platform's setup (an unset one is an error). One pass,
# left to right: a value is never expanded again.
expand_vars() {
  local rest="$1" out="" var
  while [[ "${rest}" =~ ^([^$]*)\$\{([A-Za-z_][A-Za-z0-9_]*)\}(.*)$ ]]; do
    var="${BASH_REMATCH[2]}"
    [ -n "${!var:-}" ] || { echo "ERROR: ${var} isn't set by platforms/setup/${SETUP:-?}.sh, but platforms.yml names it in $1" >&2; return 1; }
    out+="${BASH_REMATCH[1]}${!var}"
    rest="${BASH_REMATCH[3]}"
  done
  printf '%s' "${out}${rest}"
}

# fill_template <file>: each @KEY@ for which OFFER_KEY is set replaced by its value, in one pass left to right: what a
# value brings in is never read again (a repository URL with @REPO@ in it stays as it is), and an @...@ with no
# OFFER_ variable stays as written (x@USER@y). Values may span lines.
fill_template() {
  awk '{
    out = ""; rest = $0
    while (match(rest, /@[A-Z_]+@/)) {
      k = "OFFER_" substr(rest, RSTART + 1, RLENGTH - 2)
      out = out substr(rest, 1, RSTART - 1) ((k in ENVIRON) ? ENVIRON[k] : substr(rest, RSTART, RLENGTH))
      rest = substr(rest, RSTART + RLENGTH)
    }
    print out rest
  }' "$1"
}
