import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warning', 'error']);
const context = new AsyncLocalStorage();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sourceFiles = new Set(['main.mjs','server.mjs','store.mjs','auth.mjs','approval.mjs','enrollment.mjs','presence.mjs','settings.mjs','admin.mjs','admin-data.mjs','protocol.mjs']);
const publicCodes = new Set(['invalid_request','unauthenticated','forbidden','recipient_not_found','message_not_found','retry_window_elapsed','history_changed','content_unavailable','identity_conflict','stale_lease_epoch','idempotency_conflict','metadata_conflict','claim_conflict','registration_upgrade_required','session_closed','message_expired','payload_too_large','incompatible_receiver_transport','receiving_disabled','rate_limited','mailbox_full','storage_unavailable','not_ready']);
const tokens = new Set(['statement','store_closed','store_poisoned','disk_check_error','unsupported_filesystem','disk_space_low','database_size_limit','explicit_disconnect','ttl_expired','retention_elapsed','begin','body','before_commit','commit_attempt','commit','after_commit','rollback','before_rollback','safe','startup','shutdown','reload','sweep','readiness','closed','poisoned','disk_check_failed','disk_limits','storage_guard','database_unavailable','transaction_failed','rollback_failed','automatic_rollback','commit_uncertain','ready','not_ready','no_credentials','stopping','recovered','unchanged','created','replayed','approved','denied','revoked','pending','expired','connected','disconnected','queued','claimed','delivered','failed','cancelled','register','registration','heartbeat','metadata','close','disconnect','send','resend','cancel','claim','renew','complete','receipt','history','content','list','status','request','decide','credentials','authentication','authorization','configuration','settings','maintenance','policy','client','unknown','not_applied','applied','disabled','enabled','debug','info','warning','error']);
const numericFields = new Set(['status','count','duration_ms','epoch','changes','repeated','sqlite_code','bytes','expires_at','retry_after','heartbeat_seconds','lease_seconds','claim_seconds']);
const booleanFields = new Set(['retryable','committed','commit_attempted','rollback_confirmed','poisoned','transaction_active','replayed','ready']);
const idFields = new Set(['request_id','message_id','client_id','authorization_id']);
const tokenFields = new Set(['phase','reason','operation','effect','state','level','previous_level']);
const routes = new Set(['/healthz','/readyz','/','/admin','/admin/*','/v1/enrollment-requests','/v1/enrollment-requests/:id','/v1/enrollments','/v1/sessions','/v1/sessions/:id','/v1/sessions/:id/heartbeat','/v1/sessions/:id/metadata','/v1/sessions/:id/close','/v1/sessions/:id/disconnect','/v1/clients','/v1/messages','/v1/messages/:id','/v1/messages/:id/content','/v1/messages/:id/resend','/v1/messages/:id/cancel','/v1/mailbox/claim','/v1/mailbox/:id/renew','/v1/mailbox/:id/complete','/v1/presence-events','/v1/presence-events/:id/ack','unknown']);

export function normalizedRoute(raw) {
  try {
    const pathname = new URL(raw, 'http://broker.invalid').pathname;
    if (pathname.startsWith('/admin/')) return '/admin/*';
    const normalized = pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id');
    return routes.has(normalized) ? normalized : 'unknown';
  } catch { return 'unknown'; }
}
function safeFields(fields) {
  const result = {};
  if (!fields || typeof fields !== 'object') return result;
  for (const [key, value] of Object.entries(fields)) {
    if (numericFields.has(key) && Number.isFinite(value) && value >= 0) result[key] = value;
    else if (booleanFields.has(key) && typeof value === 'boolean') result[key] = value;
    else if (idFields.has(key) && typeof value === 'string' && uuid.test(value)) result[key] = value;
    else if (tokenFields.has(key) && tokens.has(value)) result[key] = value;
    else if (key === 'code' && publicCodes.has(value)) result[key] = value;
    else if (key === 'method' && ['GET','POST','PATCH','HEAD','OPTIONS','DELETE','PUT'].includes(value)) result[key] = value;
    else if (key === 'route' && routes.has(value)) result[key] = value;
  }
  return result;
}
const systemReasons = Object.freeze({ ENOENT:'file_missing', EACCES:'permission_denied', EPERM:'permission_denied', ENOSPC:'disk_full', EIO:'io_failure', EROFS:'read_only_filesystem', EMFILE:'file_descriptor_limit', EBUSY:'resource_busy', EADDRINUSE:'address_in_use', EADDRNOTAVAIL:'address_unavailable', ECONNRESET:'connection_reset', EPIPE:'connection_closed', ETIMEDOUT:'timeout' });
const sqliteReasons = Object.freeze({1:'sqlite_statement_error',5:'sqlite_busy',6:'sqlite_locked',7:'sqlite_out_of_memory',8:'sqlite_read_only',10:'sqlite_io_failure',11:'sqlite_corrupt',13:'sqlite_disk_full',14:'sqlite_cannot_open',17:'sqlite_schema_changed',18:'sqlite_value_too_large',19:'sqlite_constraint',21:'sqlite_misuse',23:'sqlite_authorization',26:'sqlite_not_database'});
/** Inspect only explicitly supported error metadata. Never read message, SQL or paths. */
export function diagnostic(error) {
  try {
    const info = { reason: 'unexpected_error' };
    if (Number.isInteger(error?.errcode) && error.errcode > 0 && error.errcode <= 65535) {
      info.sqlite_code = error.errcode;
      info.reason = sqliteReasons[error.errcode & 255] ?? 'sqlite_failure';
      if (error.errcode === 6410) {
        info.reason = 'sqlite_temp_directory_unavailable';
        info.sqlite_name = 'SQLITE_IOERR_GETTEMPPATH';
        info.hint = 'Mount a writable /tmp (tmpfs) in the container; keep /data unchanged.';
      }
    } else if (Object.hasOwn(systemReasons, error?.code ?? '')) info.reason = systemReasons[error.code];
    else if (publicCodes.has(error?.code)) { info.reason = 'api_rejection'; info.code = error.code; }
    else if (['invalid_authorization_days','missing_configuration','invalid_log_format'].includes(error?.code)) { info.reason = 'invalid_configuration'; info.code = error.code; }
    else if (error?.name === 'SyntaxError') info.reason = 'invalid_json_or_syntax';
    else if (error?.name === 'TypeError') info.reason = 'invalid_type';
    else if (error?.name === 'RangeError') info.reason = 'out_of_range';
    // Keep only source locations, never the first line, function names or full paths.
    const stack = [];
    if (typeof error?.stack === 'string') for (const line of error.stack.split('\n').slice(1, 25)) {
      const match = /(?:\/|\\)([a-z-]+\.mjs):(\d{1,7}):(\d{1,7})\)?$/.exec(line);
      if (match && sourceFiles.has(match[1])) stack.push(`${match[1]}:${match[2]}:${match[3]}`);
      if (stack.length === 6) break;
    }
    if (stack.length) info.stack = stack;
    return info;
  } catch { return { reason: 'diagnostic_unavailable' }; }
}
export function withLogContext(fields, fn) { return context.run({ ...context.getStore(), ...safeFields(fields) }, fn); }
export const nullLogger = Object.freeze({ log() {} });
/** The boundary also protects callers using an injected/test logger that throws. */
export function log(logger, level, event, fields = {}, error) {
  try { logger?.log(level, event, fields, error); } catch { /* Diagnostics cannot change an operation's result. */ }
}

function humanMessage(event, fields, info) {
  const words = event.slice(5).toLowerCase().replaceAll('_', ' ');
  let message = words[0].toUpperCase() + words.slice(1) + '.';
  if (info?.reason === 'sqlite_temp_directory_unavailable') message += ' SQLite cannot find a writable temporary directory. ' + info.hint;
  else if (info?.reason === 'invalid_configuration' && info.code === 'invalid_log_format') message += ' PSST_LOG_FORMAT must be text or json.';
  if (event === 'PSST_STORAGE_TRANSACTION_FAILED') {
    message += fields.effect === 'not_applied' ? ' Rolled back; nothing was saved.' : ' Outcome uncertain; reconcile using the original idempotency key.';
    if (fields.poisoned) message += ' Storage is unusable; fix the storage failure before restarting.';
  }
  if (event === 'PSST_HTTP_REQUEST_FAILED' && fields.code === 'stale_lease_epoch') message += ' Session lease is stale; the client must register again.';
  return message;
}
function textRecord(record, debug) {
  const { timestamp, level, event, message, version, run_id, error, method, route, ...fields } = record;
  const details = Object.entries(fields)
    .filter(([key, value]) => value !== false || !['committed','commit_attempted','transaction_active'].includes(key))
    .map(([key, value]) => `${key}=${value}`);
  if (['PSST_BROKER_STARTED','PSST_STARTUP_FAILED'].includes(event)) details.push(`version=${version}`, `run_id=${run_id}`);
  if (method || route) details.unshift([method, route].filter(Boolean).join(' '));
  if (error) {
    details.push(`cause=${error.reason}`);
    if (error.code && !fields.code) details.push(`code=${error.code}`);
    if (error.sqlite_code) details.push(`sqlite=${error.sqlite_name ?? error.sqlite_code}${error.sqlite_name ? `(${error.sqlite_code})` : ''}`);
    if (debug && error.stack) details.push(`at=${error.stack.join(',')}`);
  }
  return `${timestamp} ${level.toUpperCase()} ${event}: ${message}${details.length ? ' | ' + details.join(' ') : ''}\n`;
}

export class Logger {
  constructor({ level = 'info', format = 'text', sink = line => writeSync(2, line), clock = Date.now, version = 'unknown' } = {}) {
    this.setLevel(level); this.setFormat(format); this.sink = sink; this.clock = clock; this.runId = randomUUID(); this.backgroundFailures = new Map();
    this.version = /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown';
  }
  setLevel(level) {
    if (!LOG_LEVELS.includes(level)) throw new Error('Log level must be debug, info, warning or error.');
    this.level = level;
  }
  setFormat(format) {
    if (!['text', 'json'].includes(format)) throw Object.assign(new Error('Log format must be text or json.'), {code:'invalid_log_format'});
    this.format = format;
  }
  log(level, event, fields = {}, error) {
    try {
      if (!LOG_LEVELS.includes(level)) return;
      if (typeof event !== 'string' || !/^PSST_[A-Z0-9_]{1,80}$/.test(event)) return;
      const metadata = { ...safeFields(context.getStore()), ...safeFields(fields) };
      // Only the owning operation can declare recovery. Another successful
      // transaction (for example sweep after failed auth reload) proves nothing.
      const recoveredOperation = ({PSST_AUTH_RELOAD_RECOVERED:'authentication',PSST_AUTH_MAINTENANCE_RECOVERED:'authentication',PSST_MAINTENANCE_RECOVERED:'sweep'})[event];
      if (recoveredOperation) for (const [key, entry] of this.backgroundFailures) {
        if (entry.operation === recoveredOperation) this.backgroundFailures.delete(key);
      }
      if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.level)) return;
      const info = error === undefined ? undefined : diagnostic(error);
      if (!metadata.request_id && ['PSST_STORAGE_TRANSACTION_FAILED','PSST_STORAGE_ROLLBACK_FAILED'].includes(event)) {
        const key = `${event}:${metadata.operation}:${metadata.phase}:${info?.reason}`, now = this.clock(), prior = this.backgroundFailures.get(key);
        if (prior) {
          prior.count++;
          if (now - prior.at < 60000) return;
          metadata.repeated = prior.count; prior.count = 0; prior.at = now;
        } else {
          if (this.backgroundFailures.size >= 32) return;
          this.backgroundFailures.set(key, { at: now, count: 0, operation: metadata.operation });
        }
      }
      const record = { timestamp: new Date(this.clock()).toISOString(), level, event, message: humanMessage(event, metadata, info), version: this.version, run_id: this.runId, ...metadata };
      if (info !== undefined) record.error = info;
      this.sink(this.format === 'json' ? JSON.stringify(record) + '\n' : textRecord(record, this.level === 'debug'));
    } catch { /* Logging is best effort, including serialization and sink failures. */ }
  }
}

/** One fixed key per maintenance operation. Repeats are summarized once a minute. */
export class FailureTracker {
  constructor(logger, { clock = Date.now, intervalMs = 60000 } = {}) { this.logger = logger; this.clock = clock; this.intervalMs = intervalMs; this.failures = new Map(); }
  fail(key, event, fields, error) {
    try {
      const now = this.clock(), prior = this.failures.get(key);
      if (!prior) {
        if (this.failures.size >= 32) return;
        this.failures.set(key, { at: now, count: 0 }); log(this.logger, 'error', event, fields, error);
      } else {
        prior.count++;
        if (now - prior.at >= this.intervalMs) { log(this.logger, 'error', event, { ...fields, repeated: prior.count }, error); prior.at = now; prior.count = 0; }
      }
    } catch {}
  }
  recover(key, event, fields = {}) {
    try {
      const prior = this.failures.get(key);
      if (!prior) return;
      this.failures.delete(key); log(this.logger, 'info', event, { ...fields, repeated: prior.count });
    } catch {}
  }
}
