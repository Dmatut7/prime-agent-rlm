"""Prime Agent session-to-session messaging skill.

All routing and sender identity live in the TypeScript daemon. These functions
only call the host bridge exposed inside the Prime Agent kernel.
"""

from __future__ import annotations

from typing import Any, Literal
from uuid import uuid4

from rlm import host_request

ReceiverRole = Literal["parent", "sibling", "child"]
_MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json"


async def list_agents() -> dict[str, Any]:
    """List this agent's family in this skill's legacy shape; the same members agent_observe.list_agents() returns."""
    return await host_request("agent_message.list_agents")


async def send(
    message: str,
    broadcast_message: str | None = None,
    *,
    receiver_role: ReceiverRole | str | None = None,
    receiver_name: str | None = None,
) -> dict[str, Any]:
    """Send one direct role-addressed message or broadcast to ``"all"``."""
    roles = ("parent", "sibling", "child")
    if broadcast_message is not None:
        if message != "all":
            raise TypeError(
                "positional agent_message.send targets are not supported; "
                "use receiver_role and receiver_name"
            )
        if receiver_role is not None or receiver_name is not None:
            raise TypeError("broadcast cannot be combined with receiver_role/receiver_name")
        payload: dict[str, Any] = {
            "target": "all",
            "message": broadcast_message,
        }
    else:
        if receiver_role not in roles:
            raise ValueError('receiver_role must be "parent", "sibling", or "child"')
        if not isinstance(message, str):
            raise TypeError(f"message must be str, got {type(message).__name__}")
        if receiver_role == "parent":
            if receiver_name is not None:
                raise ValueError("receiver_name must be omitted for parent messages")
        elif not isinstance(receiver_name, str) or not receiver_name.strip():
            raise ValueError("receiver_name is required for sibling and child messages")
        payload = {
            "message": message,
            "receiver_role": receiver_role,
            "receiver_name": receiver_name,
        }
    # One id per call, minted by the sender (C15 first half). The host delivers a given
    # message_id at most once, so a transport-level repeat - or a retry of a call whose reply was
    # lost - cannot deliver the same message twice. Absent on an older host: it generates one
    # itself, which behaves exactly like before.
    payload["message_id"] = uuid4().hex
    receipt = await host_request("agent_message.send", payload)
    receipts = receipt.get("receipts") if isinstance(receipt, dict) else None
    if isinstance(receipts, list):
        for item in receipts:
            if isinstance(item, dict) and "deliveryStatus" in item:
                _emit_sent_message(item)
    else:
        _emit_sent_message(receipt, receiver_role)
    return receipt


def _emit_sent_message(receipt: dict[str, Any], receiver_role: str | None = None) -> None:
    try:
        from rlm import emit

        if receipt.get("duplicateSuppressed"):
            # The host already handled this message_id: nothing was delivered a second time.
            label = "Agent message duplicate suppressed (already delivered once)"
        elif receipt.get("deliveryStatus") == "queued":
            label = "Agent message queued"
        else:
            label = "Agent message sent"
        display_receipt = dict(receipt)
        if receiver_role in ("parent", "sibling", "child"):
            display_receipt["receiverRole"] = receiver_role
        emit(
            {
                _MESSAGE_DISPLAY_MIME: display_receipt,
                "text/plain": label,
            }
        )
    except Exception:
        pass


async def abort(
    receiver_role: ReceiverRole | str,
    receiver_name: str | None = None,
    *,
    send_queued: bool = True,
) -> dict[str, Any]:
    """Abort one family target's active run without deleting the agent.

    Use this when a child or sibling is stuck mid-turn: the target's active run
    stops, the agent itself stays alive with its context, and (with
    ``send_queued=True``, the default) its queued steering messages are delivered
    in one new turn. With ``send_queued=False`` the abort leaves the queue
    untouched, matching a plain interrupt.

    Falls back loudly: on a daemon too old to serve agent aborts the call raises
    with a message naming the missing capability and no abort is issued.
    """
    roles = ("parent", "sibling", "child")
    if receiver_role not in roles:
        raise ValueError('receiver_role must be "parent", "sibling", or "child"')
    if receiver_role == "parent":
        if receiver_name is not None:
            raise ValueError("receiver_name must be omitted for parent targets")
    elif not isinstance(receiver_name, str) or not receiver_name.strip():
        raise ValueError("receiver_name is required for sibling and child targets")
    payload: dict[str, Any] = {
        "receiver_role": receiver_role,
        "receiver_name": receiver_name,
        "send_queued": send_queued,
    }
    receipt = await host_request("agent_message.abort", payload)
    _emit_abort_message(receipt, receiver_role)
    return receipt


def _emit_abort_message(receipt: dict[str, Any], receiver_role: str | None = None) -> None:
    try:
        from rlm import emit

        resumed = receipt.get("resumedQueued") is True
        label = (
            "Agent message abort (queued work flushed into a new turn)"
            if resumed
            else "Agent message abort (active run stopped)"
        )
        display_receipt = dict(receipt) if isinstance(receipt, dict) else {}
        if receiver_role in ("parent", "sibling", "child"):
            display_receipt["receiverRole"] = receiver_role
        emit(
            {
                _MESSAGE_DISPLAY_MIME: display_receipt,
                "text/plain": label,
            }
        )
    except Exception:
        pass
