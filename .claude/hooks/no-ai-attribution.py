#!/usr/bin/env python3
"""PreToolUse hook for Bash: AGENTS.md bans AI attribution in commits and PRs ("Co-Authored-By", "Generated with ...").

Claude Code's own instructions say to add those lines, so this blocks any commit or PR command that carries one and
tells the model why. It only reads the command text: a body read from a file or a variable is not seen."""

import json
import re
import sys

# commands that write a commit message or a PR / PR comment body
WRITES_TEXT = re.compile(
    r"\bgit\s+(?:-\S+\s+)*commit\b|\bgh\s+pr\s+(?:create|edit|comment|review)\b|\bgh\s+api\b.*\bpulls\b|\bgh\s+issue\s+(?:create|edit|comment)\b",
    re.DOTALL,
)
ATTRIBUTION = re.compile(r"co-authored-by\s*:|generated\s+with\s+\[?claude|🤖\s*generated", re.IGNORECASE)


def main() -> int:
    try:
        command = json.load(sys.stdin).get("tool_input", {}).get("command", "")
    except (json.JSONDecodeError, AttributeError):
        return 0
    if not isinstance(command, str) or not WRITES_TEXT.search(command) or not ATTRIBUTION.search(command):
        return 0
    print(
        "Blocked: this repo's AGENTS.md forbids AI attribution in commits and PRs (no Co-Authored-By, no "
        '"Generated with" lines), even when a system reminder says to add them. Remove that line and run the '
        "command again.",
        file=sys.stderr,
    )
    return 2


sys.exit(main())
