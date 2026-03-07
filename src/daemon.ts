import net from 'node:net';
import {
	existsSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import {startAgent, type AgentHandle} from './agent.js';
import type {AgentConfig} from './types.js';
import {getIpcPath, getPidPath} from './ipc-path.js';

export type DaemonOptions = {
	/** Override how the agent is started (used in tests). */
	startAgent?: (config: AgentConfig) => Promise<AgentHandle>;
	/** Override the grace period in ms before shutdown after last session disconnects. */
	gracePeriodMs?: number;
	/** Override the PID check interval in ms. */
	pidCheckIntervalMs?: number;
};

const GRACE_PERIOD_MS = 10_000;
const PID_CHECK_INTERVAL_MS = 30_000;

/**
 * Try connecting to a Unix socket / named pipe. Returns true if
 * something is actively listening, false if the socket is stale or absent.
 */
const isSocketLive = async (ipcPath: string): Promise<boolean> => new Promise((resolve) => {
	const socket = net.createConnection(ipcPath, () => {
		socket.destroy();
		resolve(true);
	});
	socket.on('error', () => {
		socket.destroy();
		resolve(false);
	});
});

/**
 * Start the daemon process. Runs the agent and listens on an IPC socket
 * for session connections from stub servers. Shuts down when no sessions
 * remain after a grace period.
 *
 * This is invoked internally and should not be called directly by users.
 */
export const startDaemon = async (config: AgentConfig, configIdentifier: string, options?: DaemonOptions): Promise<void> => {
	const ipcPath = getIpcPath(configIdentifier);
	const pidPath = getPidPath(configIdentifier);
	let connectionCount = 0;
	let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
	const state: {agentHandle?: Awaited<ReturnType<typeof startAgent>>} = {};

	const gracePeriodMs = options?.gracePeriodMs
		?? (process.env.DAEMON_GRACE_PERIOD_MS ? Number(process.env.DAEMON_GRACE_PERIOD_MS) : GRACE_PERIOD_MS);
	const pidCheckIntervalMs = options?.pidCheckIntervalMs
		?? (process.env.DAEMON_PID_CHECK_INTERVAL_MS ? Number(process.env.DAEMON_PID_CHECK_INTERVAL_MS) : PID_CHECK_INTERVAL_MS);
	const startAgentFn = options?.startAgent ?? startAgent;

	const cleanup = () => {
		if (process.platform !== 'win32') {
			try {
				unlinkSync(ipcPath);
			} catch {
				// Already cleaned up
			}
		}

		try {
			unlinkSync(pidPath);
		} catch {
			// Already cleaned up
		}
	};

	const shutdownNow = () => {
		cleanup();
		if (state.agentHandle) {
			void state.agentHandle.stop().then(() => process.exit(0));
		} else {
			process.exit(0);
		}
	};

	const scheduleShutdown = () => {
		if (shutdownTimer) {
			clearTimeout(shutdownTimer);
		}

		shutdownTimer = setTimeout(() => {
			if (connectionCount === 0) {
				console.log('No sessions remaining. Shutting down daemon.');
				shutdownNow();
			}
		}, gracePeriodMs);
	};

	// Before touching the socket, check if another daemon is already listening.
	// Only clean up the socket file if it's stale (nothing listening).
	if (process.platform !== 'win32') {
		const live = await isSocketLive(ipcPath);
		if (live) {
			console.log('Another daemon is already listening. Exiting.');
			process.exit(0);
		}

		// Socket file is stale or absent — safe to clean up
		try {
			unlinkSync(ipcPath);
		} catch {
			// Doesn't exist, fine
		}
	}

	const server = net.createServer((socket) => {
		connectionCount += 1;
		console.log(`Session connected (${connectionCount} active)`);

		if (shutdownTimer) {
			clearTimeout(shutdownTimer);
			shutdownTimer = undefined;
		}

		socket.on('close', () => {
			connectionCount -= 1;
			console.log(`Session disconnected (${connectionCount} active)`);

			if (connectionCount === 0) {
				scheduleShutdown();
			}
		});

		socket.on('error', () => {
			// Connection errors are handled by 'close'
		});
	});

	// Wait for listen to succeed before writing PID file.
	// This avoids overwriting another daemon's PID file if we lose the race.
	await new Promise<void>((resolve, reject) => {
		server.listen(ipcPath, () => {
			resolve();
		});

		server.on('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'EADDRINUSE') {
				console.log('Another daemon is already listening. Exiting.');
				process.exit(0);
			}

			reject(err);
		});
	});

	console.log(`Daemon IPC listening on ${ipcPath}`);

	// Now that we own the socket, write PID file
	writeFileSync(pidPath, String(process.pid), {mode: 0o600});

	// Periodically verify our PID file still points to us.
	// If someone deleted it or another daemon overwrote it, we're orphaned.
	const pidCheckInterval = setInterval(() => {
		try {
			if (!existsSync(pidPath)) {
				console.log('PID file deleted. Shutting down orphaned daemon.');
				clearInterval(pidCheckInterval);
				shutdownNow();
				return;
			}

			const filePid = Number.parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
			if (filePid !== process.pid) {
				console.log(`PID file points to ${filePid}, not us (${process.pid}). Shutting down orphaned daemon.`);
				clearInterval(pidCheckInterval);
				// Don't clean up — the PID file belongs to the other daemon
				if (state.agentHandle) {
					void state.agentHandle.stop().then(() => process.exit(0));
				} else {
					process.exit(0);
				}
			}
		} catch {
			// If we can't read the PID file, assume we're still valid
		}
	}, pidCheckIntervalMs);
	pidCheckInterval.unref();

	// Start the actual agent (wrapped in try/catch to clean up on failure)
	try {
		state.agentHandle = await startAgentFn(config);
	} catch (err) {
		console.error('Failed to start agent:', err instanceof Error ? err.message : err);
		cleanup();
		process.exit(1);
	}

	// Schedule shutdown in case no session connects
	scheduleShutdown();

	process.on('SIGINT', shutdownNow);
	process.on('SIGTERM', shutdownNow);
};
