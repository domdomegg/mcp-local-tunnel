#!/usr/bin/env node
import {loadConfig} from './config.js';
import {startRelay} from './relay.js';
import {startDaemon} from './daemon.js';
import {startStubServer} from './stub-server.js';
import {resolveConfigIdentifier} from './ipc-path.js';

const main = async () => {
	const isDaemonProcess = process.argv.includes('--internal-daemon-process-do-not-use-directly');
	const config = loadConfig();

	if (config.mode === 'relay') {
		startRelay(config);
	} else if (isDaemonProcess) {
		await startDaemon(config, resolveConfigIdentifier());
	} else {
		await startStubServer(config, resolveConfigIdentifier());
	}
};

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
