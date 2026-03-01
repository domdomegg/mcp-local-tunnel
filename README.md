# mcp-local-tunnel

> Expose local [MCP servers](https://modelcontextprotocol.io/) to remote clients — without opening ports.

Want to use local tools like [shell-exec-mcp](https://github.com/domdomegg/shell-exec-mcp), [computer-use-mcp](https://github.com/domdomegg/computer-use-mcp), or a filesystem server from a remote MCP client like Claude.ai? Normally you'd need port forwarding, a static IP, or a VPN. mcp-local-tunnel removes all of that.

You run a **relay** on a server with a public URL, and an **agent** on your local machine. The agent connects outward to the relay over WebSocket — no inbound ports needed. The relay exposes a standard [streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) MCP endpoint with [OAuth 2.1](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) auth, so any MCP client can connect to it.

```
MCP client (Claude.ai, Cursor, etc.)
    |
    v
relay (tunnel.example.com)            you host this
    ^
    | outbound WebSocket
    |
agent (npx mcp-local-tunnel)          your laptop
    |
    v
local MCP servers                     stdio or HTTP
```

Both the relay and agent are the same `mcp-local-tunnel` package — you just set `"mode": "relay"` or `"mode": "agent"` in the config. It also works as an upstream in [mcp-aggregator](https://github.com/domdomegg/mcp-aggregator) — the aggregator just sees another MCP server with tools.

## Usage

### Relay

Set `MCP_LOCAL_TUNNEL_CONFIG` to a JSON config object and run:

```bash
MCP_LOCAL_TUNNEL_CONFIG='{
  "mode": "relay",
  "auth": {"issuer": "https://auth.example.com"}
}' npx -y mcp-local-tunnel
```

This starts an HTTP MCP server on localhost:3000. MCP clients connect to `/mcp` with OAuth. Agents connect to `/ws` with a bearer token.

<details>
<summary>Other configuration methods</summary>

The env var can also point to a file path:

```bash
MCP_LOCAL_TUNNEL_CONFIG=/path/to/config.json npx -y mcp-local-tunnel
```

Or create `mcp-local-tunnel.config.json` in the working directory — it's picked up automatically:

```bash
npx -y mcp-local-tunnel
```

</details>

<details>
<summary>Running with Docker</summary>

```bash
docker run -e 'MCP_LOCAL_TUNNEL_CONFIG={"mode":"relay","auth":{"issuer":"..."}}' -p 3000:3000 ghcr.io/domdomegg/mcp-local-tunnel
```

</details>

### Agent

```bash
MCP_LOCAL_TUNNEL_CONFIG='{
  "mode": "agent",
  "relay": "tunnel.example.com",
  "servers": {
    "shell": {"command": ["npx", "-y", "shell-exec-mcp"]},
    "computer": {"command": ["npx", "-y", "computer-use-mcp"]}
  }
}' npx -y mcp-local-tunnel
```

The agent spawns the configured local MCP servers, connects to the relay, and registers all their tools. Remote clients see tools like `shell__execute` and `computer__computer` — namespaced by server name.

If the agent disconnects (laptop sleeps, network drops), it automatically reconnects with exponential backoff.

### Config

Both modes use the same config loading: `MCP_LOCAL_TUNNEL_CONFIG` env var (JSON string or file path), or `mcp-local-tunnel.config.json` in the working directory.

#### Shared

| Field | Required | Description |
|-------|----------|-------------|
| `mode` | Yes | `"relay"` or `"agent"`. |

#### Relay mode

Only `mode` and `auth.issuer` are required. Everything else has sensible defaults.

| Field | Required | Description |
|-------|----------|-------------|
| `auth.issuer` | Yes | Your login provider's URL. Must support [OpenID Connect discovery](https://openid.net/specs/openid-connect-discovery-1_0.html). |
| `auth.clientId` | No | Client ID registered with your login provider. Defaults to `"mcp-local-tunnel"`. |
| `auth.clientSecret` | No | Client secret. Omit for public clients. |
| `auth.scopes` | No | Scopes to request during login. Defaults to `["openid"]`. |
| `auth.userClaim` | No | Which field from the login token identifies the user. Defaults to `"sub"`. |
| `port` | No | Port to listen on. Defaults to `3000`. |
| `host` | No | Host to bind to. Defaults to `"0.0.0.0"`. |
| `issuerUrl` | No | Public URL of this server. Required when behind a reverse proxy. |
| `secret` | No | Signing key for tokens. Random if not set. Set a fixed value to survive restarts. |

A full relay example:

```json
{
  "mode": "relay",
  "auth": {
    "issuer": "https://keycloak.example.com/realms/myrealm",
    "clientId": "mcp-local-tunnel",
    "clientSecret": "optional-secret"
  },
  "port": 3000,
  "host": "0.0.0.0",
  "issuerUrl": "https://tunnel.example.com",
  "secret": "some-persistent-secret"
}
```

#### Agent mode

Only `mode`, `relay`, and `servers` are required.

| Field | Required | Description |
|-------|----------|-------------|
| `relay` | Yes | Domain of the relay server (e.g. `tunnel.example.com`). The agent connects to `wss://<relay>/ws`. |
| `name` | No | Name for this device. Defaults to the machine hostname. Used to distinguish multiple devices per user. |
| `servers` | Yes | Map of local MCP servers to expose. Keys become tool name prefixes. |
| `servers.<name>.command` | — | Command array to spawn a stdio MCP server (e.g. `["npx", "-y", "shell-exec-mcp"]`). |
| `servers.<name>.url` | — | URL of an already-running HTTP MCP server. Provide either `command` or `url`, not both. |
| `servers.<name>.env` | No | Extra environment variables to set when spawning the command. |

A full agent example:

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

### Login provider examples

<details>
<summary>Google Workspace</summary>

```json
{
  "mode": "relay",
  "auth": {
    "issuer": "https://accounts.google.com",
    "clientId": "...",
    "clientSecret": "..."
  }
}
```

Create OAuth 2.0 credentials in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Choose "Web application", add `https://<relay-host>/callback` as an authorized redirect URI. To restrict access to your organization, configure the OAuth consent screen as "Internal".

</details>

<details>
<summary>Microsoft Entra ID</summary>

```json
{
  "mode": "relay",
  "auth": {
    "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
    "clientId": "...",
    "clientSecret": "..."
  }
}
```

Register an application in the [Azure portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps). Add `https://<relay-host>/callback` as a redirect URI under "Web". Create a client secret under "Certificates & secrets". Replace `<tenant-id>` with your directory (tenant) ID.

</details>

<details>
<summary>Okta</summary>

```json
{
  "mode": "relay",
  "auth": {
    "issuer": "https://your-org.okta.com",
    "clientId": "...",
    "clientSecret": "..."
  }
}
```

Create a Web Application in Okta. Set the sign-in redirect URI to `https://<relay-host>/callback`. The issuer URL is your Okta org URL (or a custom authorization server URL if you use one).

</details>

<details>
<summary>Keycloak</summary>

```json
{
  "mode": "relay",
  "auth": {
    "issuer": "https://keycloak.example.com/realms/myrealm",
    "clientSecret": "..."
  }
}
```

Create an OpenID Connect client in your Keycloak realm with client ID `mcp-local-tunnel` (or set `auth.clientId` to match). Set the redirect URI to `https://<relay-host>/callback`. Users are identified by `sub` (Keycloak user ID) by default. Set `auth.userClaim` to `preferred_username` to match by username instead.

</details>

<details>
<summary>Auth0</summary>

```json
{
  "mode": "relay",
  "auth": {
    "issuer": "https://your-tenant.auth0.com",
    "clientId": "...",
    "clientSecret": "..."
  }
}
```

Create a Regular Web Application in Auth0. Add `https://<relay-host>/callback` as an allowed callback URL. Set `auth.clientId` to the Auth0 application's client ID. The `sub` claim in Auth0 is typically prefixed with the connection type (e.g. `auth0|abc123`).

</details>

<details>
<summary>Authentik</summary>

```json
{
  "mode": "relay",
  "auth": {
    "issuer": "https://authentik.example.com/application/o/myapp/",
    "clientSecret": "...",
    "userClaim": "preferred_username"
  }
}
```

Create an OAuth2/OpenID Provider in Authentik with client ID `mcp-local-tunnel` (or set `auth.clientId` to match). Set the redirect URI to `https://<relay-host>/callback`.

</details>

<details>
<summary>Home Assistant (via hass-oidc-provider)</summary>

Home Assistant doesn't natively support OpenID Connect. Use [hass-oidc-provider](https://github.com/domdomegg/hass-oidc-provider) to bridge the gap — it runs alongside Home Assistant and adds the missing pieces.

```json
{
  "mode": "relay",
  "auth": {
    "issuer": "https://hass-oidc-provider.example.com"
  }
}
```

Point `auth.issuer` at your hass-oidc-provider instance (not Home Assistant directly). The `sub` claim is the Home Assistant user ID. No `clientId` or `clientSecret` needed.

</details>

### Meta tools

The relay exposes two built-in tools:

- **`status`** — Shows whether an agent is connected, its device name, uptime, and available tools.
- **`restart`** — Tells connected agents to restart their local MCP server processes. Useful if a server is stuck or its configuration has changed.

These are always available, even when no agent is connected.

### Multiple devices

If you run agents on multiple machines, the `name` field distinguishes them. Tools are prefixed with the device name when multiple devices are connected:

```
laptop__shell__execute
desktop__shell__execute
```

When only one device is connected, the device prefix is omitted.

## Contributing

Pull requests are welcomed on GitHub! To get started:

1. Install Git and Node.js
2. Clone the repository
3. Install dependencies with `npm install`
4. Run `npm run test` to run tests
5. Build with `npm run build`

## Releases

Versions follow the [semantic versioning spec](https://semver.org/).

To release:

1. Use `npm version <major | minor | patch>` to bump the version
2. Run `git push --follow-tags` to push with tags
3. Wait for GitHub Actions to publish to the NPM registry and GHCR (Docker).
