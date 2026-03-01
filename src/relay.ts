import {OidcClient} from './oidc-client.js';
import {TunnelOAuthProvider} from './oauth-provider.js';
import {ConnectionManager} from './connection-manager.js';
import {createRelayApp} from './relay-server.js';
import type {RelayConfig} from './types.js';

export const startRelay = (config: RelayConfig): void => {
	const oidcClient = new OidcClient(config.auth);
	const provider = new TunnelOAuthProvider(oidcClient, config);
	const connectionManager = new ConnectionManager();
	const {app, attachWebSocket} = createRelayApp(config, provider, oidcClient, connectionManager);

	const port = config.port ?? 3000;
	const host = config.host ?? '0.0.0.0';
	const server = app.listen(port, host, () => {
		console.log(`mcp-local-tunnel relay listening on ${host}:${port}`);
		console.log(`Auth: ${config.auth.issuer}`);
	});

	attachWebSocket(server);

	const shutdown = () => {
		console.log('\nShutting down...');
		server.close();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
};
