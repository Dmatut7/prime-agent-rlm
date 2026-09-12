# REPL runtime protocol

`python -m rlm.repl` starts a CPython REPL runtime that executes code cells in
one persistent `__main__` namespace on a single asyncio event loop. The wire
format is newline-delimited JSON: one object per line, UTF-8, no other framing.
The runtime speaks protocol versions `3` and `4`. Which one a process uses is
negotiated at startup (see [Protocol negotiation](#protocol-negotiation)) and
announced in the `ready` event.

## Protocol negotiation

The host may request a version through the `PRIME_AGENT_KERNEL_PROTOCOL`
environment variable. The runtime clamps the request into
`[MIN_PROTOCOL_VERSION, PROTOCOL_VERSION]` (`[3, 4]`) and reports the result in
its `ready` frame; an unset, unparsable, or out-of-range value degrades to
`DEFAULT_PROTOCOL_VERSION` (`3`) instead of failing, so an old host or a stale
venv still boots. Inside the kernel, `rlm.repl.negotiated_protocol()` is the
single source of truth for what was agreed and `rlm.repl.kernel_capabilities()`
returns the tokens announced in the `ready` frame.

Two rules follow from the host treating an unknown frame `event` as protocol
corruption — it repairs, which means killing, the kernel:

- Nothing introduced above the negotiated version may be sent: no new frame
  kind, and no new field a host of that version cannot place.
- A host gates a request field on the capability token the kernel announced, not
  on the version number. A runtime built between a version bump and the change
  that understands a field still announces the newer version, so the number
  alone cannot tell the two apart.

| Token | Since | Gates |
|---|---|---|
| `preserve_names` | 4 | the snapshot request field `preserve_names` and the `preserved` field of its `done` frame |

Version 4 also adds one frame kind rather than a request field: `heartbeat`
(see [Liveness heartbeat](#liveness-heartbeat)), gated on the negotiated version
alone because a host has to understand the kind before it can accept a frame of
it.

## Channels

- Requests arrive on fd 0 (stdin).
- Events leave on a private dup of the original fd 1, made before anything else
  runs. Every frame is one locked write sequence, so frames never interleave.
- Python-level writes through `sys.stdout`/`sys.stderr` are intercepted at
  write time, tagged with the writing context's cell id, and shipped straight
  to the protocol.
- fds 1 and 2 are redirected into pipes at startup; pump threads read them and
  ship the bytes as `stdout`/`stderr` events with `id: null` — raw fd bytes
  (`os.write`, `sys.stdout.buffer.write`, C extensions, subprocesses) are never
  attributed to a cell.
  Neither channel can corrupt protocol framing. Ordering is preserved within
  each channel, not across them.
- fd 0 is rebound to `/dev/null` after the reader thread takes it, so user
  `input()` sees EOF instead of consuming protocol frames.

## Requests

| Request | Fields |
|---|---|
| `execute` | `{"type":"execute","id":str,"code":str}` |
| `interrupt` | `{"type":"interrupt","id"?:str}` — no reply |
| `host_reply` | `{"type":"host_reply","id":str,"data":{"status":"ok","result":{...}}}` or an error envelope — no reply |
| `snapshot` | `{"type":"snapshot","id":str,"path":str,"manifest_path":str,"max_bytes"?:int,"max_variable_bytes"?:int,"prune_oversized"?:bool,"final"?:bool,"preserve_names"?:[str,...]}` — `preserve_names` needs the negotiated protocol 4 and the `preserve_names` capability token; `final` is ungated, a runtime without the snapshot replay shortcut ignores it |
| `restore` | `{"type":"restore","id":str,"path":str}` |
| `list_names` | `{"type":"list_names","id":str}` |
| `shutdown` | `{"type":"shutdown","id"?:str}` |

Requests other than `interrupt` and `host_reply` run strictly in order, one at
a time. A malformed line
produces `{"event":"error","id":null,"ename":"ProtocolError",...}` and the
runtime keeps serving. Closing stdin is equivalent to `shutdown`.

## Events

- `{"event":"ready","protocol":3,"python":"3.13.11"}` — sent once at startup;
  the handshake. No banner precedes it. `protocol` is the negotiated version, not
  necessarily the highest one this runtime speaks. A runtime with something to
  announce adds `"capabilities":["token",...]`; the field is omitted while the
  list is empty, so a protocol-3 host sees exactly the frame it always has.
- `{"event":"stdout"|"stderr","id":str|null,"text":str}` — captured output.
  `id` is the cell whose Python execution context performed the write; asyncio
  tasks inherit the spawning cell's id (even after that cell finished). `null`
  for user threads, raw fd writes (`os.write`, C extensions, subprocesses),
  and anything else without provable ownership — bytes read from the fd pipes
  are never attributed to a cell.
- `{"event":"result","id":str,"text":str}` — `repr` of the cell's trailing
  expression when the body ends in an expression whose value is not `None`.
  The value is also bound to `_` in the namespace.
- `{"event":"display","id":str|null,"data":{mime:payload,...}}` — one dict of
  MIME type to JSON payload, shipped verbatim from `emit()`. `id` rides task
  context: an asyncio task spawned by a cell keeps that cell's id even after
  the cell finishes; user threads emit `null`.
- `{"event":"host_request","id":str,"data":{...}}` — one typed request from
  runtime code to the host; the host answers with a `host_reply` request
  carrying the same id.
- `{"event":"heartbeat","id":str|null,...}` — protocol 4 only, and only while a
  request is in flight: one out-of-band liveness frame per interval. See
  [Liveness heartbeat](#liveness-heartbeat). It is never attributed to a cell's
  output and the host dispatches it before id attribution.
- `{"event":"error","id":str|null,"ename":str,"evalue":str,"traceback":[str,...]}`
- `{"event":"done","id":str,"status":"ok"|"error"}` — exactly one per id'd
  request, always after all of that request's other events. A snapshot `done`
  adds `saved`, `skipped`, `pruned`, `bytes`, and — only for a request that sent
  `preserve_names` — `preserved`; a restore `done` adds `restored`,
  `failed`; a `list_names` `done` adds `names`; a failed snapshot/restore adds
  `reason`. Restoring a missing file reports `status:"ok"` with empty
  `restored`/`failed` lists and `reason:"snapshot not found"`.

Tagged Python-level writes are coalesced: text is batched per (stream, cell id)
and ships as one frame when the stream is flushed (`flush=True`, drain), when
an entry outgrows 64 KiB, or ~5 ms after the first buffered write — whichever
comes first. Frame boundaries carry no meaning (the host concatenates `text`
per stream), ordering and id attribution do: writes are buffered in arrival
order with the id captured at write time, and `emit()`/`host_request` flush
first so a cell's own output precedes its display/host-request frames.

Before a cell's `done`, the runtime drains both channels: buffered tagged
writes are flushed, and the fd pipes are fenced with a marker byte sequence
awaited in the pumps, so every byte the cell wrote synchronously — including
direct fd writes — precedes its `done`. Ordering between a cell's Python-level
writes and its raw fd writes is not guaranteed (two channels).

## Liveness heartbeat

A host cannot tell a wedged kernel from one that is waiting on work it does not
own: both look like silence. Protocol 4 therefore adds one out-of-band frame per
interval, sent from a thread that does not depend on the event loop (the same
shape as the owner watchdog), while a request is in flight.

```
{"event":"heartbeat","id":str|null,"finishing":true?,"tick":int,"cpu_ms":int,
 "stream_bytes":int,"cells_done":int,"host_requests":int,"interval_ms":int,
 "bash":{"handles":int,"cell_handles":int,"buffered_bytes":int,"pipe_pending":int}}
```

- Gate: `negotiated_protocol() >= 4`. A host that never asked for protocol 4
  reads the kind as corruption and kills the kernel, so a negotiated-3 session
  sends none at all — no thread is even started.
- Gate: a request is in flight (`_active["rid"]`, or a rid still in `_inflight`
  during the post-run finishing phase). An idle kernel sends nothing.
- `id` names the in-flight request in both phases: while the body runs it comes
  from `_active["rid"]`, and during the post-run finishing phase from
  `_finishing_rid` (read under `_interrupt_lock` together with `_inflight`, so a
  request that already finished is never named). An id-less frame told the host
  "no cell in flight" for exactly the window a huge `repr` spends minutes in,
  which is the window the frame exists to cover.
- `finishing: true` (omitted otherwise, so a host that predates it reads the
  frame it always read) marks that phase. It is synchronous main-thread work, so
  the loop tick is frozen *by design* while the frames keep arriving; without
  the marker that is indistinguishable from a deadlocked cell body, and the host
  reports a stall instead of excusing it. A request that is in flight but neither
  active nor finishing (a queued snapshot/restore) keeps `id: null`.
- Period: `KERNEL_HEARTBEAT_INTERVAL_MS`, default `5000`, clamped to
  `[100, 600000]`. The resolved value rides in every frame as `interval_ms` so
  the host can judge staleness against the kernel's own period rather than a
  guess.
- `tick` counts a self-renewing `loop.call_later` timer, so it advances only
  while the event loop is free to run callbacks. A synchronous cell
  (`time.sleep`) freezes it while frames keep arriving — that contrast is the
  point of the frame.
- Every other field is a monotonic counter (`os.times` cpu, streamed stdout/
  stderr bytes, finished requests, pending `host_request` futures) or an O(1)
  snapshot of the bash registries (`rlm.bash.live_handle_facts`: live handles,
  handles attributed to this cell, buffered bytes, handles with bytes pending on
  the capture pipe). The host diffs two retained frames; counters, not rates, so
  a frame it never saw cannot make the next one lie.
- Serialization is strict (`json.dumps(..., allow_nan=False)`): a value that
  cannot be serialized strictly drops that frame instead of tearing the stream,
  and a fact source that raises costs one round, not the thread. Both fail
  towards "the heartbeat looks older", which is the direction the host already
  treats as evidence against the kernel.

## Execution

Cells compile with `PyCF_ALLOW_TOP_LEVEL_AWAIT` and run as tasks on the
persistent event loop, so `await` works at top level and background tasks
created by a cell keep running between cells. Each cell's source is registered
in `linecache` under `<cell-N>`, so tracebacks show the offending source line.
Tracebacks are plain `traceback` formatting with the runtime's own frames
stripped, keeping cell and library frames; no colors, no decoration.

## Interrupt

`{"type":"interrupt"}` raises `KeyboardInterrupt` in the running cell. Without
an `id` the interrupt applies to the running request, or — when none is running
yet — to the next queued one; with an `id` it applies to that request only.
An interrupt that arrives before its request starts executing is parked and
delivered the moment the request becomes active, so `execute` + `interrupt`
written back-to-back still interrupts the cell. A request stays
interrupt-targetable until its `done` event is emitted: this covers the
post-run trailing-expression `repr` and output drain. Interrupts for finished
or unknown requests are dropped.

Delivery: the reader thread sends SIGINT to the main thread (also the loop
thread); the handler asks asyncio which task's step the signal interrupted.
On Windows (no `signal.pthread_kill`) the reader instead cancels the active
cell task on the loop, so await-suspended cells interrupt normally but cells
blocked in synchronous code cannot be broken (best-effort parity):

- The active cell's own task is mid-step (sync bytecode such as a `time.sleep`
  loop, or a blocking syscall such as `selectors.select()` woken by EINTR):
  the handler raises `KeyboardInterrupt` directly and it propagates out of the
  cell task.
- The loop is idle in `select()` (the cell is suspended at an `await`) or a
  different task — a background task or the runtime itself — is mid-step:
  raising there would land in the wrong context, so the handler cancels the
  active cell task and the runtime reports the cancellation as a
  `KeyboardInterrupt`. When the mid-step task is a background task, the
  handler also raises `KeyboardInterrupt` into it: a background task blocked
  in synchronous code occupies the only thread, so it receives the
  `KeyboardInterrupt` (and dies with it) to unblock the loop and let the
  cancel take effect. Limitation: the interrupt lands at the await point as a
  cancellation, so user code catching `KeyboardInterrupt` around an `await`
  does not intercept it.

Both paths end with an `error` event (`ename` `KeyboardInterrupt`) and
`done` with `status:"error"`; the runtime keeps serving. When nothing is
running or queued, SIGINT and interrupt requests are ignored.

## Display bridge

`from rlm.repl import emit` inside a cell (or any user thread) ships a
`display` event. `emit(data)` takes one non-empty dict keyed by MIME type
strings; the dict is forwarded verbatim as the event's `data`.

## Host bridge

`await rlm.repl.host_request(data)` ships a `host_request` event with a
runtime-minted id and awaits the matching `host_reply`, returning its `data`
dict verbatim. Replies are routed on the reader thread like `interrupt` —
never through the request queue, since the awaiting cell is itself the
in-flight execute. Replies for unknown ids, or for a request whose awaiting
cell was cancelled, are dropped. `rlm.repl.is_active()` reports whether the
process is serving the protocol (importing the module does not count).

## Snapshot / restore

`snapshot` serializes the user namespace with `dill` (recurse mode), one name
at a time: `_`-prefixed names and
`{rlm, mcp, bash, asyncio, In, Out, get_ipython, exit, quit, open}` are always
skipped; a name whose pickle exceeds `max_variable_bytes` or would push the
total over `max_bytes` is skipped and reported. With `prune_oversized`, only
names exceeding the per-variable cap (`max_variable_bytes`) are also deleted
from the namespace and listed in `pruned`; names skipped for the aggregate
`max_bytes` cap are reported in `skipped` but kept in the namespace. The
payload is written atomically (tmp file + `os.replace`) and a JSON manifest
(`version`, `savedNames`, `skipped`, `pruned`, `preserved`, `bytes`,
`pythonVersion`, `timestamp`) is written to `manifest_path`. A manifest write
failure fails the snapshot (and nothing is pruned).

Snapshots are dirty-tracked, without changing the payload, the manifest, or the
`done` frame. A name still bound to the identical deeply-immutable object (exact
built-in types only: str/bytes/int/float/complex/bool/None/range, and
tuple/frozenset of such) reuses its previously serialized blob instead of
re-dumping it. A request that arrives with no cell executed and no restore
applied since the last successful snapshot for the same parameters, every
eligible name still bound to the identical object, and the committed pair intact
on disk (regular files, payload size unchanged) is answered by replaying that
snapshot's result without touching the files — so the manifest `timestamp`
reflects the last physical write. Any doubt falls through to a full snapshot.
Mutable values are only reused under the no-cell-executed condition, because
in-place mutation by a cell is invisible to identity; in-place mutation by a
background thread while no cell runs is outside what the fingerprint can see
(the same approximation the replay condition makes).

`final: true` marks the host's terminal (dispose) snapshot, and such a request is
never answered from the replay record: it is the last word on this namespace, so
it is written even when every fingerprint says nothing changed. That covers the
hole above for the snapshot a later kernel will restore from; ordinary per-cell
snapshots keep the shortcut, so a payload written by one of them can still miss
an in-place background mutation until the next cell or the terminal flush. The
field is additive and ungated — a runtime without the shortcut has nothing to
bypass and ignores it.

`preserve_names` (protocol 4, gated on the capability token) turns the write into
a merge write: for each requested name the blob is copied verbatim from the
payload currently on disk instead of being taken from the live namespace, and the
names actually carried over are reported in `preserved` (and in the manifest).
This is how a session that restored only part of its state keeps persisting — the
new work is written, the values that could not be revived survive unchanged, and
a later restore still reports those same names in `failed` rather than pretending
they came back. A requested name the live namespace can serialize again keeps its
fresh value instead of the saved blob: a variable the model rebuilt after the
failed restore is the current fact, so the stale blob is not written back over it
(the name simply stays out of `preserved`). A requested name that the previous payload does not hold, or a
previous payload that cannot be read at all, is reported in `skipped` with a
`preserved blob unavailable: …` reason and the write still happens; the merge step
is never allowed to cost the snapshot. Carried blobs bypass the per-variable cap
(preserving outranks pruning, and a preserved name is never listed in `pruned`)
but not the aggregate `max_bytes`: when the payload has to shrink, the oldest
requested name is dropped first and reported in `skipped`.

`restore` loads the payload and revives each name independently; a missing
file yields an ok empty restore with `reason:"snapshot not found"`, a corrupt
file fails with a `reason`, and per-name failures are listed in `failed`.
Names `In`, `Out`, and `get_ipython` in a payload are never restored. `dill` is imported lazily; when unavailable, snapshot and restore
fail with `status:"error"` and a `reason`.

`list_names` replies with `done` carrying `names`: the sorted user-defined
top-level names under the same filter the snapshot applies.

## Shutdown

`shutdown` (or stdin EOF) kills live `rlm.bash` child process groups, replies
`done` (when the request carried an id), stops the loop, and exits 0.
