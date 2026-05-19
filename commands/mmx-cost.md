---
description: Summarize MiniMax MCP delegation cost from server.log
allowed-tools: Bash(python3:*)
argument-hint: "[days_back]"
---

Run `python3 ${CLAUDE_PLUGIN_ROOT}/mcp-server/scripts/mmx-cost.py $ARGUMENTS` and show the user the output verbatim. The script summarizes MiniMax delegation usage from `~/.minimax-mcp/server.log`. Default window is today; pass an integer like `/mmx-cost 7` for a wider window.
