import os from 'node:os';
import WebSocket from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
	AgentConfig, ToolDef, WsMessage,
} from './types.js';
import {getAccessToken} from './agent-auth.js';

type LocalServer = {
	name: string;
	client: Client;
	transport: StdioClientTransport | StreamableHTTPClientTransport;
};

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

const toWsUrl = (relay: string): string => {
	if (relay.startsWith('ws://') || relay.startsWith('wss://')) {
		return relay.endsWith('/ws') ? relay : `${relay.replace(/\/$/, '')}/ws`;
	}

	if (relay.startsWith('http://') || relay.startsWith('https://')) {
		const url = new URL(relay);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
		return url.toString();
	}

	return `wss://${relay}/ws`;
};

export type AgentHandle = {
	/** Gracefully shut down the agent, closing all connections and servers. */
	stop: () => Promise<void>;
};

export const startAgent = async (config: AgentConfig): Promise<AgentHandle> => {
	const name = config.name ?? os.hostname();
	const relayUrl = toWsUrl(config.relay);

	let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
	let shouldReconnect = true;
	let currentWs: WebSocket | undefined;
	let currentServers: LocalServer[] = [];

	const spawnServers = async (): Promise<LocalServer[]> => {
		const servers: LocalServer[] = [];
		const entries = Object.entries(config.servers);
		// Spawn servers sequentially to avoid overwhelming the system
		for (const [serverName, entry] of entries) {
			try {
				const client = new Client({name: `agent-${serverName}`, version: '1.0.0'});
				let transport: StdioClientTransport | StreamableHTTPClientTransport;

				if (entry.command) {
					const [cmd, ...args] = entry.command;
					transport = new StdioClientTransport({
						command: cmd!,
						args,
						env: {...process.env, ...entry.env} as Record<string, string>,
					});
				} else if (entry.url) {
					transport = new StreamableHTTPClientTransport(new URL(entry.url));
				} else {
					throw new Error(`Server "${serverName}" must have either "command" or "url"`);
				}

				// eslint-disable-next-line no-await-in-loop
				await client.connect(transport as unknown as Transport);
				servers.push({name: serverName, client, transport});
				console.log(`  Started local server: ${serverName}`);
			} catch (err) {
				console.error(`  Failed to start server "${serverName}":`, err instanceof Error ? err.message : err);
			}
		}

		return servers;
	};

	const collectTools = async (servers: LocalServer[]): Promise<ToolDef[]> => {
		const tools: ToolDef[] = [];
		for (const server of servers) {
			try {
				// eslint-disable-next-line no-await-in-loop
				const result = await server.client.listTools();
				for (const tool of result.tools) {
					tools.push({
						name: `${server.name}__${tool.name}`,
						description: `[${server.name}] ${tool.description ?? ''}`,
						inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
						...(tool.annotations ? {annotations: tool.annotations as unknown as Record<string, unknown>} : {}),
					});
				}
			} catch (err) {
				console.error(`  Failed to list tools from "${server.name}":`, err instanceof Error ? err.message : err);
			}
		}

		return tools;
	};

	const closeServers = async (servers: LocalServer[]): Promise<void> => {
		for (const server of servers) {
			try {
				// eslint-disable-next-line no-await-in-loop
				await server.client.close();
			} catch {
				// Ignore cleanup errors
			}
		}
	};

	const handleToolCall = async (
		servers: LocalServer[],
		toolName: string,
		args: Record<string, unknown>,
	): Promise<unknown> => {
		const separatorIndex = toolName.indexOf('__');
		if (separatorIndex === -1) {
			throw new Error(`Unknown tool: ${toolName}`);
		}

		const serverName = toolName.slice(0, separatorIndex);
		const originalName = toolName.slice(separatorIndex + 2);
		const server = servers.find((s) => s.name === serverName);
		if (!server) {
			throw new Error(`Unknown server: ${serverName}`);
		}

		const result = await server.client.callTool({name: originalName, arguments: args});
		return result;
	};

	const connect = async (): Promise<void> => {
		let servers = await spawnServers();
		let tools = await collectTools(servers);

		const token = await getAccessToken(config.relay);

		const wsUrl = new URL(relayUrl);
		wsUrl.searchParams.set('name', name);
		wsUrl.searchParams.set('token', token);

		console.log(`Connecting to ${config.relay} as "${name}"...`);

		const ws = new WebSocket(wsUrl.toString());

		let pingInterval: ReturnType<typeof setInterval> | undefined;
		let pongTimeout: ReturnType<typeof setTimeout> | undefined;

		ws.on('open', () => {
			reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
			console.log(`Connected to ${config.relay} as "${name}"`);
			console.log(`Serving ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

			const msg: WsMessage = {type: 'tools', tools};
			ws.send(JSON.stringify(msg));

			// Start ping/pong keepalive
			pingInterval = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.ping();
					pongTimeout = setTimeout(() => {
						console.log('Pong timeout — connection dead, terminating.');
						ws.terminate();
					}, PONG_TIMEOUT_MS);
				}
			}, PING_INTERVAL_MS);
		});

		ws.on('pong', () => {
			if (pongTimeout) {
				clearTimeout(pongTimeout);
				pongTimeout = undefined;
			}
		});

		ws.on('message', async (data: Buffer) => {
			try {
				const msg = JSON.parse(data.toString()) as WsMessage;

				if (msg.type === 'request') {
					try {
						const result = await handleToolCall(servers, msg.method, msg.params as Record<string, unknown>);
						const response: WsMessage = {type: 'response', id: msg.id, result};
						ws.send(JSON.stringify(response));
					} catch (err) {
						const errMsg: WsMessage = {
							type: 'error',
							id: msg.id,
							message: err instanceof Error ? err.message : String(err),
						};
						ws.send(JSON.stringify(errMsg));
					}
				} else if (msg.type === 'restart') {
					console.log('Restart requested by relay, restarting servers...');
					await closeServers(servers);
					servers = await spawnServers();
					tools = await collectTools(servers);
					const toolsMsg: WsMessage = {type: 'tools', tools};
					ws.send(JSON.stringify(toolsMsg));
					console.log(`Restarted. Now serving ${tools.length} tools.`);
				}
			} catch (err) {
				console.error('Error handling message:', err);
			}
		});

		ws.on('close', () => {
			if (pingInterval) {
				clearInterval(pingInterval);
				pingInterval = undefined;
			}

			if (pongTimeout) {
				clearTimeout(pongTimeout);
				pongTimeout = undefined;
			}

			console.log('Disconnected from relay.');
			void closeServers(servers);

			if (shouldReconnect) {
				console.log(`Reconnecting in ${reconnectDelay / 1000}s...`);
				setTimeout(() => {
					void connect();
				}, reconnectDelay);
				reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
			}
		});

		ws.on('error', (err) => {
			console.error('WebSocket error:', err.message);
		});

		currentWs = ws;
		currentServers = servers;
	};

	await connect();

	return {
		async stop() {
			shouldReconnect = false;
			console.log('\nShutting down agent...');
			currentWs?.close();
			await closeServers(currentServers);
		},
	};
};
