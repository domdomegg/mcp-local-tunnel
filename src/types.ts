import {z} from 'zod';

export const AuthConfigSchema = z.object({
	issuer: z.url(),
	clientId: z.string().min(1).optional(),
	clientSecret: z.string().optional(),
	scopes: z.array(z.string()).optional(),
	userClaim: z.string().optional(),
});

const ServerEntrySchema = z.object({
	command: z.array(z.string()).optional(),
	url: z.url().optional(),
	env: z.record(z.string(), z.string()).optional(),
});

export const RelayConfigSchema = z.object({
	mode: z.literal('relay'),
	auth: AuthConfigSchema,
	port: z.number().int().positive().optional(),
	host: z.string().optional(),
	issuerUrl: z.url().optional(),
	secret: z.string().optional(),
});

export const AgentConfigSchema = z.object({
	mode: z.literal('agent'),
	relay: z.string().min(1),
	name: z.string().optional(),
	servers: z.record(z.string(), ServerEntrySchema),
});

export const ConfigSchema = z.discriminatedUnion('mode', [RelayConfigSchema, AgentConfigSchema]);

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ServerEntry = z.infer<typeof ServerEntrySchema>;
export type RelayConfig = z.infer<typeof RelayConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

/** Message sent over the WebSocket between relay and agent. */
export type WsMessage =
	| {type: 'tools'; tools: ToolDef[]}
	| {type: 'request'; id: string; method: string; params: unknown}
	| {type: 'response'; id: string; result: unknown}
	| {type: 'error'; id: string; message: string}
	| {type: 'restart'};

export type ToolDef = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, unknown>;
};
