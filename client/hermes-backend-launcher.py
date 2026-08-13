"""Start the narrow Hermes backend used by the Command Center relay client.

The normal ``hermes serve`` command also performs first-launch skills seeding
and background MCP discovery. Those are useful for Hermes's own dashboard, but
they are unrelated to the relay's bounded chat transport and can delay the
ready signal while another Hermes process holds the shared log lock. The relay
client uses this launcher only for its local, loopback-authenticated backend.
"""

from __future__ import annotations

import sys

import hermes_cli.main as hermes_main
import hermes_cli.mcp_startup as mcp_startup


def main() -> None:
    hermes_main._sync_bundled_skills_quietly = lambda: None
    mcp_startup.start_background_mcp_discovery = lambda **_kwargs: None
    arguments = sys.argv[1:]
    if not arguments or arguments[0] != "serve":
        arguments = ["serve", *arguments]
    sys.argv = ["hermes", *arguments]
    hermes_main.main()


if __name__ == "__main__":
    main()
