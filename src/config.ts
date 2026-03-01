import fs from 'node:fs';
import {ConfigSchema} from './types.js';
import type {Config} from './types.js';

const DEFAULT_CONFIG_PATH = 'mcp-local-tunnel.config.json';

export const loadConfig = (input?: string): Config => {
	const raw = input ?? process.env.MCP_LOCAL_TUNNEL_CONFIG;

	let json: unknown;

	if (!raw) {
		if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
			json = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
		} else {
			throw new Error('No config found. Set MCP_LOCAL_TUNNEL_CONFIG or create mcp-local-tunnel.config.json');
		}
	} else if (!raw.startsWith('{') && fs.existsSync(raw)) {
		json = JSON.parse(fs.readFileSync(raw, 'utf8'));
	} else {
		json = JSON.parse(raw);
	}

	const result = ConfigSchema.safeParse(json);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
		throw new Error(`Invalid config:\n${issues}`);
	}

	return result.data;
};
