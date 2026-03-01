import {randomUUID} from 'node:crypto';
import type WebSocket from 'ws';
import type {ToolDef, WsMessage} from './types.js';

type PendingRequest = {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export type AgentConnection = {
	ws: WebSocket;
	userId: string;
	name: string;
	connectedAt: number;
	tools: ToolDef[];
};

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes

export class ConnectionManager {
	/** userId -> AgentConnection[] (one per device) */
	private readonly connections = new Map<string, AgentConnection[]>();
	private readonly pending = new Map<string, PendingRequest>();

	addConnection(ws: WebSocket, userId: string, name: string): AgentConnection {
		const conn: AgentConnection = {
			ws, userId, name, connectedAt: Date.now(), tools: [],
		};

		ws.on('message', (data: Buffer) => {
			try {
				const msg = JSON.parse(data.toString()) as WsMessage;
				this.handleMessage(conn, msg);
			} catch (err) {
				console.error('Failed to parse WebSocket message:', err);
			}
		});

		ws.on('close', () => {
			this.removeConnection(conn);
		});

		ws.on('error', (err) => {
			console.error(`WebSocket error for ${name} (${userId}):`, err.message);
		});

		const existing = this.connections.get(userId) ?? [];
		// Replace existing connection with same name
		const filtered = existing.filter((c) => c.name !== name);
		filtered.push(conn);
		this.connections.set(userId, filtered);

		console.log(`Agent connected: "${name}" (user: ${userId})`);
		return conn;
	}

	getConnectionsForUser(userId: string): AgentConnection[] {
		return this.connections.get(userId) ?? [];
	}

	getToolsForUser(userId: string): (ToolDef & {deviceName: string})[] {
		const conns = this.getConnectionsForUser(userId);
		const tools: (ToolDef & {deviceName: string})[] = [];
		const multiDevice = conns.length > 1;

		for (const conn of conns) {
			for (const tool of conn.tools) {
				const name = multiDevice
					? `${conn.name}__${tool.name}`
					: tool.name;
				const description = multiDevice
					? `[${conn.name}] ${tool.description ?? ''}`
					: (tool.description ?? '');
				tools.push({
					...tool, name, description, deviceName: conn.name,
				});
			}
		}

		return tools;
	}

	async sendRequest(userId: string, deviceName: string, method: string, params: unknown): Promise<unknown> {
		const conns = this.getConnectionsForUser(userId);
		const conn = conns.find((c) => c.name === deviceName);
		if (!conn) {
			throw new Error(`No agent connected for device "${deviceName}"`);
		}

		const id = randomUUID();
		const msg: WsMessage = {
			type: 'request', id, method, params,
		};

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('Request timed out'));
			}, REQUEST_TIMEOUT_MS);

			this.pending.set(id, {resolve, reject, timer});
			conn.ws.send(JSON.stringify(msg));
		});
	}

	sendRestart(userId: string): void {
		const conns = this.getConnectionsForUser(userId);
		const msg: WsMessage = {type: 'restart'};
		for (const conn of conns) {
			conn.ws.send(JSON.stringify(msg));
		}
	}

	private removeConnection(conn: AgentConnection): void {
		const existing = this.connections.get(conn.userId);
		if (!existing) {
			return;
		}

		const filtered = existing.filter((c) => c !== conn);
		if (filtered.length === 0) {
			this.connections.delete(conn.userId);
		} else {
			this.connections.set(conn.userId, filtered);
		}

		console.log(`Agent disconnected: "${conn.name}" (user: ${conn.userId})`);
	}

	private handleMessage(conn: AgentConnection, msg: WsMessage): void {
		if (msg.type === 'tools') {
			conn.tools = msg.tools;
			console.log(`Agent "${conn.name}" registered ${msg.tools.length} tools`);
			return;
		}

		if (msg.type === 'response' || msg.type === 'error') {
			const req = this.pending.get(msg.id);
			if (!req) {
				return;
			}

			this.pending.delete(msg.id);
			clearTimeout(req.timer);

			if (msg.type === 'response') {
				req.resolve(msg.result);
			} else {
				req.reject(new Error(msg.message));
			}
		}
	}
}
