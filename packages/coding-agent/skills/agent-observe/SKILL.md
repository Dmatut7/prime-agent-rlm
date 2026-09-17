---
name: agent-observe
description: Read-only roster and observation of an agent's parent, siblings, and direct children. Use to discover reachable family members and to inspect family status and bounded recent-message previews without mutating sessions.
---

# Agent Observe

Observe the current agent's nuclear family through the local daemon: parent,
siblings, direct children, and self. `list_agents` is the one family directory and
covers every member `agent_message.send` can reach. `get_agent` and
`recent_messages` read a session resident in this worker, hydrating an inactive
registered child on demand; a member with no live session in this worker (a root
that exists only on disk, or a root live in another worker) can be listed and
messaged but not read.
This skill is read-only: it can list family sessions, inspect one session, and fetch
bounded recent message previews. It cannot prompt, steer, clear, kill, rename, or
otherwise mutate another session.

Call directly from the kernel:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    worker = await agent_observe.get_agent(child.session_name)
    recent = await agent_observe.recent_messages(child.session_name, limit=6)
    # Deletion is a parent-owned RLM operation, not an observe mutation:
    await rlm.delete_subagent(child)
```

## API

Family discovery has one directory and two entries: `await agent_observe.list_agents()` returns it as `agents` rows, each carrying `relationship` with live detail for a resident member and persisted facts otherwise, and `await agent_message.list_agents()` returns the same members in its legacy `current`/`entries` shape.

- `await agent_observe.list_agents()` returns `current` (this agent) and `agents`:
  the parent, the siblings at this depth under the same parent, and the direct
  children, active or not. Every row carries its `relationship`
  (`parent`/`sibling`/`child`) and its session id; a member resident in this
  worker also carries its live detail (active session id, status, streaming
  state, message counts, `latestMessage`), while a member known only from disk
  reports persisted facts only (name, cwd, message count, a capped
  `firstMessage`), has no `activeSessionId`, and reads `status: "inactive"`. Self
  is `current` and is never one of its own members. For direct children,
  `await rlm.list_subagents()` also exposes parent-owned lifecycle handles, and
  `await rlm.collect()` returns typed completion snapshots (status, settled,
  answer preview, `terminal_kind`, `stall_abort`) in one call without any
  observation roundtrip.
- `await agent_observe.get_agent(target)` returns `agent`, where `agent`
  contains one agent summary. `target` is resolved like other live-session
  selectors: active id, session id/name, or unambiguous suffix.
- `await agent_observe.recent_messages(target, limit=8, max_chars=800)`
  returns up to `limit` recent bounded message previews for the target session.
  `limit` must be 1-50, and `max_chars` must be 80-2000.

## Safety

- This skill is read-only and exposes no mutation commands.
- Targets outside the nuclear family are rejected; transcript reads follow the
  same family rule as messaging.
- Message access is bounded by count and per-message character limit.
- Prefer status and recent previews for orchestration. Ask the user before
  using observed context to steer or message another session.
