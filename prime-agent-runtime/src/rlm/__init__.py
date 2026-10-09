"""Tiny rlm-compatible kernel shim for Prime Agent."""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import effects as _effects
from .bash import BashHandle, BashResult, bash
from .harness import HarnessEntry, HarnessScope, HarnessState, RefinementEvent, get_harness_state

class _RecordAccess:
    """Dict-style reads on the frozen records, which models often reach for."""

    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)

    def __getitem__(self, key: str) -> Any:
        try:
            return getattr(self, key)
        except AttributeError:
            raise KeyError(key) from None


@dataclass(frozen=True)
class RLMSpawnHandle(_RecordAccess):
    rlm_child_id: str
    name: str
    session_dir: Path
    model: str

    @property
    def session_name(self) -> str:
        """The roster/result spelling of ``name``."""
        return self.name


@dataclass(frozen=True)
class RLMModel(_RecordAccess):
    provider: str
    id: str
    name: str
    selector: str


@dataclass(frozen=True)
class RLMSubagent(_RecordAccess):
    rlm_child_id: str
    active_session_id: str | None
    session_id: str | None
    session_name: str
    session_dir: Path
    status: str

    @property
    def name(self) -> str:
        """The spawn handle's spelling of ``session_name``."""
        return self.session_name


@dataclass(frozen=True)
class RLMChildStallAbort:
    """Stall-watchdog kill facts for one child, from `collect()`.

    ``settled`` is False while the watchdog aborted but the run never produced
    ``agent_end``: "killed" is then not yet a fact and the child may recover.
    """

    silent_ms: int
    threshold_ms: int
    in_flight_tools: tuple[str, ...]
    kernel_reasons: tuple[str, ...] | None
    settled: bool


@dataclass(frozen=True)
class RLMChildResult(_RecordAccess):
    """Terminal or in-progress state of one direct child, from `collect()`.

    ``status`` is the raw run status and reads "done" for a child the stall
    watchdog killed, so ``terminal_kind`` / ``stall_abort`` are the fields that
    say how the run actually ended. Both are None while the run is in flight.
    ``activity_kind`` is the live activity (waiting/writing/executing/stalled)
    and the only "still working" signal for a child retained without a run.
    """

    rlm_child_id: str
    session_name: str | None
    session_dir: Path | None
    status: str
    settled: bool
    answer_preview: str | None
    error: str | None
    duration_ms: int | None
    tool_use_count: int | None
    replied_since_task: bool | None
    activity_kind: str | None
    terminal_kind: str | None
    terminal_reason: str | None
    stall_abort: RLMChildStallAbort | None

    @property
    def name(self) -> str | None:
        """The spawn handle's spelling of ``session_name``."""
        return self.session_name


def _spawn_handle_from_payload(payload: Any) -> RLMSpawnHandle:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    child_id = payload.get("rlm_child_id")
    name = payload.get("name")
    session_dir = payload.get("session_dir")
    model = payload.get("model")
    if not all(isinstance(value, str) and value for value in (child_id, name, session_dir, model)):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    return RLMSpawnHandle(
        rlm_child_id=child_id,
        name=name,
        session_dir=Path(session_dir),
        model=model,
    )


def _parse_host_reply(request_type: str, reply: dict[str, Any]) -> dict[str, Any]:
    status = reply.get("status")
    if status == "ok":
        return reply["result"]
    if status == "error":
        raise RuntimeError(str(reply.get("error") or f"host request {request_type} failed"))
    raise RuntimeError(f"host request {request_type} returned unexpected status: {status!r}")


async def host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send a typed request to the Prime Agent host and await its reply.

    This is the kernel side of the generic host bridge: Python skills call
    ``await host_request("<type>", {...})`` and the TypeScript host dispatches
    on the type. Raises RuntimeError when the host reports an error or when no
    handler for the type is registered in this session.
    """
    if not isinstance(request_type, str) or not request_type:
        raise TypeError("request_type must be a non-empty str")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError(f"payload must be a dict or None, got {type(payload).__name__}")
    from . import repl

    # request_type goes last so a payload "type" key cannot reroute the request.
    reply = await repl.host_request({**(payload or {}), "type": request_type})
    return _parse_host_reply(request_type, reply)


def emit(data: dict[str, Any]) -> None:
    """Ship one display event (dict of MIME type -> JSON payload) to the host."""
    from . import repl

    repl.emit(data)


async def run(prompt: str, **kwargs: Any) -> RLMSpawnHandle:
    """Spawn a recursive Prime Agent child and return once its task is admitted.

    ``model`` selects a child with an exact ``provider/model`` selector. Without it
    the child inherits this session's current model — a mid-session model switch
    changes what an unpinned spawn resolves to — unless the user's settings pin a
    subagent default model; the returned handle's ``model`` field carries the
    resolved selector, so check it when the choice matters.
    ``thinking`` sets the child reasoning level (e.g. 'off', 'low', 'medium', 'high');
    defaults to the parent level; levels invalid for the resolved model fail the spawn.
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    # Display-only step for the host's live feed: the task while admitting, the child's name once admitted.
    step = _effects.step("subagent", prompt)
    try:
        payload = await host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
        handle = _spawn_handle_from_payload(payload)
    except BaseException as exc:
        step.finish("error", f"{type(exc).__name__}: {exc}")
        raise
    # `name` is the child's exact session name, untouched by the display-only
    # label pipeline (blank collapse, clip): the host's timeline and handoff
    # ledger key subagent rows by the session name, and a rewritten label left
    # them matching against a name that never existed. A name the secret scan
    # would redact stays off the record (name_safe_to_record) rather than
    # persisting what it looked like; those rows keep today's label fallback.
    extra = {"name": handle.name} if _effects.name_safe_to_record(handle.name) else {}
    step.finish("ok", handle.model, label=handle.name, extra=extra)
    return handle


def _model_from_payload(payload: Any) -> RLMModel:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    provider = payload.get("provider")
    model_id = payload.get("id")
    name = payload.get("name")
    selector = payload.get("selector")
    if not all(isinstance(value, str) and value for value in (provider, model_id, name, selector)):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    return RLMModel(provider=provider, id=model_id, name=name, selector=selector)


async def find_models(query: str = "", limit: int = 8) -> list[RLMModel]:
    """Search a bounded list of models backed by active user credentials."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    if not isinstance(limit, int):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    payload = await host_request("rlm.find_models", {"query": query, "limit": limit})
    models = payload.get("models")
    if not isinstance(models, list):
        raise RuntimeError("rlm.find_models returned an invalid models list")
    return [_model_from_payload(model) for model in models]


def _subagent_from_payload(payload: Any, operation: str = "rlm.list_subagents") -> RLMSubagent:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{operation} returned an invalid subagent entry")
    child_id = payload.get("rlm_child_id")
    active_session_id = payload.get("active_session_id")
    session_id = payload.get("session_id")
    session_name = payload.get("session_name")
    session_dir = payload.get("session_dir")
    status = payload.get("status")
    if not isinstance(child_id, str) or not child_id:
        raise RuntimeError(f"{operation} entry is missing rlm_child_id")
    if active_session_id is not None and not isinstance(active_session_id, str):
        raise RuntimeError(f"{operation} entry has invalid active_session_id")
    if session_id is not None and not isinstance(session_id, str):
        raise RuntimeError(f"{operation} entry has invalid session_id")
    if not isinstance(session_name, str) or not session_name:
        raise RuntimeError(f"{operation} entry is missing session_name")
    if not isinstance(session_dir, str) or not session_dir:
        raise RuntimeError(f"{operation} entry is missing session_dir")
    if status not in {"running", "completed", "error"}:
        raise RuntimeError(f"{operation} entry has invalid status")
    return RLMSubagent(
        rlm_child_id=child_id,
        active_session_id=active_session_id,
        session_id=session_id,
        session_name=session_name,
        session_dir=Path(session_dir),
        status=status,
    )


async def list_subagents(include_terminal: bool = False) -> list[RLMSubagent]:
    """List direct RLM children tracked by the current parent session.

    The default view is the active roster: children still queued or running.
    Pass ``include_terminal=True`` to also list children whose run reached a
    terminal state (completed or error); terminal children stay addressable
    through ``collect`` and ``delete_subagent`` either way. The flag is omitted
    from the wire when false, so a host that predates the roster split sees the
    request shape it always did.
    """
    if not isinstance(include_terminal, bool):
        raise TypeError(f"include_terminal must be bool, got {type(include_terminal).__name__}")
    if include_terminal:
        payload = await host_request("rlm.list_subagents", {"include_terminal": True})
    else:
        payload = await host_request("rlm.list_subagents")
    entries = payload.get("subagents")
    if not isinstance(entries, list):
        raise RuntimeError("rlm.list_subagents returned an invalid subagents registry")
    return [_subagent_from_payload(entry) for entry in entries]


_RLM_CHILD_RUN_STATUSES = frozenset({"queued", "running", "done", "error", "cancelled"})
_RLM_CHILD_TERMINAL_KINDS = frozenset(
    {"stall_killed", "aborted", "error", "cancelled", "completed_without_reply", "none"}
)


def _target_selector(target: Any, operation: str) -> str:
    """Normalize a child selector: spawn handle, subagent row, or a name/id string."""
    if isinstance(target, (RLMSpawnHandle, RLMSubagent)):
        return target.rlm_child_id
    if isinstance(target, str) and target.strip():
        return target.strip()
    raise TypeError(
        f"{operation} target must be RLMSpawnHandle, RLMSubagent, or non-empty str, got {type(target).__name__}"
    )


def _target_selectors(targets: Any, operation: str) -> list[str]:
    """Normalize the shared ``targets`` argument: None/empty means every direct child."""
    if targets is None:
        return []
    if isinstance(targets, (RLMSpawnHandle, RLMSubagent, str)):
        return [_target_selector(targets, operation)]
    if isinstance(targets, (list, tuple)):
        return [_target_selector(target, operation) for target in targets]
    raise TypeError(f"targets must be None, a target, or a list of targets, got {type(targets).__name__}")


async def prune_subagents(targets: Any = None) -> list[RLMSubagent]:
    """Retire terminal direct children from the roster views; returns the pruned rows.

    Pruning is registry bookkeeping, not deletion: a pruned child keeps its
    transcript, its ``collect`` result, and its ``delete_subagent`` selector, and
    a child the parent re-engages (a follow-up turn) leaves the pruned set on its
    own. Running children are refused - pruning is not cancellation. ``targets``
    selects children like ``collect`` does (spawn handles, subagent rows, or
    name/id strings); ``None`` (or an empty list) retires every terminal child.
    """
    selectors = _target_selectors(targets, "prune")
    payload = await host_request("rlm.prune_subagents", {"targets": selectors})
    pruned = payload.get("pruned")
    if not isinstance(pruned, list):
        raise RuntimeError("rlm.prune_subagents returned an invalid pruned list")
    return [_subagent_from_payload(entry, "rlm.prune_subagents") for entry in pruned]


def _optional_str(payload: dict[str, Any], field: str) -> str | None:
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise RuntimeError(f"rlm.collect entry has invalid {field}")
    return value


def _optional_int(payload: dict[str, Any], field: str) -> int | None:
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"rlm.collect entry has invalid {field}")
    return value


def _stall_abort_from_payload(payload: Any) -> RLMChildStallAbort | None:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.collect entry has invalid stall_abort")
    silent_ms = payload.get("silent_ms")
    threshold_ms = payload.get("threshold_ms")
    for field, value in (("silent_ms", silent_ms), ("threshold_ms", threshold_ms)):
        if not isinstance(value, int) or isinstance(value, bool):
            raise RuntimeError(f"rlm.collect stall_abort has invalid {field}")
    in_flight = payload.get("in_flight_tools")
    if not isinstance(in_flight, list) or any(not isinstance(tool, str) for tool in in_flight):
        raise RuntimeError("rlm.collect stall_abort has invalid in_flight_tools")
    kernel_reasons = payload.get("kernel_reasons")
    if kernel_reasons is not None and (
        not isinstance(kernel_reasons, list) or any(not isinstance(reason, str) for reason in kernel_reasons)
    ):
        raise RuntimeError("rlm.collect stall_abort has invalid kernel_reasons")
    settled = payload.get("settled")
    if not isinstance(settled, bool):
        raise RuntimeError("rlm.collect stall_abort has invalid settled flag")
    return RLMChildStallAbort(
        silent_ms=silent_ms,
        threshold_ms=threshold_ms,
        in_flight_tools=tuple(in_flight),
        kernel_reasons=tuple(kernel_reasons) if kernel_reasons is not None else None,
        settled=settled,
    )


def _child_result_from_payload(payload: Any) -> RLMChildResult:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.collect returned an invalid result entry")
    child_id = payload.get("rlm_child_id")
    if not isinstance(child_id, str) or not child_id:
        raise RuntimeError("rlm.collect entry is missing rlm_child_id")
    status = payload.get("status")
    if status not in _RLM_CHILD_RUN_STATUSES:
        raise RuntimeError("rlm.collect entry has invalid status")
    settled = payload.get("settled")
    if not isinstance(settled, bool):
        raise RuntimeError("rlm.collect entry has invalid settled flag")
    terminal_kind = payload.get("terminal_kind")
    if terminal_kind is not None and terminal_kind not in _RLM_CHILD_TERMINAL_KINDS:
        raise RuntimeError("rlm.collect entry has invalid terminal_kind")
    replied = payload.get("replied_since_task")
    if replied is not None and not isinstance(replied, bool):
        raise RuntimeError("rlm.collect entry has invalid replied_since_task")
    session_dir = _optional_str(payload, "session_dir")
    return RLMChildResult(
        rlm_child_id=child_id,
        session_name=_optional_str(payload, "session_name"),
        session_dir=Path(session_dir) if session_dir else None,
        status=status,
        settled=settled,
        answer_preview=_optional_str(payload, "answer_preview"),
        error=_optional_str(payload, "error"),
        duration_ms=_optional_int(payload, "duration_ms"),
        tool_use_count=_optional_int(payload, "tool_use_count"),
        replied_since_task=replied,
        activity_kind=_optional_str(payload, "activity_kind"),
        terminal_kind=terminal_kind,
        terminal_reason=_optional_str(payload, "terminal_reason"),
        stall_abort=_stall_abort_from_payload(payload.get("stall_abort")),
    )


async def collect(
    targets: Any = None,
    *,
    timeout_ms: int = 0,
) -> list[RLMChildResult]:
    """Collect typed results from direct RLM children.

    ``targets`` selects children: spawn handles, subagent rows, name strings, or a
    list mixing all three. ``None`` (or an empty list) selects every direct child
    that is not being deleted.

    ``timeout_ms`` bounds the wait for the selected children to settle: 0 returns a
    non-blocking snapshot immediately; a positive value blocks only this kernel call
    until the runs settle or the timeout elapses. A timeout returns current
    snapshots, never an error, and the parent session is never steered; the host
    caps one wait at its read-only request budget, so a long ``timeout_ms`` is a
    poll, not a commitment. Completed children keep their result until deleted, so a
    later ``collect`` re-reads them without waiting.

    The request asks the host to end the wait early when an agent message arrives for
    this session (``wake_on_message``; a host that predates message wake ignores the
    field and waits as before). Such a reply carries ``messages_pending`` and is
    surfaced as a printed note plus the ``messages_pending()`` counter, so the model
    can end its turn and receive the message instead of re-arming a long wait.

    Each entry carries ``terminal_kind`` and ``stall_abort`` next to the raw
    ``status``: a child killed by the stall watchdog still reports ``status="done"``,
    and only these two fields distinguish the kill from a child that finished
    without replying.
    """
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or timeout_ms < 0:
        raise TypeError("timeout_ms must be a non-negative int")
    selectors = _target_selectors(targets, "collect")
    payload = await host_request(
        "rlm.collect",
        {"targets": selectors, "timeout_ms": timeout_ms, "wake_on_message": True},
    )
    results = payload.get("results")
    if not isinstance(results, list):
        raise RuntimeError("rlm.collect returned an invalid results list")
    entries = [_child_result_from_payload(entry) for entry in results]
    _note_collect_message_wake(payload.get("messages_pending"))
    return entries


def _note_collect_message_wake(messages_pending: Any) -> None:
    """Surface a host message-wake to the model reading this cell's output.

    The host sets ``messages_pending`` (true, or the pending count) on a collect reply it
    ended early because an agent message arrived for this session. The note prints into the
    cell's own output - the channel the model actually reads. The ledger write depends on
    the channel: once this kernel announced ``message_notify``, a conforming host pushes a
    ``notify`` frame for every admission and those pushes are the ledger's record, so
    recording the reply's count as well would count each arrival twice; without the
    capability no push can arrive and the reply is the only channel, so it records here.
    Anything but a positive count is ignored: a malformed value must not fake a wake.
    """
    if messages_pending is True:
        count = 1
    elif isinstance(messages_pending, int) and not isinstance(messages_pending, bool) and messages_pending > 0:
        count = messages_pending
    else:
        return
    from . import repl

    if repl.CAPABILITY_MESSAGE_NOTIFY not in repl.kernel_capabilities():
        repl.note_message_wake(count)
    print(f"[rlm] {count} agent message(s) pending for this session; end the turn to receive them.")


def messages_pending() -> int:
    """Agent-message arrivals the host pushed (or reported) that are still undelivered.

    A peek: reading the count never drains it. ``wait_messages`` drains, and the host's
    delivery report clears what already entered the conversation.
    """
    from . import repl

    return repl.messages_pending()


async def wait_messages(timeout_ms: int = 0) -> int:
    """Wait until an agent message for this session has arrived; return the pending count.

    This is the wakeable wait for a fan-in loop: a host that announced message-wake support
    pushes a notification the moment a child's ``agent_message`` arrives, and a wait parked
    here returns at that point instead of at the timeout. The message itself is not delivered
    here - it enters the conversation as an ordinary queued prompt at the next turn boundary,
    so end the turn to receive it; the wake only says the wait is over. Returns the number of
    arrivals consumed (0 on timeout), draining the pending count ``messages_pending()`` peeks
    at.
    """
    from . import repl

    return await repl.wait_message_wake(timeout_ms)


async def delete_subagent(target: str | RLMSubagent | RLMSpawnHandle) -> RLMSubagent:
    """Delete one running or retained direct child from the current parent session.

    ``target`` selects the child: the spawn handle returned by ``rlm.spawn``, a
    subagent row from ``list_subagents()``, or a child id/session name string.
    """
    if isinstance(target, RLMSpawnHandle):
        selector = target.rlm_child_id
    elif isinstance(target, RLMSubagent):
        selector = target.rlm_child_id
    elif isinstance(target, str):
        selector = target.strip()
        if not selector:
            raise ValueError("target must not be empty")
    else:
        raise TypeError(
            f"target must be RLMSpawnHandle, RLMSubagent, or str, got {type(target).__name__}"
        )
    payload = await host_request("rlm.delete_subagent", {"target": selector})
    return _subagent_from_payload(payload.get("subagent"), "rlm.delete_subagent")


async def rename(new_name: str, *, session_id: str | RLMSpawnHandle | RLMSubagent | None = None) -> str:
    """Rename this session or one of its direct children.

    Omitting ``session_id`` renames the current session. A spawn handle, a
    ``list_subagents()`` row, or a session id string renames a direct child.
    A child's session *name* is not accepted as a selector (it would resolve
    ambiguously once names drift). Names follow the spawn rules, must be unique
    among siblings, and the renamed session sees a transcript notice.
    """
    if not isinstance(new_name, str):
        raise TypeError(f"new_name must be str, got {type(new_name).__name__}")
    payload: dict[str, Any] = {"name": new_name}
    if session_id is not None:
        payload["session_id"] = _target_selector(session_id, "session_id")
    reply = await host_request("rlm.rename", payload)
    name = reply.get("name")
    if not isinstance(name, str):
        raise RuntimeError("rlm.rename returned an invalid name")
    return name


class _HarnessProxy:
    """Resolve the harness state against the current environment on every access.

    Session env vars may be applied after import, so a state bound at import
    time could freeze an env-less resolution. Resolution must never raise (a
    failure inside the kernel namespace would take down the kernel). When the
    local store is genuinely unconfigured (no session env, e.g. --no-session)
    reads see an empty view but local writes raise instructively instead of
    vanishing on kernel exit; any other resolution failure degrades to a shared
    in-memory store until local resolution starts succeeding.
    """

    _fallback: HarnessState | None = None
    _unpersisted: HarnessState | None = None

    def _resolve(self) -> HarnessState:
        try:
            return get_harness_state()
        except RuntimeError as exc:
            if "Local harness state requires" in str(exc):
                if _HarnessProxy._unpersisted is None:
                    _HarnessProxy._unpersisted = HarnessState(
                        in_memory=True,
                        local_write_error=(
                            f"{exc} This session has no persistent local harness store; "
                            "pass global_=True to persist across sessions."
                        ),
                    )
                return _HarnessProxy._unpersisted
            return self._degraded()
        except Exception:  # pragma: no cover - harness access must never raise
            return self._degraded()

    @staticmethod
    def _degraded() -> HarnessState:
        if _HarnessProxy._fallback is None:
            _HarnessProxy._fallback = HarnessState(in_memory=True)
        return _HarnessProxy._fallback

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resolve(), name)

    def __dir__(self) -> list[str]:
        # Models discover the harness API through dir(); proxy it so the public
        # state methods (search/get/overview/...) show up instead of only this
        # proxy's own underscore-prefixed machinery.
        return [name for name in dir(self._resolve()) if not name.startswith("_")]

    def __repr__(self) -> str:
        return repr(self._resolve())


_harness_state = _HarnessProxy()


class _RLMCallable:
    harness = _harness_state
    get_harness_state = staticmethod(get_harness_state)

    async def run(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)

    async def find_models(self, query: str = "", limit: int = 8) -> list[RLMModel]:
        return await find_models(query, limit)

    async def list_subagents(self, include_terminal: bool = False) -> list[RLMSubagent]:
        return await list_subagents(include_terminal)

    async def prune_subagents(self, targets: Any = None) -> list[RLMSubagent]:
        return await prune_subagents(targets)

    async def collect(self, targets: Any = None, *, timeout_ms: int = 0) -> list[RLMChildResult]:
        return await collect(targets, timeout_ms=timeout_ms)

    async def wait_messages(self, timeout_ms: int = 0) -> int:
        return await wait_messages(timeout_ms)

    def messages_pending(self) -> int:
        return messages_pending()

    async def delete_subagent(self, target: str | RLMSubagent | RLMSpawnHandle) -> RLMSubagent:
        return await delete_subagent(target)

    async def rename(
        self,
        new_name: str,
        *,
        session_id: str | RLMSpawnHandle | RLMSubagent | None = None,
    ) -> str:
        return await rename(new_name, session_id=session_id)

    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


rlm = _RLMCallable()
harness = _harness_state


class _CallableModule(types.ModuleType):
    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "BashHandle",
    "BashResult",
    "HarnessEntry",
    "HarnessScope",
    "HarnessState",
    "McpIntegration",
    "McpToolError",
    "NotEnabled",
    "RLMChildResult",
    "RLMChildStallAbort",
    "RLMModel",
    "RLMSpawnHandle",
    "RLMSubagent",
    "RefinementEvent",
    "bash",
    "collect",
    "delete_subagent",
    "emit",
    "find_models",
    "get_harness_state",
    "harness",
    "host_request",
    "list_subagents",
    "messages_pending",
    "prune_subagents",
    "rlm",
    "rename",
    "run",
    "wait_messages",
]

# Lazily re-export the MCP base class. Kept lazy so `import rlm` never requires
# the optional `mcp` SDK — only integration packages that subclass it do.
_LAZY_MCP = {"McpIntegration", "McpToolError", "NotEnabled"}


def __getattr__(name: str) -> Any:  # noqa: D401 - module-level lazy attr hook
    if name in _LAZY_MCP:
        from . import mcp_base

        return getattr(mcp_base, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
