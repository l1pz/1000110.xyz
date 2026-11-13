"""The image must contain every module the service imports. Once an explicit COPY list forgot a new module, the tests
passed in CI, and the deployed container crash-looped on an ImportError."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def copied_sources() -> list[str]:
    text = (ROOT / "Dockerfile").read_text(encoding="utf-8").replace("\\\n", " ")
    sources: list[str] = []
    for line in text.splitlines():
        match = re.match(r"\s*COPY\s+(.+)", line)
        if match:
            *srcs, _dest = match.group(1).split()
            sources += srcs
    return sources


def test_every_module_is_copied_into_the_image():
    sources = copied_sources()
    modules = sorted(p.name for p in ROOT.glob("*.py"))
    assert modules, "no modules found next to the Dockerfile"
    if "*.py" in sources:
        return
    missing = [m for m in modules if m not in sources]
    assert not missing, f"the Dockerfile does not copy: {missing}"
