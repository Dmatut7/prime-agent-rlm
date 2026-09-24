"""Let PyYAML's safe dumper write the runtime's ``str`` subclasses as plain strings.

``OutputText`` and ``AwaitableText`` subclass ``str`` only to tolerate a call or an
``await``. ``yaml.safe_dump`` looks representers up by exact type, so without this it
raises ``cannot represent an object`` for a bash output or a harness overview. PyYAML
is optional: when it is not importable nothing is registered.
"""

from __future__ import annotations


def register_plain_str(cls: type) -> None:
    try:
        import yaml
    except Exception:  # noqa: BLE001 - optional dependency, any import failure means "absent"
        return
    for dumper in (yaml.SafeDumper, yaml.Dumper):
        dumper.add_representer(cls, yaml.representer.SafeRepresenter.represent_str)
