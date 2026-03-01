import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {OAuthClientInformationFull} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {AuthorizationParams} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {mcpAuthRouter, getOAuthProtectedResourceMetadataUrl} from '@modelcontextprotocol/sdk/server/auth/router.js';
import {requireBearerAuth} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express from 'express';
import {WebSocketServer} from 'ws';
import type {Server as HttpServer} from 'node:http';
import type {TunnelOAuthProvider} from './oauth-provider.js';
import type {OidcClient} from './oidc-client.js';
import type {ConnectionManager} from './connection-manager.js';
import type {RelayConfig} from './types.js';
import {createRelayMcpServer} from './relay-mcp-server.js';

const getString = (value: unknown): string | undefined =>
	typeof value === 'string' ? value : undefined;

export const createRelayApp = (
	config: RelayConfig,
	provider: TunnelOAuthProvider,
	oidcClient: OidcClient,
	connectionManager: ConnectionManager,
): {app: express.Express; attachWebSocket: (server: HttpServer) => void} => {
	const app = express();
	const getBaseUrl = () => config.issuerUrl ?? `http://localhost:${config.port ?? 3000}`;
	const issuerUrl = new URL(getBaseUrl());
	const mcpUrl = new URL('/mcp', issuerUrl);

	// Custom /authorize handler — accepts any client_id and redirect_uri
	app.all('/authorize', (req, res) => {
		const params = req.method === 'POST' ? req.body as Record<string, unknown> : req.query;

		const clientId = getString(params.client_id);
		const redirectUri = getString(params.redirect_uri);
		const codeChallenge = getString(params.code_challenge);
		const codeChallengeMethod = getString(params.code_challenge_method);
		const scope = getString(params.scope);
		const state = getString(params.state);

		if (!clientId || !redirectUri || !codeChallenge) {
			res.status(400).json({error: 'invalid_request', error_description: 'Missing client_id, redirect_uri, or code_challenge'});
			return;
		}

		if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
			res.status(400).json({error: 'invalid_request', error_description: 'code_challenge_method must be S256'});
			return;
		}

		const client = {client_id: clientId, redirect_uris: [redirectUri]} as OAuthClientInformationFull;
		const authParams: AuthorizationParams = {
			scopes: scope ? scope.split(' ') : [],
			redirectUri,
			codeChallenge,
		};
		if (state) {
			authParams.state = state;
		}

		void provider.authorize(client, authParams, res).catch((err: unknown) => {
			console.error('Authorize error:', err);
			if (!res.headersSent) {
				res.status(500).json({error: 'server_error'});
			}
		});
	});

	// OAuth routes (discovery, token, register, revoke)
	const noRateLimit = {rateLimit: false as const};
	app.use(mcpAuthRouter({
		provider,
		issuerUrl,
		baseUrl: issuerUrl,
		resourceServerUrl: mcpUrl,
		tokenOptions: noRateLimit,
		authorizationOptions: noRateLimit,
		clientRegistrationOptions: noRateLimit,
		revocationOptions: noRateLimit,
	}));

	// OIDC callback
	app.get('/callback', async (req, res) => {
		try {
			const code = getString(req.query.code);
			const sealedState = getString(req.query.state);

			if (!code || !sealedState) {
				res.status(400).send('Missing code or state parameter');
				return;
			}

			const pending = provider.unsealState(sealedState);
			if (!pending) {
				res.status(400).send('Invalid or expired authorization session');
				return;
			}

			const callbackUrl = `${getBaseUrl()}/callback`;
			const {userId} = await oidcClient.exchangeCode(code, callbackUrl, pending.upstreamCodeVerifier);

			const {redirectUrl} = provider.completeAuthorization(pending, userId);
			res.redirect(redirectUrl);
		} catch (err) {
			console.error('Callback error:', err);
			res.status(500).send('Authentication failed');
		}
	});

	// Protected MCP endpoint
	const bearerAuth = requireBearerAuth({
		verifier: provider,
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
	});

	app.all('/mcp', bearerAuth, async (req, res) => {
		const userId = getString(req.auth?.extra?.userId);
		if (!userId) {
			res.status(401).json({error: 'Missing user identity'});
			return;
		}

		const transport = new StreamableHTTPServerTransport({
			enableJsonResponse: true,
		});

		const server = createRelayMcpServer(connectionManager, userId);
		await server.connect(transport as unknown as Transport);

		await transport.handleRequest(req, res);
	});

	// WebSocket upgrade handler for agent connections
	const attachWebSocket = (httpServer: HttpServer) => {
		const wss = new WebSocketServer({noServer: true});

		httpServer.on('upgrade', async (req, socket, head) => {
			if (req.url?.startsWith('/ws')) {
				// Extract bearer token from query param or header
				const url = new URL(req.url, `http://${req.headers.host}`);
				const token = url.searchParams.get('token')
					?? req.headers.authorization?.replace(/^Bearer /i, '');
				const name = url.searchParams.get('name') ?? 'default';

				if (!token) {
					socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
					socket.destroy();
					return;
				}

				try {
					const authInfo = await provider.verifyAccessToken(token);
					const userId = getString(authInfo.extra?.userId);
					if (!userId) {
						socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
						socket.destroy();
						return;
					}

					wss.handleUpgrade(req, socket, head, (ws) => {
						connectionManager.addConnection(ws, userId, name);
					});
				} catch {
					socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
					socket.destroy();
				}
			} else {
				socket.destroy();
			}
		});
	};

	return {app, attachWebSocket};
};
