import {type ChildProcess, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {
	test, expect, afterEach, beforeAll, afterAll,
} from 'vitest';
import type {Server as HttpServer} from 'node:http';
import {OidcClient} from './oidc-client';
import {TunnelOAuthProvider} from './oauth-provider';
import {ConnectionManager} from './connection-manager';
import {createRelayApp} from './relay-server';
import {seal, deriveKey} from './crypto';

// ── Relay setup ────────────────────────────────────────────────

const RELAY_SECRET = 'e2e-test-secret';
const RELAY_PORT = 19876;
const RELAY_HOST = '127.0.0.1';
const RELAY_URL = `http://${RELAY_HOST}:${RELAY_PORT}`;
const TOKEN_TTL_MS = 3_600_000;
const CONFIG_DIR = join(homedir(), '.config', 'mcp-local-tunnel');

let relayServer: HttpServer;
let connectionManager: ConnectionManager;
let tokenCachePath: string;

const mintAccessToken = (): string => {
	const key = deriveKey(RELAY_SECRET);
	return seal({
		type: 'access',
		clientId: 'mcp-local-tunnel-agent',
		userId: 'e2e-test-user',
		scopes: ['openid'],
		expiresAt: Date.now() + TOKEN_TTL_MS,
	}, key);
};

const seedTokenCache = (): void => {
	const relayHost = `${RELAY_HOST}:${RELAY_PORT}`;
	const safe = relayHost.replaceAll(/[^a-zA-Z0-9.-]/g, '_');
	tokenCachePath = join(CONFIG_DIR, `tokens-${safe}.json`);
	mkdirSync(CONFIG_DIR, {recursive: true});
	writeFileSync(tokenCachePath, JSON.stringify({
		accessToken: mintAccessToken(),
		expiresAt: Date.now() + TOKEN_TTL_MS,
		clientId: 'mcp-local-tunnel-agent',
	}), {mode: 0o600});
};

beforeAll(async () => {
	const {execSync} = await import('node:child_process');
	execSync('npm run build', {stdio: 'pipe', cwd: process.cwd()});

	const relayConfig = {
		mode: 'relay' as const,
		auth: {issuer: 'https://unused.invalid'},
		port: RELAY_PORT,
		host: RELAY_HOST,
		issuerUrl: RELAY_URL,
		secret: RELAY_SECRET,
	};
	const oidcClient = new OidcClient(relayConfig.auth);
	const provider = new TunnelOAuthProvider(oidcClient, relayConfig);
	connectionManager = new ConnectionManager();
	const {app, attachWebSocket} = createRelayApp(relayConfig, provider, oidcClient, connectionManager);

	await new Promise<void>((resolve) => {
		relayServer = app.listen(RELAY_PORT, RELAY_HOST, () => {
			resolve();
		});
	});
	attachWebSocket(relayServer);

	seedTokenCache();
});

afterAll(() => {
	relayServer?.close();
	try {
		unlinkSync(tokenCachePath);
	} catch {
		// ok
	}
});

// ── Helpers ────────────────────────────────────────────────────

const uniqueId = () => `e2e-test-${randomBytes(8).toString('hex')}`;

/** Write a test agent config file and return its path. */
const writeTestConfig = (id: string): string => {
	const configPath = join(CONFIG_DIR, `${id}.json`);
	writeFileSync(configPath, JSON.stringify({
		mode: 'agent',
		relay: RELAY_URL,
		name: id,
		servers: {},
	}));
	return configPath;
};

/**
 * Spawn the binary as a stub (how Claude Code would run it).
 * Returns a child process with stdin open for writing.
 */
const spawnStub = (configPath: string, gracePeriodMs = 500): ChildProcess => spawn('node', ['dist/index.js'], {
	stdio: ['pipe', 'pipe', 'pipe'],
	cwd: process.cwd(),
	env: {
		...process.env,
		MCP_LOCAL_TUNNEL_CONFIG: configPath,
		DAEMON_GRACE_PERIOD_MS: String(gracePeriodMs),
		DAEMON_PID_CHECK_INTERVAL_MS: '1000',
	},
});

const collectOutput = (child: ChildProcess): {stdout: string[]; stderr: string[]} => {
	const output = {stdout: [] as string[], stderr: [] as string[]};
	child.stdout?.on('data', (d: Buffer) => output.stdout.push(d.toString()));
	child.stderr?.on('data', (d: Buffer) => output.stderr.push(d.toString()));
	return output;
};

const waitForExit = async (child: ChildProcess, timeoutMs = 15_000): Promise<number | null> => new Promise((resolve, reject) => {
	if (child.exitCode !== null) {
		resolve(child.exitCode);
		return;
	}

	const timer = setTimeout(() => {
		child.kill('SIGKILL');
		reject(new Error(`Process did not exit within ${timeoutMs}ms`));
	}, timeoutMs);
	child.on('exit', (code) => {
		clearTimeout(timer);
		resolve(code);
	});
});

/** Wait until the relay sees an agent connection with the given name. */
const waitForAgent = async (name: string, timeoutMs = 15_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const conns = connectionManager.getConnectionsForUser('e2e-test-user');
		if (conns.some((c) => c.name === name)) {
			return;
		}

		// eslint-disable-next-line no-await-in-loop
		await new Promise((r) => {
			setTimeout(r, 100);
		});
	}

	throw new Error(`Agent "${name}" did not connect to relay within ${timeoutMs}ms`);
};

/** Wait until the relay no longer has an agent with the given name. */
const waitForAgentDisconnect = async (name: string, timeoutMs = 15_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const conns = connectionManager.getConnectionsForUser('e2e-test-user');
		if (!conns.some((c) => c.name === name)) {
			return;
		}

		// eslint-disable-next-line no-await-in-loop
		await new Promise((r) => {
			setTimeout(r, 100);
		});
	}

	throw new Error(`Agent "${name}" did not disconnect from relay within ${timeoutMs}ms`);
};

/**
 * Send an MCP JSON-RPC message on stdin and read the response from stdout.
 * This is how a real MCP client (Claude Code) talks to the stub.
 */
const sendMcpRequest = async (child: ChildProcess, method: string, id: number, params?: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
	const msg = JSON.stringify({
		jsonrpc: '2.0', id, method, ...(params ? {params} : {}),
	});
	child.stdin!.write(`${msg}\n`);

	const timer = setTimeout(() => {
		reject(new Error(`No MCP response for ${method} within 5s`));
	}, 5_000);

	const onData = (data: Buffer) => {
		const lines = data.toString().split('\n').filter(Boolean);
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				if (parsed.id === id) {
					clearTimeout(timer);
					child.stdout!.removeListener('data', onData);
					resolve(parsed);
					return;
				}
			} catch {
				// Not JSON, ignore
			}
		}
	};

	child.stdout!.on('data', onData);
});

const sleep = async (ms: number): Promise<void> => new Promise((resolve) => {
	setTimeout(resolve, ms);
});

/** Check if a process is still running. */
const isAlive = (child: ChildProcess): boolean => child.exitCode === null;

// ── Cleanup ────────────────────────────────────────────────────

const children: ChildProcess[] = [];
const configPaths: string[] = [];

afterEach(async () => {
	for (const child of children) {
		try {
			child.kill('SIGKILL');
		} catch {
			// Already dead
		}
	}

	children.length = 0;

	for (const p of configPaths) {
		try {
			unlinkSync(p);
		} catch {
			// ok
		}
	}

	configPaths.length = 0;

	await sleep(200);
});

// ── Tests ──────────────────────────────────────────────────────

test('stub starts, daemon connects agent to relay, stub responds to MCP', async () => {
	const id = uniqueId();
	const configPath = writeTestConfig(id);
	configPaths.push(configPath);

	const stub = spawnStub(configPath);
	children.push(stub);
	collectOutput(stub);

	// Agent should appear on the relay
	await waitForAgent(id);

	// Stub should respond to MCP initialize
	const initResponse = await sendMcpRequest(stub, 'initialize', 1, {
		protocolVersion: '2025-03-26',
		capabilities: {},
		clientInfo: {name: 'test', version: '1.0.0'},
	});
	expect(initResponse.result).toBeDefined();

	// The stub is intentionally empty — it exists only to keep the daemon alive.
	// tools/list is not supported (no tools registered), which is expected.

	// Close stdin → stub should exit
	stub.stdin!.end();
	const code = await waitForExit(stub);
	expect(code).toBe(0);

	// Agent should disconnect from relay after daemon shuts down
	await waitForAgentDisconnect(id);
}, 30_000);

test('second stub reuses existing daemon (no duplicate agent)', async () => {
	const id = uniqueId();
	const configPath = writeTestConfig(id);
	configPaths.push(configPath);

	const stub1 = spawnStub(configPath);
	children.push(stub1);
	collectOutput(stub1);

	await waitForAgent(id);

	// Start second stub with same config
	const stub2 = spawnStub(configPath);
	children.push(stub2);
	collectOutput(stub2);

	// Both stubs should respond to MCP
	const [r1, r2] = await Promise.all([
		sendMcpRequest(stub1, 'initialize', 1, {
			protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test1', version: '1.0.0'},
		}),
		sendMcpRequest(stub2, 'initialize', 1, {
			protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test2', version: '1.0.0'},
		}),
	]);
	expect(r1.result).toBeDefined();
	expect(r2.result).toBeDefined();

	// There should still be only ONE agent connection on the relay
	const conns = connectionManager.getConnectionsForUser('e2e-test-user');
	const matching = conns.filter((c) => c.name === id);
	expect(matching).toHaveLength(1);

	stub1.stdin!.end();
	stub2.stdin!.end();
	await Promise.all([waitForExit(stub1), waitForExit(stub2)]);
	await waitForAgentDisconnect(id);
}, 30_000);

test('daemon survives first stub closing if second is still alive', async () => {
	const id = uniqueId();
	const configPath = writeTestConfig(id);
	configPaths.push(configPath);

	const stub1 = spawnStub(configPath, 1_000);
	children.push(stub1);
	collectOutput(stub1);

	await waitForAgent(id);

	// Initialize both stubs
	await sendMcpRequest(stub1, 'initialize', 1, {
		protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test1', version: '1.0.0'},
	});

	const stub2 = spawnStub(configPath, 1_000);
	children.push(stub2);
	collectOutput(stub2);

	await sendMcpRequest(stub2, 'initialize', 1, {
		protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test2', version: '1.0.0'},
	});

	// Close first stub
	stub1.stdin!.end();
	await waitForExit(stub1);

	// Wait past grace period — agent should still be connected
	await sleep(2_000);
	const conns = connectionManager.getConnectionsForUser('e2e-test-user');
	expect(conns.some((c) => c.name === id)).toBe(true);

	// Close second stub → daemon should shut down
	stub2.stdin!.end();
	await waitForExit(stub2);
	await waitForAgentDisconnect(id);
}, 30_000);

test('daemon shuts down after all stubs close (grace period)', async () => {
	const id = uniqueId();
	const configPath = writeTestConfig(id);
	configPaths.push(configPath);

	const stub = spawnStub(configPath, 500);
	children.push(stub);
	collectOutput(stub);

	await waitForAgent(id);
	await sendMcpRequest(stub, 'initialize', 1, {
		protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test', version: '1.0.0'},
	});

	stub.stdin!.end();
	await waitForExit(stub);

	// Agent should disconnect after daemon's grace period
	await waitForAgentDisconnect(id, 10_000);
}, 30_000);

test('new stub during grace period prevents shutdown', async () => {
	const id = uniqueId();
	const configPath = writeTestConfig(id);
	configPaths.push(configPath);

	const stub1 = spawnStub(configPath, 2_000);
	children.push(stub1);
	collectOutput(stub1);

	await waitForAgent(id);
	await sendMcpRequest(stub1, 'initialize', 1, {
		protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test1', version: '1.0.0'},
	});

	// Close first stub → grace period starts
	stub1.stdin!.end();
	await waitForExit(stub1);

	// Start new stub during grace period
	await sleep(500);
	const stub2 = spawnStub(configPath, 2_000);
	children.push(stub2);
	collectOutput(stub2);

	await sendMcpRequest(stub2, 'initialize', 1, {
		protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test2', version: '1.0.0'},
	});

	// Wait past original grace period — agent should still be connected
	await sleep(2_000);
	const conns = connectionManager.getConnectionsForUser('e2e-test-user');
	expect(conns.some((c) => c.name === id)).toBe(true);

	stub2.stdin!.end();
	await waitForExit(stub2);
	await waitForAgentDisconnect(id);
}, 30_000);

test('two independent configs get independent daemons', async () => {
	const id1 = uniqueId();
	const id2 = uniqueId();
	const configPath1 = writeTestConfig(id1);
	const configPath2 = writeTestConfig(id2);
	configPaths.push(configPath1, configPath2);

	const stub1 = spawnStub(configPath1);
	children.push(stub1);
	collectOutput(stub1);

	const stub2 = spawnStub(configPath2);
	children.push(stub2);
	collectOutput(stub2);

	// Both agents should appear on the relay
	await waitForAgent(id1);
	await waitForAgent(id2);

	const conns = connectionManager.getConnectionsForUser('e2e-test-user');
	expect(conns.some((c) => c.name === id1)).toBe(true);
	expect(conns.some((c) => c.name === id2)).toBe(true);

	// Closing one stub doesn't affect the other daemon
	stub1.stdin!.end();
	await waitForExit(stub1);
	await waitForAgentDisconnect(id1);

	// Agent 2 should still be connected
	const conns2 = connectionManager.getConnectionsForUser('e2e-test-user');
	expect(conns2.some((c) => c.name === id2)).toBe(true);

	stub2.stdin!.end();
	await waitForExit(stub2);
	await waitForAgentDisconnect(id2);
}, 30_000);

test('stub killed with SIGKILL still triggers daemon cleanup', async () => {
	const id = uniqueId();
	const configPath = writeTestConfig(id);
	configPaths.push(configPath);

	const stub = spawnStub(configPath, 500);
	children.push(stub);
	collectOutput(stub);

	await waitForAgent(id);

	// Kill stub ungracefully
	stub.kill('SIGKILL');
	await waitForExit(stub);

	// Daemon should still shut down after grace period
	// (OS closes the IPC socket FD on SIGKILL)
	await waitForAgentDisconnect(id, 10_000);
}, 30_000);

test('many concurrent stubs share one daemon', async () => {
	const id = uniqueId();
	const configPath = writeTestConfig(id);
	configPaths.push(configPath);

	// Spawn 5 stubs concurrently
	const stubs: ChildProcess[] = [];
	for (let i = 0; i < 5; i++) {
		const s = spawnStub(configPath, 1_000);
		children.push(s);
		stubs.push(s);
		collectOutput(s);
	}

	await waitForAgent(id);

	// All should respond to MCP
	const responses = await Promise.all(stubs.map(async (s, i) => sendMcpRequest(s, 'initialize', 1, {
		protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: `test${i}`, version: '1.0.0'},
	})));
	for (const r of responses) {
		expect(r.result).toBeDefined();
	}

	// Only one agent connection on the relay
	const conns = connectionManager.getConnectionsForUser('e2e-test-user');
	expect(conns.filter((c) => c.name === id)).toHaveLength(1);

	// Close all but one
	for (const s of stubs.slice(1)) {
		s.stdin!.end();
	}

	await sleep(2_000);

	// Agent still connected
	expect(isAlive(stubs[0]!)).toBe(true);
	const conns2 = connectionManager.getConnectionsForUser('e2e-test-user');
	expect(conns2.some((c) => c.name === id)).toBe(true);

	// Close last one
	stubs[0]!.stdin!.end();
	await Promise.all(stubs.map(async (s) => waitForExit(s)));
	await waitForAgentDisconnect(id);
}, 30_000);
