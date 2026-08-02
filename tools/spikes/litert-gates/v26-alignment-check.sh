#!/usr/bin/env bash
# V26 - 16 KB page-size alignment.
#
# Since 2025-11-01 new apps and updates targeting Android 15+ must support 16 KB page sizes.
# Failure blocks EVERY Play upload and the remedy is a multi-day source build, so this runs
# on day 1. It needs no device: the connected S21+ reports PAGE_SIZE 4096 and cannot exercise
# 16 KB behaviour at runtime anyway.
#
# Checks alignment >= 2**14 (16384). Note 2**16 also passes and is common - do NOT test for
# equality with 2**14.
#
# Usage: ./v26-alignment-check.sh <path-to-apk-or-dir-of-.so>
set -uo pipefail

NDK_DIR="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}/ndk"
OBJDUMP="$(ls -d "$NDK_DIR"/*/toolchains/llvm/prebuilt/*/bin/llvm-objdump* 2>/dev/null | sort -V | tail -1)"
[ -x "$OBJDUMP" ] || { echo "FATAL: no llvm-objdump under $NDK_DIR"; exit 2; }

TARGET="${1:?usage: $0 <apk|dir>}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

if [[ "$TARGET" == *.apk ]]; then
  # Extract everything rather than passing a 'lib/*' pattern: MSYS/Git-Bash rewrites
  # slash-bearing arguments into Windows paths, so the pattern silently matches nothing.
  MSYS_NO_PATHCONV=1 unzip -q -o "$TARGET" -d "$WORK" || true
  SCAN="$WORK"
else
  SCAN="$TARGET"
fi

fail=0; count=0
while IFS= read -r so; do
  count=$((count+1))
  # Every LOAD segment must be aligned to at least 2**14.
  # NOTE: do NOT split on the literal "**" — awk treats the separator as a regex and "**"
  # is invalid, which makes awk abort and yield an EMPTY result that reads as a pass.
  # Strip the "2**" prefix textually instead.
  segs="$("$OBJDUMP" -p "$so" 2>/dev/null | awk '/LOAD/ {
      for (i=1;i<=NF;i++) if ($i=="align") { t=$(i+1); sub(/^2\*\*/,"",t); print t }
  }')"
  if [ -z "$segs" ]; then
    echo "FAIL  $(basename "$so")  could not parse any LOAD alignment — treating as failure"
    fail=$((fail+1)); continue
  fi
  bad="$(echo "$segs" | awk '$1+0 < 14 { print $1 }')"
  if [ -n "$bad" ]; then
    echo "FAIL  $(basename "$so")  align 2**${bad//$'\n'/, 2**}  (need >= 2**14)"
    fail=$((fail+1))
  else
    echo "ok    $(basename "$so")"
  fi
done < <(find "$SCAN" -name '*.so' -type f)

echo "---"
echo "scanned $count shared objects, $fail misaligned"
[ "$count" -gt 0 ] || { echo "FATAL: no .so found - wrong path?"; exit 2; }
[ "$fail" -eq 0 ] || { echo "V26 FAIL - source build is now on the critical path"; exit 1; }
echo "V26 PASS"
