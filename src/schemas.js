/**
 * Zod schemas for the dsh-ssh-ops wire contract. Bundled into both faces:
 * the host typert manifest validates incoming args and outgoing results, and
 * the client contribution validates the same envelope on the browser side.
 */
import { z } from "zod";

export const sshErrorSchema = z.object({
  code: z.string(),
  message: z.string()
});

export function okSchema(value) {
  return z.object({ ok: z.literal(true), value });
}

export function resultSchema(value) {
  return z.union([
    okSchema(value),
    z.object({ ok: z.literal(false), error: sshErrorSchema })
  ]);
}

// ── auth ────────────────────────────────────────────────────────────────────

export const passwordAuthSchema = z.object({
  kind: z.literal("password"),
  password: z.string()
});

export const keyAuthSchema = z.object({
  kind: z.literal("key"),
  privateKey: z.string(),
  passphrase: z.string().optional()
});

export const authSchema = z.union([passwordAuthSchema, keyAuthSchema]);

// ── connect ─────────────────────────────────────────────────────────────────

export const connectRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  auth: authSchema,
  readyTimeout: z.number().int().min(1000).max(120000).optional(),
  name: z.string().optional()
});

export const connectResultSchema = resultSchema(
  z.object({
    connectionId: z.string(),
    name: z.string().optional(),
    host: z.string(),
    port: z.number(),
    username: z.string()
  })
);

// ── list ────────────────────────────────────────────────────────────────────

export const listRequestSchema = z.object({});

export const connectionInfoSchema = z.object({
  connectionId: z.string(),
  name: z.string().optional(),
  host: z.string(),
  port: z.number(),
  username: z.string(),
  connected: z.boolean(),
  sessions: z.array(z.string())
});

export const listResultSchema = resultSchema(
  z.object({ connections: z.array(connectionInfoSchema) })
);

// ── open shell session ──────────────────────────────────────────────────────

export const openSessionRequestSchema = z.object({
  connectionId: z.string().min(1),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(200).optional()
});

export const sessionInfoSchema = z.object({
  sessionId: z.string(),
  connectionId: z.string(),
  cols: z.number(),
  rows: z.number(),
  alive: z.boolean()
});

export const openSessionResultSchema = resultSchema(sessionInfoSchema);

// ── write ───────────────────────────────────────────────────────────────────

export const writeRequestSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string()
});

export const writeResultSchema = resultSchema(
  z.object({ written: z.number() })
);

// ── read ────────────────────────────────────────────────────────────────────

export const readRequestSchema = z.object({
  sessionId: z.string().min(1),
  timeoutMs: z.number().int().min(0).max(60000).optional()
});

export const readResultSchema = resultSchema(
  z.object({
    data: z.string(),
    exit: z.union([z.object({ code: z.number(), signal: z.number().optional() }), z.null()])
  })
);

// ── resize ──────────────────────────────────────────────────────────────────

export const resizeRequestSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200)
});

export const resizeResultSchema = resultSchema(
  z.object({ cols: z.number(), rows: z.number() })
);

// ── close session ───────────────────────────────────────────────────────────

export const closeSessionRequestSchema = z.object({
  sessionId: z.string().min(1)
});

export const closeSessionResultSchema = resultSchema(
  z.object({ closed: z.boolean() })
);

// ── disconnect ──────────────────────────────────────────────────────────────

export const disconnectRequestSchema = z.object({
  connectionId: z.string().min(1)
});

export const disconnectResultSchema = resultSchema(
  z.object({ disconnected: z.boolean() })
);
