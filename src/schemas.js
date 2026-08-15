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
  z.object({
    connections: z.array(connectionInfoSchema),
    activeConnectionId: z.string().nullable()
  })
);

// ── saved SSH resources ────────────────────────────────────────────────────

const profileIdSchema = z.string().uuid();
const groupIdSchema = z.string().uuid();
export const profileAuthKindSchema = z.enum(["password", "key"]);

const profileMetadataSchema = z.object({
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128),
  authKind: profileAuthKindSchema
});

export const profileSaveRequestSchema = profileMetadataSchema.extend({
  profileId: profileIdSchema.optional(),
  groupId: groupIdSchema.nullable().optional()
});

export const profileCredentialRefsSchema = z.object({
  password: z.string(),
  privateKey: z.string(),
  passphrase: z.string()
});

export const profileInfoSchema = profileMetadataSchema.extend({
  profileId: profileIdSchema,
  groupId: groupIdSchema.nullable(),
  groupName: z.string().nullable(),
  credentialConfigured: z.boolean(),
  passphraseConfigured: z.boolean(),
  connected: z.boolean()
});

export const profileSaveResultSchema = resultSchema(
  z.object({
    profile: profileInfoSchema,
    credentialRefs: profileCredentialRefsSchema
  })
);

export const profileListRequestSchema = z.object({});
export const profileListResultSchema = resultSchema(
  z.object({ profiles: z.array(profileInfoSchema) })
);

export const profileDeleteRequestSchema = z.object({ profileId: profileIdSchema });
export const profileDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean() }));

export const profileConnectRequestSchema = z.object({ profileId: profileIdSchema });
export const profileConnectResultSchema = connectResultSchema;

export const groupInfoSchema = z.object({
  groupId: groupIdSchema,
  name: z.string(),
  profileCount: z.number().int().nonnegative()
});
export const groupListRequestSchema = z.object({});
export const groupListResultSchema = resultSchema(z.object({ groups: z.array(groupInfoSchema) }));
export const groupSaveRequestSchema = z.object({ groupId: groupIdSchema.optional(), name: z.string().min(1).max(80) });
export const groupSaveResultSchema = resultSchema(z.object({ group: groupInfoSchema }));
export const groupDeleteRequestSchema = z.object({ groupId: groupIdSchema });
export const groupDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean(), movedProfiles: z.number().int().nonnegative() }));

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
