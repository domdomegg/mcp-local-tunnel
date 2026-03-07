import net from 'node:net';
import {spawn} from 'node:child_process';
import {openSync} from 'node:fs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import type {AgentConfig} from './types.js';
import {getIpcPath, getLogPath} from './ipc-path.js';
import {getAccessToken} from './agent-auth.js';

/**
 * Try a single IPC connection attempt. Resolves with the socket on
 * success, or undefined on failure. Always cleans up failed sockets.
 */
const tryConnectOnce = async (ipcPath: string): Promise<net.Socket | undefined> => new Promise((resolve) => {
	const socket = net.createConnection(ipcPath, () => {
		resolve(socket);
	});
	socket.on('error', () => {
		socket.destroy();
		resolve(undefined);
	});
});

/**
 * Spawn the daemon as a detached background process.
 */
const spawnDaemon = (configIdentifier: string): void => {
	const logPath = getLogPath(configIdentifier);
	const logFd = openSync(logPath, 'a');

	const args = process.argv.slice(1).filter((a) => a !== '--internal-daemon-process-do-not-use-directly');
	const child = spawn(process.execPath, [...args, '--internal-daemon-process-do-not-use-directly'], {
		detached: true,
		stdio: ['ignore', logFd, logFd],
		env: process.env,
	});

	child.unref();
	console.error(`Daemon spawned (pid ${child.pid}), logs: ${logPath}`);
};

const CONNECT_TIMEOUT_MS = 30_000;
const CONNECT_RETRY_MS = 200;

/**
 * Connect to the daemon, spawning it if necessary. Strategy:
 *
 * 1. Try to connect to existing daemon
 * 2. If that fails, ensure auth tokens are cached, spawn daemon
 * 3. Retry connecting until success or timeout
 *
 * This approach is race-safe: if two stubs both spawn a daemon
 * simultaneously, one daemon wins the IPC socket and the other exits.
 * Both stubs eventually connect to the winning daemon.
 */
const ensureDaemonAndConnect = async (config: AgentConfig, configIdentifier: string): Promise<net.Socket> => {
	const ipcPath = getIpcPath(configIdentifier);

	// Fast path: daemon is already running
	const existing = await tryConnectOnce(ipcPath);
	if (existing) {
		return existing;
	}

	// Daemon not running — pre-auth (we have a TTY, daemon doesn't)
	// then spawn
	await getAccessToken(config.relay);
	spawnDaemon(configIdentifier);

	// Poll until the daemon's IPC socket is ready
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		// eslint-disable-next-line no-await-in-loop
		const socket = await tryConnectOnce(ipcPath);
		if (socket) {
			return socket;
		}

		// eslint-disable-next-line no-await-in-loop
		await new Promise((r) => {
			setTimeout(r, CONNECT_RETRY_MS);
		});
	}

	throw new Error(`Timed out waiting for daemon (${CONNECT_TIMEOUT_MS / 1000}s). Check logs: ${getLogPath(configIdentifier)}`);
};

/**
 * Start a stub MCP server on stdio. This is what Claude Code / opencode
 * sees as an MCP server. It manages the daemon lifecycle and responds to
 * MCP requests with minimal/empty responses — actual tool usage goes
 * through the tunnel relay, not through this stub.
 */
export const startStubServer = async (config: AgentConfig, configIdentifier: string): Promise<void> => {
	const daemonSocket = await ensureDaemonAndConnect(config, configIdentifier);

	// Run a stub MCP server on stdio. Register then remove a dummy tool
	// so the SDK installs the tools/list handler (returns empty list).
	const server = new McpServer({name: 'mcp-local-tunnel', version: '1.0.0'});
	const registered = server.registerTool('_init', {}, () => ({content: []}));
	registered.remove();
	const transport = new StdioServerTransport();
	await server.connect(transport);

	// When stdin closes (session ends), disconnect from daemon
	process.stdin.on('end', () => {
		daemonSocket.destroy();
	});

	// If daemon disconnects, exit
	daemonSocket.on('close', () => {
		process.exit(0);
	});

	daemonSocket.on('error', () => {
		process.exit(1);
	});
};
