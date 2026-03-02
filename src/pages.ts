// eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS module, can't use import.meta
const pkg = require('../package.json') as {version: string; repository?: {url?: string}};
const {version} = pkg;
const repoUrl = pkg.repository?.url?.replace(/\.git$/, '').replace(/^git\+/, '') ?? 'https://github.com/domdomegg/mcp-local-tunnel';

const VARS_LIGHT = `--bg: #fafafa; --fg: #111; --muted: #888; --subtle: #666;
      --btn-bg: #111; --btn-fg: #fafafa; --btn-hover: #333;
      --error: #b91c1c;
      --footer: #aaa; --footer-hover: #888;`;

const VARS_DARK = `--bg: #161616; --fg: #e5e5e5; --muted: #777; --subtle: #999;
      --btn-bg: #e5e5e5; --btn-fg: #161616; --btn-hover: #ccc;
      --error: #f87171;
      --footer: #555; --footer-hover: #777;`;

const BASE = `* { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace; padding: 48px 24px; max-width: 520px; margin: 0 auto; background: var(--bg); color: var(--fg); }
  h1 { font-size: 14px; text-transform: uppercase; letter-spacing: 2px; font-weight: 700; color: var(--muted); }`;

const FOOTER = `footer { margin-top: 32px; font-size: 10px; color: var(--footer); }
  footer a { color: var(--footer); text-decoration: none; }
  footer a:hover { color: var(--footer-hover); border-bottom: 1px solid var(--footer-hover); }`;

const CENTER_CSS = `h1 { margin-bottom: 0; }
  .center { text-align: center; margin-top: 80px; }
  .msg { font-size: 13px; line-height: 1.6; margin-top: 12px; color: var(--subtle); }`;

const footerHtml = `<footer><a href="${escapeHtml(repoUrl)}">mcp-local-tunnel</a> v${escapeHtml(version)}</footer>`;

const pageHead = (title: string, extraCss: string) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="generator" content="mcp-local-tunnel">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  @media (prefers-color-scheme: light) { :root { ${VARS_LIGHT} } }
  @media (prefers-color-scheme: dark) { :root { ${VARS_DARK} } }
  ${BASE}
  ${extraCss}
  ${FOOTER}
</style>
</head>`;

export const renderSuccessPage = (message: string): string => `${pageHead('Authenticated', CENTER_CSS)}
<body>
<div class="center">
<h1>MCP Local Tunnel</h1>
<p class="msg">${escapeHtml(message)}</p>
${footerHtml}
</div>
</body>
</html>`;

export const renderErrorPage = (message: string): string => `${pageHead('Authentication failed', `${CENTER_CSS}
  .msg-err { color: var(--error); }`)}
<body>
<div class="center">
<h1>MCP Local Tunnel</h1>
<p class="msg msg-err">${escapeHtml(message)}</p>
${footerHtml}
</div>
</body>
</html>`;

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
