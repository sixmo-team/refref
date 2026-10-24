#!/bin/sh
set -eu

: "${PGDATA:=/var/lib/postgresql/data}"
: "${REFREF_DATA_MAX_KIB:=1048576}"
: "${REFREF_MIN_FREE_KIB:=8388608}"
for limit in "$REFREF_DATA_MAX_KIB" "$REFREF_MIN_FREE_KIB"; do
    case "$limit" in ''|*[!0-9]*) echo 'Invalid RefRef disk limit' >&2; exit 64 ;; esac
    [ "$limit" -gt 0 ] || exit 64
done

check_disk() {
    metadata=$(stat -f -c '%a %S' "$PGDATA") || return 78
    set -- $metadata
    [ "$#" -eq 2 ] || return 78
    free_kib=$(($1 * $2 / 1024))
    metadata=$(du -sk "$PGDATA") || return 78
    set -- $metadata
    [ "$#" -ge 1 ] || return 78
    if [ "$free_kib" -lt "$REFREF_MIN_FREE_KIB" ] || [ "$1" -gt "$REFREF_DATA_MAX_KIB" ]; then
        printf 'RefRef disk guard: data=%s KiB, free=%s KiB; refusing/stopping only RefRef PostgreSQL.\n' "$1" "$free_kib" >&2
        return 78
    fi
}

if [ "${1:-}" = '--check' ]; then
    check_disk
    exit 0
fi
check_disk || exit 78

child=
shutdown() {
    trap '' INT TERM
    if [ -s "$PGDATA/postmaster.pid" ]; then
        pg_ctl -D "$PGDATA" -m fast -t 10 stop || true
    fi
    if [ -n "$child" ]; then
        kill -TERM "$child" 2>/dev/null || true
        for attempt in 1 2 3 4 5 6 7 8 9 10; do
            kill -0 "$child" 2>/dev/null || break
            sleep 1
        done
        kill -KILL "$child" 2>/dev/null || true
    fi
    # Exiting the container also terminates orphaned initdb/psql children in its PID namespace.
    exit 0
}
trap shutdown INT TERM
/usr/local/bin/docker-entrypoint.sh "$@" &
child=$!
while kill -0 "$child" 2>/dev/null; do
    # ponytail: du scans this small private DB every 15s; use filesystem quotas for larger deployments.
    sleep 15 &
    wait $! || true
    if ! check_disk; then
        shutdown
    fi
done
wait "$child"
