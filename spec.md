# mcp-local-tunnel

Expose local MCP servers to remote MCP clients — without opening ports.

## Overview

mcp-local-tunnel lets you make local MCP servers (shell, computer-use, filesystem, etc.) accessible remotely. You run a small agent process on your local machine that connects outward to a relay you host. Remote MCP clients can then reach your local tools as if they were hosted cloud services.

```
MCP client (e.g. Claude.ai, Cursor, Claude Code)
    |
    v
relay (tunnel.example.com)                       <-- you host this
    ^
    | (outbound WebSocket from your machine)
    |
agent (npx mcp-local-tunnel)                    <-- runs on your laptop/desktop
    |
    v
local MCP server (shell-exec-mcp, etc.)          <-- stdio or HTTP
```

The key insight: the local machine initiates the connection outward (WebSocket), so there's no need for port forwarding, static IPs, or firewall changes. The relay just bridges incoming MCP requests over that already-open connection.

## Terminology

- **relay**: the server-side component you host somewhere with a public URL. Accepts incoming WebSocket connections from agents, and exposes their tools as a standard Streamable HTTP MCP endpoint (`/mcp`) for MCP clients to consume.
- **agent**: the local process running on your machine. Connects outward to the relay, and proxies MCP requests to one or more local MCP servers.

These terms are used to avoid confusion with "MCP client" and "MCP server", which refer to the protocol-level roles.

## User journeys

### 1. Setting up the relay (one-time)

The relay is deployed as a service with a public URL (e.g. `tunnel.example.com`). It exposes a standard `/mcp` Streamable HTTP endpoint so any MCP client can connect to it directly.

The relay authenticates both MCP clients (via OAuth on `/mcp`) and agents (via OAuth on the WebSocket connection) using an OIDC provider — for example, Home Assistant via hass-oidc-provider, Keycloak, Auth0, etc.

```json
{
  "mode": "relay",
  "auth": {
    "issuer": "https://oidc.example.com"
  },
  "port": 3000,
  "host": "0.0.0.0",
  "issuerUrl": "https://tunnel.example.com",
  "secret": "some-persistent-secret"
}
```

### 2. Running the agent locally

The user creates a config file:

```json
{
  "mode": "agent",
  "relay": "tunnel.example.com",
  "name": "my-laptop",
  "servers": {
    "shell": {
      "command": ["npx", "-y", "shell-exec-mcp"]
    },
    "computer": {
      "command": ["npx", "-y", "computer-use-mcp"]
    },
    "files": {
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/adam/docs"]
    }
  }
}
```

Both modes use the same config loading pattern (following mcp-aggregator and mcp-auth-wrapper):
1. The `MCP_LOCAL_TUNNEL_CONFIG` environment variable — either a raw JSON string (if it starts with `{`) or a path to a JSON file.
2. A `mcp-local-tunnel.config.json` file in the current working directory.

Then just:

```sh
npx mcp-local-tunnel
```

On first run, the agent opens a browser for OIDC login (same identity provider as the relay). The resulting token is cached locally (e.g. in `~/.config/mcp-local-tunnel/`) so subsequent runs don't require re-authentication.

The agent then:
1. Establishes a WebSocket connection to the relay (at `wss://<relay>/ws`), authenticated with the token.
2. Spawns the configured local MCP servers as stdio subprocesses (or connects to them over HTTP if a `url` is given instead of `command`).
3. Aggregates the tools from all configured local servers, prefixed with the names given (e.g. `shell__execute`, `computer__computer`, `files__read_file`).
4. Holds the connection open, proxying MCP requests from the relay to the local servers and responses back.

The agent prints a status line showing the connection state and available tools:

```
Connected to tunnel.example.com as "my-laptop"
Serving 5 tools: shell__execute, computer__computer, files__read_file, ...
```

### 3. What a remote MCP client user sees

From the perspective of someone using Claude.ai or another MCP client connected to the relay, the tunnelled tools appear like any other MCP tools.

When the user calls `tools/list`, they see tools like `shell__execute`, `computer__computer`, `files__read_file` — namespaced by the server names configured in the agent.

Calling these tools works like any normal MCP tool call. The latency is slightly higher (extra hop through the relay + WebSocket), but the interface is identical.

If the agent is not connected (laptop is off, process isn't running), the relay returns only the meta tools (see below). `tools/list` dynamically reflects the current state — when the agent connects, tools appear; when it disconnects, they disappear. No manual refresh needed.

The user doesn't need to do anything special. It just works (when connected) or clearly doesn't (when not).

### 4. Meta tools

The relay exposes meta tools to help users manage the tunnel:

- **`status`**: Shows the current connection state — whether an agent is connected, its name, how long it's been connected, and the list of available tools. Useful for debugging when tools aren't appearing.
- **`restart`**: Asks the agent to restart all of its local MCP server subprocesses and re-aggregate tools. Useful if a local server gets into a bad state, hangs, or the user has changed its configuration.

These are always available regardless of whether an agent is connected.

### 5. Reconnection and resilience

The agent automatically reconnects if the WebSocket connection drops (network change, server restart, laptop sleep/wake). It uses exponential backoff and logs reconnection attempts.

When it reconnects, the relay immediately picks up the new connection and starts routing requests through it. No user action needed.

### 6. Multiple users

The relay supports multiple concurrent users, each with their own agent connection. Since authentication is per-user (via OIDC), the relay knows which connection belongs to which user. When an MCP client makes a request authenticated as a particular user, the relay routes it to that user's agent.

This means two people could each run their own agent, and their tools would be isolated — Adam's `files__read_file` reads Adam's files, not someone else's.

### 7. Multiple devices per user

A user might want to expose tools from both their laptop and their desktop. The `name` field distinguishes connections:

```json
// On laptop: mcp-local-tunnel.config.json
{
  "mode": "agent",
  "relay": "tunnel.example.com",
  "name": "laptop",
  "servers": {
    "shell": { "command": ["npx", "-y", "shell-exec-mcp"] }
  }
}

// On desktop: mcp-local-tunnel.config.json
{
  "mode": "agent",
  "relay": "tunnel.example.com",
  "name": "desktop",
  "servers": {
    "shell": { "command": ["npx", "-y", "shell-exec-mcp"] }
  }
}
```

The relay merges these, and the tools appear with device-scoped names:
- `laptop__shell__execute`
- `desktop__shell__execute`

Or, if there's only one device connected, the device name could be omitted from the prefix for simplicity.

### 8. Use with mcp-aggregator

The relay exposes a standard `/mcp` Streamable HTTP endpoint, so it works as an upstream in mcp-aggregator just like any other MCP server. The aggregator doesn't know or care that the tools are actually being served from someone's laptop — it just sees another upstream with tools.

## Configuration reference

Configuration is loaded from (in order):
1. The `MCP_LOCAL_TUNNEL_CONFIG` environment variable — either a raw JSON string (if it starts with `{`) or a path to a JSON file.
2. A `mcp-local-tunnel.config.json` file in the current working directory.

### Shared fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `mode` | Yes | — | `"relay"` or `"agent"`. |

### Agent mode fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `relay` | Yes | — | Domain of the relay server (e.g. `tunnel.example.com`). The agent connects to `wss://<relay>/ws`. |
| `name` | No | hostname | Name for this device. Used to distinguish multiple devices per user. |
| `servers` | Yes | — | Map of local MCP servers to expose. Keys become tool name prefixes. |
| `servers.<name>.command` | — | — | Command array to spawn a stdio MCP server (e.g. `["npx", "-y", "shell-exec-mcp"]`). |
| `servers.<name>.url` | — | — | URL of an already-running HTTP MCP server (e.g. `http://localhost:3001/mcp`). Provide either `command` or `url`, not both. |
| `servers.<name>.env` | No | — | Extra environment variables to set when spawning the command. |

### Relay mode fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `auth.issuer` | Yes | — | OIDC provider URL. |
| `auth.clientId` | No | `"mcp-local-tunnel"` | OAuth client ID. |
| `auth.clientSecret` | No | — | OAuth client secret. |
| `auth.scopes` | No | `["openid"]` | Scopes to request. |
| `auth.userClaim` | No | `"sub"` | JWT claim for user identity. |
| `port` | No | `3000` | Listen port. |
| `host` | No | `"0.0.0.0"` | Bind address. |
| `issuerUrl` | No | — | Public URL for the relay (when behind a reverse proxy). |
| `secret` | No | random | Token encryption key. |

## Key requirements

### Functional
- Local MCP servers are reachable from remote clients without any port forwarding or firewall changes.
- Supports wrapping any stdio-based MCP server (spawns as subprocess).
- Supports connecting to already-running HTTP MCP servers on localhost.
- Tools from all configured local servers are aggregated and namespaced.
- `tools/list` dynamically reflects connected agents — no manual refresh needed.
- Meta tools (`status`, `restart`) for observability and recovery.
- Relay exposes standard Streamable HTTP `/mcp` endpoint — works standalone or as an upstream in mcp-aggregator.

### Reliability
- Automatic reconnection with backoff on connection loss.
- Handles laptop sleep/wake, network changes, server restarts.
- Clear feedback to the local user about connection status.
- Clear error messages to remote clients when no agent is connected.

### Security
- The agent initiates all connections outward — no inbound ports needed.
- Authentication required for both the WebSocket connection (agent) and the Streamable HTTP endpoint (MCP clients).
- Each user's tools are isolated — one user cannot access another user's agent.
- The relay does not cache or inspect tool call payloads beyond routing.

### User experience
- Single `npx` command to get started, no install step required.
- JSON config file following the same pattern as mcp-aggregator and mcp-auth-wrapper.
- Browser-based OIDC login on first run, then token is cached.
- Status output showing connection state and available tools.
- Minimal configuration — sensible defaults where possible.
