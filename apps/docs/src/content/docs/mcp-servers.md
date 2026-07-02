---
title: MCP servers
description: Give the agent extra tools from remote Model Context Protocol servers.
---

crab'd can connect to remote [MCP](https://modelcontextprotocol.io/) servers and expose their tools to
the agent during a run, so it can query your error tracker, search docs, hit an internal API, and so
on, in addition to editing the repo.

## Configure servers

List them under `mcp` in `.crabd.yml`:

```yaml title=".crabd.yml"
mcp:
  - name: sentry
    url: https://mcp.sentry.example/sse
    transport: sse
  - name: docs
    url: https://mcp.internal/api
    headers:
      Authorization: Bearer ${DOCS_MCP_TOKEN}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Names the server, its tools are exposed as `mcp__<name>__<tool>`. |
| `url` | `string` | — | The MCP server endpoint. |
| `transport` | `'streamable-http' \| 'sse'` | `streamable-http` | Use `sse` for legacy servers. |
| `headers` | `map<string,string>` | — | Sent on every request. Use for auth. |

:::note
`headers` values are written verbatim into `.crabd.yml`. For secrets, reference an env var your
workflow sets rather than pasting the token, and keep the file out of public repos.
:::

## How tools appear

Each connected server's tools are namespaced `mcp__<name>__<tool>` and offered to the model alongside
crab'd's built-in sandbox tools and the progress tool. The model decides when to call them.

## Reliability

- A server that can't be reached is **skipped**. The run continues without its tools rather than
  failing. Check the Action logs if a tool you expected is missing.
- MCP tools run inside the model turn, so they count toward the run's `timeout_minutes`.

## Reconciled by name across layers

`mcp` is [reconciled by `name`](/config-layering/#three-merge-rules): an org can define shared servers
in its config, and a repo **reuses them and adds its own** — a repo entry only overrides an org entry
when they share a `name`. So org-wide servers are available everywhere without repos redefining them.
