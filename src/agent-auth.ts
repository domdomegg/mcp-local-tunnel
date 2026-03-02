import {createHash, randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {exec} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {renderSuccessPage, renderErrorPage} from './pages.js';

const CLIENT_ID = 'mcp-local-tunnel-agent';
const CONFIG_DIR = join(homedir(), '.config', 'mcp-local-tunnel');

type OAuthMetadata = {
	authorization_endpoint: string;
	token_endpoint: string;
};

type CachedTokens = {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	clientId: string;
};

const getCacheFilePath = (relayHost: string): string => {
	// Sanitize the host for use as a filename
	const safe = relayHost.replaceAll(/[^a-zA-Z0-9.-]/g, '_');
	return join(CONFIG_DIR, `tokens-${safe}.json`);
};

const readCachedTokens = (relayHost: string): CachedTokens | undefined => {
	try {
		const data = readFileSync(getCacheFilePath(relayHost), 'utf-8');
		return JSON.parse(data) as CachedTokens;
	} catch {
		return undefined;
	}
};

const writeCachedTokens = (relayHost: string, tokens: CachedTokens): void => {
	mkdirSync(CONFIG_DIR, {recursive: true});
	writeFileSync(getCacheFilePath(relayHost), JSON.stringify(tokens, undefined, 2), {mode: 0o600});
};

const generatePkce = (): {codeVerifier: string; codeChallenge: string} => {
	const codeVerifier = randomBytes(32).toString('base64url');
	const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
	return {codeVerifier, codeChallenge};
};

const openBrowser = (url: string): void => {
	const command = process.platform === 'darwin'
		? `open "${url}"`
		: process.platform === 'win32'
			? `start "" "${url}"`
			: `xdg-open "${url}"`;
	exec(command, (err) => {
		if (err) {
			console.error('Failed to open browser automatically.');
			console.log(`Please open this URL in your browser:\n  ${url}`);
		}
	});
};

const fetchOAuthMetadata = async (relayBaseUrl: string): Promise<OAuthMetadata> => {
	const url = `${relayBaseUrl}/.well-known/oauth-authorization-server`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to fetch OAuth metadata from ${url}: ${res.status} ${res.statusText}`);
	}

	return res.json() as Promise<OAuthMetadata>;
};

const refreshAccessToken = async (relayBaseUrl: string, refreshToken: string, clientId: string): Promise<CachedTokens | undefined> => {
	const metadata = await fetchOAuthMetadata(relayBaseUrl);
	const params = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: clientId,
	});

	const res = await fetch(metadata.token_endpoint, {
		method: 'POST',
		headers: {'Content-Type': 'application/x-www-form-urlencoded'},
		body: params.toString(),
	});

	if (!res.ok) {
		return undefined;
	}

	const tokens = await res.json() as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};

	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token ?? refreshToken,
		expiresAt: Date.now() + ((tokens.expires_in ?? 3600) * 1000),
		clientId,
	};
};

const performBrowserLogin = async (relayBaseUrl: string): Promise<CachedTokens> => {
	const metadata = await fetchOAuthMetadata(relayBaseUrl);
	const {codeVerifier, codeChallenge} = generatePkce();
	const state = randomBytes(16).toString('base64url');

	// Start a local HTTP server on a random port to receive the callback
	const {callbackUrl, code} = await new Promise<{callbackUrl: string; code: string}>((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url!, 'http://localhost');
			const receivedCode = url.searchParams.get('code');
			const receivedState = url.searchParams.get('state');
			const error = url.searchParams.get('error');

			if (error) {
				res.writeHead(400, {'Content-Type': 'text/html'});
				res.end(renderErrorPage(`Authentication failed: ${url.searchParams.get('error_description') ?? error}. You can close this tab.`));
				server.close();
				reject(new Error(`OAuth error: ${error} - ${url.searchParams.get('error_description') ?? ''}`));
				return;
			}

			if (!receivedCode || receivedState !== state) {
				res.writeHead(400, {'Content-Type': 'text/html'});
				res.end(renderErrorPage('Invalid callback. You can close this tab.'));
				return;
			}

			res.writeHead(200, {'Content-Type': 'text/html'});
			res.end(renderSuccessPage('Authenticated successfully. You can close this tab and return to the terminal.'));
			server.close();

			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			resolve({callbackUrl: `http://localhost:${port}/callback`, code: receivedCode});
		});

		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			const callbackUrl = `http://localhost:${port}/callback`;

			const authorizeUrl = new URL(metadata.authorization_endpoint);
			authorizeUrl.searchParams.set('client_id', CLIENT_ID);
			authorizeUrl.searchParams.set('response_type', 'code');
			authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
			authorizeUrl.searchParams.set('state', state);
			authorizeUrl.searchParams.set('scope', 'openid');
			authorizeUrl.searchParams.set('code_challenge', codeChallenge);
			authorizeUrl.searchParams.set('code_challenge_method', 'S256');

			console.log('Opening browser for authentication...');
			openBrowser(authorizeUrl.toString());
		});

		// Timeout after 5 minutes
		setTimeout(() => {
			server.close();
			reject(new Error('Authentication timed out (5 minutes). Please try again.'));
		}, 300_000);
	});

	// Exchange the code for tokens
	const params = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: callbackUrl,
		client_id: CLIENT_ID,
		code_verifier: codeVerifier,
	});

	const tokenRes = await fetch(metadata.token_endpoint, {
		method: 'POST',
		headers: {'Content-Type': 'application/x-www-form-urlencoded'},
		body: params.toString(),
	});

	if (!tokenRes.ok) {
		const body = await tokenRes.text();
		throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`);
	}

	const tokens = await tokenRes.json() as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};

	const result: CachedTokens = {
		accessToken: tokens.access_token,
		expiresAt: Date.now() + ((tokens.expires_in ?? 3600) * 1000),
		clientId: CLIENT_ID,
	};
	if (tokens.refresh_token) {
		result.refreshToken = tokens.refresh_token;
	}

	return result;
};

/**
 * Get a valid access token for the relay, performing browser-based login if needed.
 * Tokens are cached in ~/.config/mcp-local-tunnel/ and refreshed automatically.
 */
export const getAccessToken = async (relayUrl: string): Promise<string> => {
	// Resolve the relay base URL (HTTPS)
	const relayBaseUrl = relayUrl.startsWith('http')
		? relayUrl.replace(/\/$/, '')
		: `https://${relayUrl}`;

	const relayHost = new URL(relayBaseUrl).host;
	const cached = readCachedTokens(relayHost);

	// If we have a cached token that isn't expired (with 60s buffer), use it
	if (cached && cached.expiresAt > Date.now() + 60_000) {
		return cached.accessToken;
	}

	// Try refreshing if we have a refresh token
	if (cached?.refreshToken) {
		console.log('Access token expired, refreshing...');
		try {
			const refreshed = await refreshAccessToken(relayBaseUrl, cached.refreshToken, cached.clientId);
			if (refreshed) {
				writeCachedTokens(relayHost, refreshed);
				return refreshed.accessToken;
			}
		} catch (err) {
			console.log('Token refresh failed, re-authenticating...', err instanceof Error ? err.message : '');
		}
	}

	// Fall back to browser-based login
	console.log('Authentication required.');
	const tokens = await performBrowserLogin(relayBaseUrl);
	writeCachedTokens(relayHost, tokens);
	console.log('Authentication successful!');
	return tokens.accessToken;
};
