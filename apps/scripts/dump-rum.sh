#!/usr/bin/env bash
# Pull one playground session's raw RUM records out of a groundcover backend — the
# three stores the SDK writes to, unfiltered and unreshaped, so you can inspect what
# actually landed rather than a summary of it.
#
# This is the read half of device testing; see apps/DEVICE_TESTING.md. The e2e suite
# asserts on what the SDK SENT (mock ingest on :9393); this shows what the backend
# STORED, which is a different question and catches different bugs.
#
#   GC_API_HOST=https://api.<cluster host> GC_API_KEY=gcsa_… GC_SESSION_ID=<id> \
#     apps/scripts/dump-rum.sh [outdir] [minutes-back]
#
# NOTE the credential: reads use a `gcsa_` SERVICE-ACCOUNT key, while ingestion uses
# an ingestion key. They are not interchangeable, and swapping them yields a 401 that
# looks identical to a revoked key.
set -uo pipefail

OUT="${1:-./dumps}"
BACK="${2:-60}"
: "${GC_API_KEY:?set GC_API_KEY to a gcsa_ service-account key}"
# No default host: a default would point at one particular cluster, and a dump from a
# cluster your events never reached comes back empty, which reads exactly like the data
# loss you opened it to investigate.
HOST="${GC_API_HOST:?set GC_API_HOST to https://api.<your cluster host>}"
# Every request below carries `Authorization: Bearer $GC_API_KEY`, a real service-account key. So
# the host is validated rather than interpolated blind: an `http://` override (or a typo'd scheme)
# would put that key on the wire in clear text, and this script is normally run with a shell whose
# environment nobody audits.
case "$HOST" in
  https://*) ;;
  *) echo "GC_API_HOST must be an https:// URL (got: $HOST)" >&2; exit 2 ;;
esac

# `-k` disables certificate AND hostname verification for a request carrying that same key, so it
# is opt-in rather than the default: a self-signed local cluster is a real case, but it should be
# stated, not inherited. Prefer GC_CA_BUNDLE, which keeps verification on.
INSECURE=()
if [ -n "${GC_CA_BUNDLE:-}" ]; then
  INSECURE=(--cacert "$GC_CA_BUNDLE")
elif [ "${GC_INSECURE:-0}" = "1" ]; then
  echo "warning: GC_INSECURE=1 — TLS verification disabled, your API key is exposed to any MITM" >&2
  INSECURE=(-k)
fi
# One session, by the id the playground's Custom tab shows: `session_id` is the filter
# all three stores answer, while the fields that tell mobile RUM apart from web RUM
# differ between stores. GC_QUERY replaces it with any other gcql predicate.
if [ -n "${GC_QUERY:-}" ]; then
  QUERY="$GC_QUERY"
else
  : "${GC_SESSION_ID:?set GC_SESSION_ID to the session id from the Custom tab (or GC_QUERY to a gcql predicate)}"
  QUERY="session_id:\"$GC_SESSION_ID\""
fi

mkdir -p "$OUT"

iso() { python3 -c "import datetime,sys;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=int(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$1"; }
START=$(iso "-$BACK")
END=$(iso 5)
echo "window: $START -> $END"
echo "query : $QUERY"

# Each store is queried separately and retried up to three times, so one store's
# error doesn't cost the others' records. Run a short dump again before trusting it.
fetch() { # $1 = api path, $2 = outfile
  local path="$1" out="$2" attempt
  for attempt in 1 2 3; do
    # `${A[@]+"${A[@]}"}`, not `"${A[@]}"`: macOS still ships bash 3.2, where expanding an EMPTY
    # array under `set -u` is an "unbound variable" error — so the plain form breaks the default
    # (verifying) path for anyone who has not installed a newer bash.
    curl -s ${INSECURE[@]+"${INSECURE[@]}"} --max-time 150 -X POST "$HOST$path" \
      -H "Authorization: Bearer $GC_API_KEY" \
      -H 'Content-Type: application/json' \
      -d "$(jq -n --arg q "$QUERY" --arg s "$START" --arg e "$END" \
            '{start:$s,end:$e,query:$q,limit:5000}')" > "$out"

    # A gcql error and a backend outage both return HTTP 200 with a {"message":…}
    # body, which `.data // []` would render as "0 records" — making a broken
    # query indistinguishable from an empty result. Check for the key instead.
    if jq -e 'has("data")' "$out" >/dev/null 2>&1; then
      printf '  %-12s %s records\n' "$(basename "$out")" "$(jq '.data | length' "$out")"
      return 0
    fi
    printf '  %-12s attempt %d: %s\n' "$(basename "$out")" "$attempt" \
      "$(jq -r '.message // .' "$out" 2>/dev/null | head -c 90)"
    sleep 10
  done
  return 1
}

rc=0
fetch /api/k8s/v3/events/search "$OUT/events.json" || rc=1
fetch /api/logs/v3/search       "$OUT/logs.json"   || rc=1
fetch /api/traces/v3/search     "$OUT/traces.json" || rc=1

if [ "$rc" -ne 0 ]; then
  echo
  echo "At least one store failed. Common causes, in order of likelihood:"
  echo "  - a gateway or timeout message            -> the API was not ready; retry shortly"
  echo "  - 401                                     -> wrong credential type (needs gcsa_, not the ingestion key)"
fi
exit "$rc"
