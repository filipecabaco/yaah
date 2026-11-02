#!/bin/sh
# A tiny stdio MCP server for the tests in src/mcp_servers.rs: answers
# `initialize` and a two-page `tools/list` with canned replies, ignores
# notifications, refuses anything else. Requests arrive as compact JSON, one
# per line (serde_json's output), so plain pattern matching is enough.
echo "fixture: up" >&2
# Not JSON-RPC: clients should skip stray stdout lines.
echo "mcp fixture ready"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"hello"}}\n'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"%s"}}}\n' "$id" "${FIXTURE_VERSION:-0.0.0}"
      ;;
    *'"method":"tools/list"'*'"cursor":"p2"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"add","inputSchema":{"type":"object"}}]}}\n' "$id"
      ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echo the input back","inputSchema":{"type":"object"}}],"nextCursor":"p2"}}\n' "$id"
      ;;
    *'"id":'*)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"method not found"}}\n' "$id"
      ;;
  esac
done
