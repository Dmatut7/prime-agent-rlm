"""Let PyYAML's safe dumper write the runtime's ``str``/``list`` subclasses plainly.

``OutputText`` and ``AwaitableText`` subclass ``str`` only to tolerate a call or an
``await``; ``AwaitableSearchHits`` subclasses ``list`` for the same reason.
``yaml.safe_dump`` looks representers up by exact type, so without this it
raises ``cannot represent an object`` for a bash output, a harness overview, or a
search hit list. PyYAML is optional: when it is not importable nothing is registered.
"""

from __future__ import annotations


def register_plain_str(cls: type) -> None:
    try:
        import yaml
    except Exception:  # noqa: BLE001 - optional dependency, any import failure means "absent"
        return
    for dumper in (yaml.SafeDumper, yaml.Dumper):
        dumper.add_representer(cls, yaml.representer.SafeRepresenter.represent_str)


def register_plain_list(cls: type) -> None:
    """Same escape hatch for the runtime's ``list`` subclass (search hits)."""
    try:
        import yaml
    except Exception:  # noqa: BLE001 - optional dependency, any import failure means "absent"
        return
    for dumper in (yaml.SafeDumper, yaml.Dumper):
        dumper.add_representer(cls, yaml.representer.SafeRepresenter.represent_list)
