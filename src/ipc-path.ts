import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync} from 'node:fs';

/**
 * Determine a stable identifier for the current config source.
 * This is used to derive unique IPC socket / PID file paths so that
 * different relay configs get independent daemons.
 */
export const resolveConfigIdentifier = (): string => {
	// If MCP_LOCAL_TUNNEL_CONFIG is set and points to a file, use the file path.
	// If it's inline JSON, hash the content.
	// Otherwise use the default config file path.
	const raw = process.env.MCP_LOCAL_TUNNEL_CONFIG;

	if (raw && !raw.startsWith('{') && existsSync(raw)) {
		return raw;
	}

	if (raw) {
		return raw;
	}

	return 'mcp-local-tunnel.config.json';
};

/**
 * Get the IPC socket/pipe path for the daemon.
 * Uses a hash of the config identifier to allow multiple independent daemons
 * for different relay configurations.
 *
 * - macOS/Linux: Unix domain socket in ~/.config/mcp-local-tunnel/sockets/
 * - Windows: Named pipe \\.\pipe\mcp-local-tunnel-<hash>
 */
export const getIpcPath = (configIdentifier: string): string => {
	const hash = createHash('sha256').update(configIdentifier).digest('hex').slice(0, 12);

	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\mcp-local-tunnel-${hash}`;
	}

	const dir = join(
		process.env.XDG_RUNTIME_DIR ?? join(homedir(), '.config', 'mcp-local-tunnel'),
		'sockets',
	);
	mkdirSync(dir, {recursive: true});
	return join(dir, `daemon-${hash}.sock`);
};

/**
 * Get the path for the daemon's PID file.
 */
export const getPidPath = (configIdentifier: string): string => {
	const hash = createHash('sha256').update(configIdentifier).digest('hex').slice(0, 12);
	const dir = join(homedir(), '.config', 'mcp-local-tunnel');
	mkdirSync(dir, {recursive: true});
	return join(dir, `daemon-${hash}.pid`);
};

/**
 * Get the path for daemon log output.
 */
export const getLogPath = (configIdentifier: string): string => {
	const hash = createHash('sha256').update(configIdentifier).digest('hex').slice(0, 12);
	const dir = join(homedir(), '.config', 'mcp-local-tunnel', 'logs');
	mkdirSync(dir, {recursive: true});
	return join(dir, `daemon-${hash}.log`);
};
