/* eslint-disable @typescript-eslint/no-deprecated -- Using low-level Server to proxy JSON Schema without Zod conversion */
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {ConnectionManager} from './connection-manager.js';

export const createRelayMcpServer = (
	connectionManager: ConnectionManager,
	userId: string,
): Server => {
	const server = new Server(
		{name: 'mcp-local-tunnel', version: '1.0.0'},
		{capabilities: {tools: {}}},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const tools = [];

		// Meta tools (always available)
		const conns = connectionManager.getConnectionsForUser(userId);
		const connected = conns.length > 0;
		const statusDesc = connected
			? `Show tunnel status. Currently connected: ${conns.map((c) => c.name).join(', ')}`
			: 'Show tunnel status. No agent is currently connected.';

		tools.push({
			name: 'status',
			description: statusDesc,
			inputSchema: {type: 'object' as const, properties: {}},
			annotations: {
				title: 'Tunnel Status',
				readOnlyHint: true,
				openWorldHint: false,
			},
		});

		tools.push({
			name: 'restart',
			description: 'Restart all local MCP server processes on connected agents. Useful if a server is stuck or you\'ve changed its configuration.',
			inputSchema: {type: 'object' as const, properties: {}},
			annotations: {
				title: 'Restart Servers',
				readOnlyHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		});

		// Tunnelled tools from connected agents
		const agentTools = connectionManager.getToolsForUser(userId);
		for (const tool of agentTools) {
			tools.push({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				...(tool.annotations ? {annotations: tool.annotations} : {}),
			});
		}

		return {tools};
	});

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const {name, arguments: args} = request.params;

		if (name === 'status') {
			const conns = connectionManager.getConnectionsForUser(userId);
			if (conns.length === 0) {
				return {
					content: [{type: 'text' as const, text: 'No agent is currently connected. Start one with: npx mcp-local-tunnel'}],
				};
			}

			const devices = conns.map((c) => ({
				name: c.name,
				connectedSince: new Date(c.connectedAt).toISOString(),
				tools: c.tools.map((t) => t.name),
			}));

			return {
				content: [{type: 'text' as const, text: JSON.stringify({connected: true, devices}, null, 2)}],
			};
		}

		if (name === 'restart') {
			const conns = connectionManager.getConnectionsForUser(userId);
			if (conns.length === 0) {
				return {
					content: [{type: 'text' as const, text: 'No agent is currently connected — nothing to restart.'}],
					isError: true,
				};
			}

			connectionManager.sendRestart(userId);
			return {
				content: [{type: 'text' as const, text: `Restart signal sent to ${conns.length} agent(s). Tools will update shortly.`}],
			};
		}

		// Route to agent: find which device owns this tool
		const agentTools = connectionManager.getToolsForUser(userId);
		const tool = agentTools.find((t) => t.name === name);
		if (!tool) {
			return {
				content: [{type: 'text' as const, text: `Unknown tool: ${name}`}],
				isError: true,
			};
		}

		// Determine the original tool name (strip device prefix if multi-device)
		const conns = connectionManager.getConnectionsForUser(userId);
		const multiDevice = conns.length > 1;
		const originalName = multiDevice && name.startsWith(`${tool.deviceName}__`)
			? name.slice(tool.deviceName.length + 2)
			: name;

		try {
			const result = await connectionManager.sendRequest(userId, tool.deviceName, originalName, args ?? {});
			return result as {content: {type: string; text: string}[]};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{type: 'text' as const, text: `Error: ${message}`}],
				isError: true,
			};
		}
	});

	return server;
};
