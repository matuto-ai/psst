import { ApiError, DEFAULTS } from './protocol.mjs';
import { log } from './logger.mjs';

// These clocks affect only newly created records. Protocol leases and retention
// are intentionally not editable here.
export const SETTING_DEFINITIONS = Object.freeze({
  log_level: { label: 'Log level', default: 'info', values: ['debug', 'info', 'warning', 'error'], env: 'PSST_LOG_LEVEL', timing: 'Applies immediately to subsequent log events.' },
  authorization_days: { label: 'Installation authorization', default: 90, min: 1, max: 3650, unit: 'days', env: 'PSST_AUTHORIZATION_DAYS', timing: 'Applies to future approval grants. Existing authorizations keep their expiry.' },
  pending_request_hours: { label: 'Pending approval request', default: 24, min: 1, max: 24, unit: 'hours', env: 'PSST_PENDING_REQUEST_HOURS', timing: 'Applies to new approval requests. Existing request deadlines are unchanged.' },
  admin_session_hours: { label: 'Administrator session', default: 8, min: 1, max: 168, unit: 'hours', env: 'PSST_ADMIN_SESSION_HOURS', timing: 'Applies at the next successful login. Existing sessions are unchanged.' },
  default_message_ttl_seconds: { label: 'Default message lifetime', default: DEFAULTS.default_ttl_seconds, min: 60, max: 604800, unit: 'seconds', env: 'PSST_DEFAULT_MESSAGE_TTL_SECONDS', timing: 'Applies to new messages without an explicit TTL. Existing messages and explicit TTLs are unchanged.' },
});
const invalid = key => new ApiError(400, 'invalid_request', Object.hasOwn(SETTING_DEFINITIONS, key) ? key : 'settings');
function valueFor(key, value, limits = {}) {
  const definition = SETTING_DEFINITIONS[key];
  if (!Object.hasOwn(SETTING_DEFINITIONS, key)) throw invalid(key);
  if (definition.values) {
    if (!definition.values.includes(value)) throw invalid(key);
    return value;
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) value = Number(value);
  const min = key === 'default_message_ttl_seconds' ? (limits.min_ttl_seconds ?? definition.min) : definition.min;
  const max = key === 'default_message_ttl_seconds' ? (limits.max_ttl_seconds ?? definition.max) : definition.max;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(key);
  return value;
}
export function validateSettingsOverrides({ env = {}, config = {}, limits = {} } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid('settings');
  const overrides = {};
  for (const [key, value] of Object.entries(config)) overrides[key] = { value: valueFor(key, value, limits), source: 'Configuration file', locked: true };
  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
    if (env[definition.env] !== undefined) overrides[key] = { value: valueFor(key, env[definition.env], limits), source: `Environment: ${definition.env}`, locked: true };
  }
  return overrides;
}
// Resolve the operator-owned startup configuration without touching storage.
export function settingsOptionsFromConfiguration(config = {}, env = {}) {
  const settings = config.settings === undefined ? {} : config.settings;
  if (config.settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings))) throw invalid('settings');
  const values = { ...settings };
  if (config.limits?.default_ttl_seconds !== undefined) {
    if (values.default_message_ttl_seconds !== undefined && values.default_message_ttl_seconds !== config.limits.default_ttl_seconds) throw invalid('default_message_ttl_seconds');
    values.default_message_ttl_seconds = config.limits.default_ttl_seconds;
  }
  const overrides = validateSettingsOverrides({ env, config: values, limits: config.limits });
  const limits = { ...config.limits };
  if (overrides.default_message_ttl_seconds) limits.default_ttl_seconds = overrides.default_message_ttl_seconds.value;
  return { config: values, overrides, limits };
}
export class SettingsService {
  constructor({ store, env = {}, config = {}, onChange = () => {} }) {
    this.store = store;
    this.onChange = onChange;
    this.overrides = validateSettingsOverrides({ env, config, limits: store.limits });
    store.tx(() => store.db.exec('CREATE TABLE IF NOT EXISTS broker_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'));
    // Fail closed on invalid persisted values rather than silently changing policy.
    for (const row of store.db.prepare('SELECT key,value FROM broker_settings').all()) valueFor(row.key, JSON.parse(row.value), store.limits);
    store.limits.default_ttl_seconds = this.get('default_message_ttl_seconds');
  }
  get(key) {
    if (!Object.hasOwn(SETTING_DEFINITIONS, key)) throw invalid(key);
    if (this.overrides[key]) return this.overrides[key].value;
    const row = this.store.db.prepare('SELECT value FROM broker_settings WHERE key=?').get(key);
    return valueFor(key, row ? JSON.parse(row.value) : SETTING_DEFINITIONS[key].default, this.store.limits);
  }
  snapshot() {
    return Object.entries(SETTING_DEFINITIONS).map(([key, definition]) => ({
      ...definition, key, value: this.get(key), locked: !!this.overrides[key],
      source: this.overrides[key]?.source ?? (this.store.db.prepare('SELECT 1 FROM broker_settings WHERE key=?').get(key) ? 'Saved in Settings' : 'Built-in default'),
      ...(key === 'default_message_ttl_seconds' ? { min: this.store.limits.min_ttl_seconds, max: this.store.limits.max_ttl_seconds } : {}),
    }));
  }
  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('settings');
    this.store.tx(() => {
      const values = Object.entries(patch).map(([key, value]) => {
        if (!Object.hasOwn(SETTING_DEFINITIONS, key) || this.overrides[key]) throw invalid(key);
        return [key, valueFor(key, value, this.store.limits)];
      });
      const save = this.store.db.prepare('INSERT INTO broker_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const [key, value] of values) save.run(key, JSON.stringify(value));
    });
    const effective = Object.fromEntries(Object.keys(SETTING_DEFINITIONS).map(key => [key, this.get(key)]));
    this.store.limits.default_ttl_seconds = effective.default_message_ttl_seconds;
    // Observability callbacks cannot turn a durable success into a failed save.
    try { this.onChange(effective); } catch { log(this.store.logger, 'warning', 'PSST_SETTINGS_CALLBACK_FAILED'); }
    log(this.store.logger, 'info', 'PSST_SETTINGS_UPDATED');
    return this.snapshot();
  }
}
