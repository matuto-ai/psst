import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError, TYPES, validateUuid } from './protocol.mjs';
import { presenceSnapshot } from './presence.mjs';

const iso = value => new Date(value).toISOString();
const invalid = field => { throw new ApiError(400, 'invalid_request', field); };
const STATES = ['queued', 'claimed', 'delivered', 'expired', 'failed', 'cancelled'];
const META_COLUMNS = 'id,sender,recipient,state,attempts,uncertain,accepted,expires,claimed_at,delivered_at,terminal_at';
export const ADMIN_PAGE_BYTES = 65536;

// Labels are never identities. Do not publish recognizable local paths from optional metadata.
export function publicLabel(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/(?:^|[\s("'=])(?:\/(?=\S)|~\/|[A-Za-z]:[\\/]|\\\\|file:\/\/)/.test(value)) return '[private path hidden]';
  return [...value].slice(0, 256).join('');
}

/** Admin-only bounded read projections. Never pass these methods to anonymous/v1 routes. */
export class AdminData {
  constructor(store, key = randomBytes(32)) {
    this.store = store;
    this.key = key;
    store.db.exec(`CREATE INDEX IF NOT EXISTS admin_sessions_adapter_id ON sessions(adapter,id);
      CREATE INDEX IF NOT EXISTS admin_sessions_type_id ON sessions(type,id);
      CREATE INDEX IF NOT EXISTS admin_messages_order ON messages(accepted DESC,id DESC);
      CREATE INDEX IF NOT EXISTS admin_messages_sender_order ON messages(sender,accepted DESC,id DESC);
      CREATE INDEX IF NOT EXISTS admin_messages_recipient_order ON messages(recipient,accepted DESC,id DESC);`);
  }
  query(params, allowed) {
    const query = {};
    for (const [key, value] of params) {
      if (!allowed.includes(key) || Object.hasOwn(query, key) || value.length > 2048) invalid('query');
      query[key] = value;
    }
    for (const key of Object.keys(query)) if (query[key] === '') delete query[key];
    if (query.limit !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(query.limit)) invalid('query.limit');
    return query;
  }
  cursor(kind, filters, cursor) {
    if (!cursor) return null;
    const [body, signature, extra] = cursor.split('.');
    if (!body || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) invalid('query.cursor');
    const expected = createHmac('sha256', this.key).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalid('query.cursor');
    let value;
    try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { invalid('query.cursor'); }
    if (value.kind !== kind || !Number.isSafeInteger(value.issued_at) || value.issued_at > this.store.clock() || this.store.clock() - value.issued_at > 900000 || JSON.stringify(value.filters) !== JSON.stringify(filters)) invalid('query.cursor');
    return value;
  }
  continuation(kind, filters, value) {
    const body = Buffer.from(JSON.stringify({ kind, filters, issued_at: this.store.clock(), ...value })).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }
  bounded(rows, project, limit) {
    const items = []; let bytes = 2;
    for (const row of rows) {
      const item = project(row), size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (items.length >= limit || bytes + size > ADMIN_PAGE_BYTES) break;
      items.push(item); bytes += size;
    }
    return items;
  }
  sessions(params) {
    const query = this.query(params, ['client_id', 'installation_id', 'client_type', 'state', 'limit', 'cursor']);
    const filters = Object.fromEntries(['client_id', 'installation_id', 'client_type', 'state', 'limit'].map(k => [k, query[k] ?? '']));
    if (query.client_id) validateUuid(query.client_id, 'query.client_id');
    if (query.installation_id && !/^[-a-zA-Z0-9_.]{1,128}$/.test(query.installation_id)) invalid('query.installation_id');
    if (query.client_type && !TYPES.includes(query.client_type)) invalid('query.client_type');
    if (query.state && !['connected', 'disconnected', 'closed'].includes(query.state)) invalid('query.state');
    const limit = Number(query.limit ?? 10), cursor = this.cursor('sessions', filters, query.cursor), now = this.store.clock();
    const where = ['id > ?'], values = [cursor?.after ?? ''];
    for (const [key, column] of [['client_id', 'id'], ['installation_id', 'adapter'], ['client_type', 'type']]) {
      if (query[key]) { where.push(`${column} = ?`); values.push(query[key]); }
    }
    if (query.state === 'closed') where.push('closed = 1');
    if (query.state === 'connected') { where.push('closed = 0 AND lease_until > ?'); values.push(now); }
    if (query.state === 'disconnected') { where.push('closed = 0 AND lease_until <= ?'); values.push(now); }
    const rows = this.store.db.prepare(`SELECT id,adapter,type,metadata,heartbeat_at,lease_until,closed FROM sessions WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`).all(...values, limit + 1);
    const clients = this.bounded(rows, row => {
      const metadata = JSON.parse(row.metadata);
      // Consume the same presence snapshot as discovery; only presentation hides epoch-zero leases.
      const presence = presenceSnapshot(row, now);
      return { client_id: row.id, installation_id: row.adapter, client_type: row.type,
        name: publicLabel(metadata.name), model: publicLabel(metadata.model?.id), model_provider: publicLabel(metadata.model?.provider), project: publicLabel(metadata.project),
        ...presence, lease_expires_at: row.lease_until > 0 ? presence.lease_expires_at : null };
    }, limit);
    return { clients, next_cursor: rows.length > clients.length ? this.continuation('sessions', filters, { after: clients.at(-1).client_id, issued_at: cursor?.issued_at ?? now }) : null, server_time: iso(now), query, limit };
  }
  metadata(row, now) {
    const state = ['queued', 'claimed'].includes(row.state) && row.expires <= now ? 'expired' : row.state;
    return { message_id: row.id, sender_id: row.sender, recipient_id: row.recipient,
      sender_name: publicLabel(row.sender_name), sender_type: row.sender_type ?? null, recipient_name: publicLabel(row.recipient_name), recipient_type: row.recipient_type ?? null,
      delivery_state: state, attempt_count: row.attempts, delivery_uncertain: !!row.uncertain,
      accepted_at: iso(row.accepted), expires_at: iso(row.expires),
      claimed_at: row.claimed_at == null ? null : iso(row.claimed_at), delivered_at: row.delivered_at == null ? null : iso(row.delivered_at),
      terminal_at: state === 'expired' ? iso(row.terminal_at ?? row.expires) : row.terminal_at == null ? null : iso(row.terminal_at), server_time: iso(now) };
  }
  messages(params) {
    const query = this.query(params, ['sender_id', 'recipient_id', 'status', 'accepted_after', 'accepted_before', 'limit', 'cursor']);
    const filters = Object.fromEntries(['sender_id', 'recipient_id', 'status', 'accepted_after', 'accepted_before', 'limit'].map(k => [k, query[k] ?? '']));
    for (const key of ['sender_id', 'recipient_id']) if (query[key]) validateUuid(query[key], `query.${key}`);
    if (query.status && !STATES.includes(query.status)) invalid('query.status');
    const times = {};
    for (const key of ['accepted_after', 'accepted_before']) if (query[key]) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/.test(query[key]) || !Number.isFinite(Date.parse(query[key]))) invalid(`query.${key}`);
      times[key] = Date.parse(query[key]);
      const normalized = query[key].length === 17 ? query[key].replace('Z', ':00.000Z') : query[key].length === 20 ? query[key].replace('Z', '.000Z') : query[key];
      if (iso(times[key]) !== normalized) invalid(`query.${key}`);
    }
    if (times.accepted_after != null && times.accepted_before != null && times.accepted_after > times.accepted_before) invalid('query.accepted_before');
    const limit = Number(query.limit ?? 10), now = this.store.clock(), cursor = this.cursor('messages', filters, query.cursor);
    const snapshot = cursor?.snapshot ?? this.store.db.prepare('SELECT n FROM history_clock WHERE id=1').get().n;
    const where = ['m.history_order <= ?'], values = [snapshot];
    if (cursor) { where.push('(m.accepted < ? OR (m.accepted = ? AND m.id < ?))'); values.push(cursor.accepted, cursor.accepted, cursor.id); }
    for (const [key, column] of [['sender_id', 'sender'], ['recipient_id', 'recipient']]) {
      if (query[key]) { where.push(`m.${column} = ?`); values.push(query[key]); }
    }
    // Match the shared history API's deadline fact without unbounded expiry writes.
    if (query.status) { where.push("(CASE WHEN m.state IN ('queued','claimed') AND m.expires<=? THEN 'expired' ELSE m.state END) = ?"); values.push(now, query.status); }
    for (const [key, op] of [['accepted_after', '>='], ['accepted_before', '<=']]) if (times[key] != null) { where.push(`m.accepted ${op} ?`); values.push(times[key]); }
    // Deliberately never SELECT envelope on list requests.
    const rows = this.store.db.prepare(`SELECT ${META_COLUMNS.split(',').map(c => 'm.' + c).join(',')},json_extract(s.metadata,'$.name') sender_name,s.type sender_type,json_extract(r.metadata,'$.name') recipient_name,r.type recipient_type FROM messages m LEFT JOIN sessions s ON s.id=m.sender LEFT JOIN sessions r ON r.id=m.recipient WHERE ${where.join(' AND ')} ORDER BY m.accepted DESC,m.id DESC LIMIT ?`).all(...values, limit + 1);
    const messages = this.bounded(rows, row => this.metadata(row, now), limit), last = rows[messages.length - 1];
    return { messages, next_cursor: rows.length > messages.length ? this.continuation('messages', filters, { snapshot, accepted: last.accepted, id: last.id, issued_at: cursor?.issued_at ?? now }) : null, server_time: iso(now), query, limit };
  }
  message(id) {
    validateUuid(id, 'path.message_id');
    const row = this.store.db.prepare(`SELECT ${META_COLUMNS},envelope FROM messages WHERE id=?`).get(id);
    if (!row) throw new ApiError(404, 'message_not_found');
    const envelope = row.envelope ? JSON.parse(row.envelope) : null;
    return { ...this.metadata(row, this.store.clock()), content: envelope?.content ? { type: envelope.content.type, text: envelope.content.text } : null };
  }
}
