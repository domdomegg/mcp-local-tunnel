import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {
	test, expect, beforeAll, afterAll,
} from 'vitest';
import {createRelayApp} from './relay-server.js';
import {TunnelOAuthProvider} from './oauth-provider.js';
import type {OidcClient} from './oidc-client.js';
import type {ConnectionManager} from './connection-manager.js';
import type {RelayConfig} from './types.js';

const fakeOidcClient = {
	generateCodeVerifierAndChallenge: () => ({codeVerifier: 'v', codeChallenge: 'c'}),
	buildAuthorizeUrl: async ({state}: {state: string}) => `https://idp.example/authorize?state=${encodeURIComponent(state)}`,
	exchangeCode: async () => ({userId: 'user-1'}),
} as unknown as OidcClient;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
	const config: RelayConfig = {mode: 'relay', auth: {issuer: 'https://idp.example'}, secret: 'test-secret'};
	const provider = new TunnelOAuthProvider(fakeOidcClient, config);
	const {app} = createRelayApp(config, provider, fakeOidcClient, {} as ConnectionManager);
	server = app.listen(0);
	await new Promise((resolve) => {
		server.once('listening', resolve);
	});
	baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.close();
});

// Runs /authorize then the IdP callback, returning the response that hands the code to the client
const authorizeWith = async (redirectUri: string): Promise<Response> => {
	const authorizeUrl = new URL(`${baseUrl}/authorize`);
	authorizeUrl.searchParams.set('client_id', 'any-client');
	authorizeUrl.searchParams.set('redirect_uri', redirectUri);
	authorizeUrl.searchParams.set('response_type', 'code');
	authorizeUrl.searchParams.set('code_challenge', 'challenge');
	authorizeUrl.searchParams.set('code_challenge_method', 'S256');

	const res = await fetch(authorizeUrl, {redirect: 'manual'});
	if (res.status !== 302) {
		return res;
	}

	const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
	return fetch(`${baseUrl}/callback?code=idp-code&state=${encodeURIComponent(state)}`, {redirect: 'manual'});
};

test.each([
	// eslint-disable-next-line no-script-url
	'javascript:alert(1)//',
	'data:text/html,hi',
	'not a url',
])('rejects %s', async (redirectUri) => {
	expect((await authorizeWith(redirectUri)).status).toBe(400);
});

test.each([
	'http://localhost:9999/callback',
	'https://claude.ai/api/mcp/auth_callback',
])('redirects straight to trusted %s', async (redirectUri) => {
	const res = await authorizeWith(redirectUri);
	expect(res.status).toBe(302);
	expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy();
});

test('asks before handing a code to an untrusted redirect URI', async () => {
	const res = await authorizeWith('https://attacker.example/cb');
	expect(res.status).toBe(200);
	expect(res.headers.get('x-frame-options')).toBe('DENY');
	const html = await res.text();
	expect(html).toContain('This will give <strong>attacker.example</strong> access');
	expect(html).toContain('href="https://attacker.example/cb?code=');
});
