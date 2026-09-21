---
name: agent-message
description: Message an agent's parent, siblings, or direct children through the daemon, and abort a stuck family agent's active turn. Use the family roster to discover reachable agents and send direct text without spoofing sender identity.
---

# Agent Message

Send direct messages within the current agent's nuclear family through the
local daemon: parent, siblings, and direct children only. Roots are siblings.
The daemon derives your sender identity from the current session; do not try
to include a `from` field.

Call directly from the kernel:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    receipt = await agent_message.send(
        "Please inspect the latest result.",
        receiver_role="child",
        receiver_name=child.session_name,
    )
    # Keep the child until this follow-up finishes so its result remains observable.
```

When a child goes silent mid-turn, the parent receives an `rlm_child_stall_notice`
with the silent duration, the in-flight tools, and the levers. The non-destructive
lever is an abort:

```python
# The child keeps its session and context; its active run stops and any queued
# steering messages are delivered in one new turn.
await agent_message.abort("child", child.session_name)
```

## API

Family discovery has one directory and two entries: `await agent_observe.list_agents()` returns it as `agents` rows, each carrying `relationship` with live detail for a resident member and persisted facts otherwise, and `await agent_message.list_agents()` returns the same members in its legacy `current`/`entries` shape.

- `await agent_message.list_agents()` — returns `current` (`name`, `id`, `depth`)
  and family-scoped `entries` (`relationship`, `name`, `id`, `depth`, `status`)
  for the current agent's parent, siblings, and children. It includes inactive
  family members and sorts parent, siblings by name, then children by name; it
  does not expose a global daemon session list. It is the legacy shape of the one
  family directory, so its members, their `relationship`, their order, and their
  coarse `status` (`running`/`idle`/`inactive`) are exactly what
  `await agent_observe.list_agents()` reports.
- `await agent_message.send(message, receiver_role="parent" | "sibling" | "child", receiver_name=None)` — sends one direct
  text message to an active session. Sending to an idle completed subagent
  starts an ordinary follow-up turn in that same child session and context.
  The child remains available only until its parent session closes. The daemon
  resolves `receiver_role` within the current agent family; `receiver_name` is
  required for siblings and children and omitted for the unique parent.
  `send("all", message)` broadcasts only to the family roster and returns
  `{receipts: [...]}` in roster order; successful entries are ordinary receipts
  and failed entries contain the target id and a short `error`. One failed delivery
  does not reject successful deliveries. Messages always use steering delivery so
  a busy target sees them during its active run. Returns a receipt with a
  `deliveryStatus` field: `"delivered"` means the message reached an idle target's
  context; `"queued"` means a steering message was accepted and will deliver when
  the target's current work allows (`send` does not block waiting for that).
  Delivered receipts carry `deliveredAt`, queued receipts carry `queuedAt`.
- `await agent_message.abort(receiver_role, receiver_name=None, send_queued=True)` —
  stops one family target's active run without deleting the agent. Reach is the
  same nuclear family as `send`: parent, siblings, and direct children; there is
  no broadcast. With `send_queued=True` (the default) the abort also flushes the
  target's queued steering messages into one new turn (the
  `abort_and_send_queued` semantics), which is the right lever for a child that
  is wedged mid-turn but should keep working; with `send_queued=False` the
  active run stops and the queue is left untouched, matching a plain interrupt.
  The receipt reports the resolved `target` and `sendQueued`; `resumedQueued: true`
  means a queued steering batch actually existed and was resumed. The call is
  idempotent in effect only in the sense that aborting an idle target is a no-op.
  **Degradation**: the lever rides a capability-gated daemon command
  (`abort_agent_target`); a daemon from before that capability rejects the
  request and the call raises `Agent abort is not supported by the connected
  daemon (missing the "abort_agent_target" capability)` — no abort was issued,
  and the fallback levers are `rlm.delete_subagent` (destructive) or waiting out
  the watchdog. Prefer checking `agent_observe` first: abort a target that is
  genuinely stuck, not one that is streaming or running a long tool.

## Safety

- Do not delete a child immediately after `send`: delivered follow-ups may still
  be running and queued receipts have not run yet. Wait until observation shows
  the child is idle and its context is no longer needed before calling
  `await rlm.delete_subagent(child)`.
- `abort` is the non-destructive lever for a stuck family agent: the target keeps
  its session, transcript, and context, so follow-up `send`s still work after an
  abort. Use `rlm.delete_subagent` only when the agent itself should go away.
- Reach is limited to parent, siblings, and direct children; relay through an
  intermediate child instead of messaging grandchildren or cousins directly.
- Sender identity is daemon-derived and cannot be spoofed from Python.
- The daemon enforces message size, rate, and pending-queue limits before
  accepting delivery.
