#!/usr/bin/env node
import {loadConfig} from './config.js';
import {startRelay} from './relay.js';
import {startAgent} from './agent.js';

const main = async () => {
	const config = loadConfig();

	if (config.mode === 'relay') {
		startRelay(config);
	} else {
		await startAgent(config);
	}
};

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
