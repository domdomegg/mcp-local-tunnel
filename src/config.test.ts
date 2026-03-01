import {test, expect} from 'vitest';
import {loadConfig} from './config';

test('parses valid relay config', () => {
	const config = loadConfig(JSON.stringify({
		mode: 'relay',
		auth: {issuer: 'https://auth.example.com'},
	}));
	expect(config.mode).toBe('relay');
	if (config.mode === 'relay') {
		expect(config.auth.issuer).toBe('https://auth.example.com');
	}
});

test('parses valid agent config', () => {
	const config = loadConfig(JSON.stringify({
		mode: 'agent',
		relay: 'tunnel.example.com',
		servers: {
			shell: {command: ['npx', '-y', 'shell-exec-mcp']},
		},
	}));
	expect(config.mode).toBe('agent');
	if (config.mode === 'agent') {
		expect(config.relay).toBe('tunnel.example.com');
		expect(config.servers.shell).toBeDefined();
	}
});

test('rejects config without mode', () => {
	expect(() => loadConfig(JSON.stringify({
		auth: {issuer: 'https://auth.example.com'},
	}))).toThrow();
});

test('rejects relay config without auth.issuer', () => {
	expect(() => loadConfig(JSON.stringify({
		mode: 'relay',
		auth: {},
	}))).toThrow();
});

test('rejects agent config without relay', () => {
	expect(() => loadConfig(JSON.stringify({
		mode: 'agent',
		servers: {shell: {command: ['echo']}},
	}))).toThrow();
});

test('rejects agent config without servers', () => {
	expect(() => loadConfig(JSON.stringify({
		mode: 'agent',
		relay: 'tunnel.example.com',
	}))).toThrow();
});

test('applies relay config defaults', () => {
	const config = loadConfig(JSON.stringify({
		mode: 'relay',
		auth: {issuer: 'https://auth.example.com'},
	}));
	if (config.mode === 'relay') {
		expect(config.port).toBeUndefined();
		expect(config.host).toBeUndefined();
		expect(config.auth.clientId).toBeUndefined();
	}
});
