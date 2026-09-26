## Summary

W2: unify the single-instance daemon socket so exactly one supervisor owns the machine-wide roster snapshot and one stable socket path survives across launchd sessions, manual shells, and reboots.

- Stable default socket path (`~/.prime/daemon/daemon.sock`, legacy `$TMPDIR`-keyed path pinned and migrated).
- Takeover protocol: occupancy probe (absent / listening / stale) with lease-guarded bind; a live lease holder that has not bound yet (proper-lockfile ELOCKED) downgrades to standby instead of crashing (N1).
- Occupant identity: before downgrading on "listening", a bounded daemon_hello ladder confirms the listener is really our daemon; a foreign listener fails loudly, never a permanent silent standby (N2).
- Descriptor dir migration keyed on the socket path, with explicit "custom-descriptor-dir" skip and "rename-failed" (errno) reason, no longer silent (N6/N7).
- Live-threads roster snapshot single-writer gate: ownsSocketPath && !leaseCompromised && startupComplete (N5); PR#32's force-refresh-on-shutdown and symmetric rootId fallback ported in the same function (990ca1504 / 70840e224).

## Review disposition

R1 review (r1-socket-review.md) items N1-N12 all addressed; per-item disposition table with commit references and gate readings: `.pipeline/night-20260925/r1-socket-disposition.md`.

## Deployment / migration (N3)

One-time steps, see `w2-design.md` section 5b:

1. `prime-agent shutdown --force` (bare shutdown leaves the supervisor alive).
2. Reboot once: the loaded launchd job still pins the old plist / pa-daemon-start.sh with the old SOCKDIR.
3. First start on the new path auto-migrates the legacy worker descriptor dir; a failed rename logs a degraded line (errno) and adoption falls back to the current generation.
4. Verify `~/.prime/daemon/daemon.sock` answers and `live-threads.json` writtenAt refreshes.

## Test plan

- 78/78 targeted daemon tests green (unit + 3 real-process single-instance wiring cases: fast-path standby, ELOCKED pre-bind lease, foreign-listener refusal).
- tsgo --noEmit: 0 errors; biome check: clean on all touched files.
