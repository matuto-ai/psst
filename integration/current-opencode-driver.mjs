// Test-only OpenCode 2.2.5 host boundary. The installed connector owns every
// broker request, journal, tool validation and automatic admission decision.
// Synthetic receipts prove this fixture's durable host acceptance, not that a
// real OpenCode process or model received/read the message.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

// admitNative:false models a host interruption before admission. setAdmission
// reopens it through the supported host-started-work event, including reloads.
// A repeated explicit operationId preserves the original native call/time;
// omitted IDs represent distinct host tool calls even with identical arguments.
export async function createDriver(options) {
  const { packageRoot, installation, runtime, nativeId, brokerUrl, approved } = options;
  const load = path => import(pathToFileURL(join(packageRoot, path)).href);
  const [installationAPI, { privateDirectory }, { setupNativePlugin }, { loadBrokerReference },
    { tool }, presenceAPI, { readNativeBindings }, { canonical }] = await Promise.all([
    load('src/installation.mjs'), load('src/config.mjs'), load('src/native-plugin.mjs'),
    load('src/reference.mjs'), load('src/tool-schema.mjs'), load('src/active-presence.mjs'),
    load('src/identity-recovery.mjs'), load('vendor/broker/src/protocol.mjs'),
  ]);
  if (typeof nativeId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(nativeId)) throw Error('invalid_matrix_native_id');
  privateDirectory(runtime);
  privateDirectory(installation);
  if (approved) {
    const previous = installationAPI.readSelection(installation);
    if (previous && previous.connectionFile !== approved.connectionFile) throw Error('matrix_installation_conflict');
    if (!previous) await installationAPI.selectInstallation({ directory: installation,
      connectionFile: approved.connectionFile, expectedRevision: null });
  }
  const settings = await installationAPI.readInstallation(installation);
  if (!settings || new URL(settings.broker.url).href !== new URL(brokerUrl).href) throw Error('matrix_broker_mismatch');

  // This database belongs only to the fake host. Persisting host storage,
  // assistant call IDs/timestamps and synthetic context permits exact restart.
  const path = join(runtime, 'synthetic-opencode-host.sqlite');
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const db = new DatabaseSync(path);
  const storagePath = join(installation, 'synthetic-opencode-storage.sqlite');
  try { closeSync(openSync(storagePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') { db.close(); throw error; } }
  let hostStorage;
  let plugin, presence, heartbeat, closed = false;
  const tools = new Map(), hooks = new Map(), pendingEvents = [];
  let wakeEvent;
  const get = key => {
    const row = db.prepare('SELECT value FROM host_storage WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  };
  const put = (key, value) => db.prepare('INSERT INTO host_storage(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const hostGet = key => {
    const row = hostStorage.prepare('SELECT value FROM host_storage WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  };
  const hostPut = (key, value) => hostStorage.prepare('INSERT INTO host_storage(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const clone = value => structuredClone(value);
  async function emit(event) {
    if (closed) throw Error('matrix_driver_closed');
    return new Promise(resolve => { pendingEvents.push({ event, resolve }); wakeEvent?.(); });
  }
  try {
    // OpenCode plugin storage is shared by native sessions in one installation.
    // Do not fabricate a new anchor for each session: the connector itself
    // creates/recovers it through this persistent host API.
    hostStorage = new DatabaseSync(storagePath);
    hostStorage.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS host_storage(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS host_storage(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_operations(operation_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,call_id TEXT NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL,input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_synthetic(id TEXT PRIMARY KEY,request TEXT NOT NULL,receipt TEXT NOT NULL,context TEXT NOT NULL);`);
    let info = get('fixture-native-session');
    if (!info) {
      info = { id: nativeId, projectID: 'matrix-project', location: { directory: runtime }, time: { created: Date.now() } };
      put('fixture-native-session', info);
    }
    if (info.id !== nativeId || info.location.directory !== runtime) throw Error('matrix_host_identity_conflict');
    if (options.admitNative !== undefined) {
      if (typeof options.admitNative !== 'boolean') throw Error('invalid_matrix_admission');
      if (options.admitNative) delete info.outcome;
      else { info.outcome = 'interrupted'; info.time.idle = Math.max(Date.now(), info.time.busy ?? 0); }
      put('fixture-native-session', info);
    }
    const assertSession = input => {
      if (input?.sessionID !== nativeId) throw Object.assign(Error('matrix_session_not_found'), { _tag: 'SessionNotFoundError', sessionID: input?.sessionID });
    };
    const ctx = {
      app: { version: '2.2.5' }, location: clone(info.location),
      storage: {
        get: async key => hostGet(key), set: async (key, value) => { hostPut(key, value); },
        scan: async ({ prefix, limit = 64, after }) => {
          const rows = hostStorage.prepare('SELECT key,value FROM host_storage ORDER BY key').all()
            .filter(row => row.key.startsWith(prefix) && (!after || row.key > after));
          return { entries: rows.slice(0, limit).map(row => ({ key: row.key, value: JSON.parse(row.value) })),
            ...(rows.length > limit ? { next: rows[limit - 1].key } : {}) };
        },
      },
      session: {
        get: async input => { assertSession(input); return clone(info); },
        hook: async (name, fn) => { hooks.set(name, fn); return { dispose: async () => { hooks.delete(name); } }; },
        context: async input => {
          assertSession(input);
          const operations = db.prepare('SELECT * FROM host_operations ORDER BY rowid').all().map(row => ({
            id: row.message_id, type: 'assistant', content: [{ type: 'tool', id: row.call_id,
              name: row.name, input: JSON.parse(row.input), time: { created: row.created } }],
          }));
          return [...operations, ...db.prepare('SELECT context FROM host_synthetic ORDER BY rowid').all().map(row => JSON.parse(row.context))];
        },
        synthetic: async (input, { signal } = {}) => {
          assertSession(input);
          if (signal?.aborted) throw Error('matrix_host_request_aborted');
          if (input.delivery !== 'queue' || input.resume !== true) throw Error('matrix_native_contract_mismatch');
          const existing = db.prepare('SELECT request,receipt FROM host_synthetic WHERE id=?').get(input.id);
          if (existing) {
            if (existing.request !== canonical(input)) throw Error('matrix_native_id_conflict');
            return JSON.parse(existing.receipt);
          }
          const payload = { text: input.text, description: input.description, metadata: input.metadata };
          const receipt = { id: input.id, sessionID: nativeId, type: 'synthetic', delivery: 'queue', payload };
          const context = { id: input.id, type: 'synthetic', ...payload };
          db.prepare('INSERT INTO host_synthetic(id,request,receipt,context) VALUES(?,?,?,?)')
            .run(input.id, canonical(input), JSON.stringify(receipt), JSON.stringify(context));
          return clone(receipt);
        },
      },
      tool: { transform: async callback => {
        callback({ get: name => tools.get(name), add: definition => tools.set(definition.name, definition) });
        return { dispose: async () => tools.clear() };
      } },
      event: { async *subscribe({ signal }) {
        const wake = () => wakeEvent?.();
        signal.addEventListener('abort', wake, { once: true });
        try {
          while (!signal.aborted) {
            if (!pendingEvents.length) await new Promise(resolve => { wakeEvent = resolve; });
            wakeEvent = undefined;
            if (signal.aborted) break;
            while (pendingEvents.length) {
              const item = pendingEvents.shift();
              try { yield item.event; } finally { item.resolve(); }
            }
          }
        } finally {
          signal.removeEventListener('abort', wake);
          for (const item of pendingEvents.splice(0)) item.resolve();
        }
      } },
    };
    // Use the real selected-session lease writer/reader. This supplies no
    // authority or identity and does not bypass production selection checks.
    presence = presenceAPI.createPresenceWriter({ directory: presenceAPI.presenceDirectory(installation, ctx.location, { create: true }) });
    presence.write(nativeId);
    heartbeat = setInterval(() => presence.write(nativeId), 1000);
    heartbeat.unref?.();
    plugin = await setupNativePlugin({ ctx, reference: await loadBrokerReference(), tool,
      setupOptions: { directory: installation }, setupEnabled: false,
      loadSettings: () => installationAPI.readInstallation(installation) });
    await plugin.connect(nativeId);
    if (options.admitNative !== undefined) await emit({
      type: options.admitNative ? 'session.execution.started' : 'session.execution.interrupted',
      data: { sessionID: nativeId },
    });

    function brokerInbox(messageId) {
      const records = readNativeBindings(settings).filter(record => record.binding.sessionID === nativeId
        && record.binding.hostID === hostGet('psst-v2-host-id') && record.binding.location.directory === runtime);
      if (records.length !== 1) throw Error('matrix_inbox_binding_unavailable');
      const record = records[0];
      const key = createHash('sha256').update(canonical({ binding: record.binding, broker: record.broker })).digest('hex');
      let directory = join(settings.stateDirectory, 'opencode-v2-' + key);
      const pointerPath = join(directory, 'current-incarnation.json');
      if (existsSync(pointerPath)) {
        const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
        if (!/^[0-9a-f-]{36}$/.test(pointer.generation)) throw Error('matrix_incarnation_invalid');
        directory = join(directory, 'incarnation-' + pointer.generation);
      }
      const inbox = new DatabaseSync(join(directory, 'inbox.sqlite'), { readOnly: true });
      try {
        const row = inbox.prepare('SELECT message_id,sequence,state,envelope,received_at,native_receipt,consumed_at FROM inbox WHERE message_id=?').get(messageId);
        return row ? { ...row, envelope: JSON.parse(row.envelope) } : null;
      } finally { inbox.close(); }
    }
    return {
      async call(name, args = {}, operationId = randomUUID()) {
        if (closed) throw Error('matrix_driver_closed');
        // Common matrix inspection query, not a tool added to OpenCode. Read
        // the connected identity from the real plugin rather than discovering
        // it by subtracting unrelated broker sessions.
        if (name === 'broker_identity') return { client_id: plugin.status(nativeId).client_id, client_type: 'opencode' };
        const definition = tools.get(name);
        if (!definition) throw Error('matrix_native_tool_unavailable:' + name);
        if (typeof operationId !== 'string' || !operationId.length || operationId.length > 1024) throw Error('invalid_matrix_operation_id');
        let operation = db.prepare('SELECT * FROM host_operations WHERE operation_id=?').get(operationId);
        if (!operation) {
          const key = createHash('sha256').update(operationId).digest('hex');
          db.prepare('INSERT INTO host_operations(operation_id,message_id,call_id,name,created,input) VALUES(?,?,?,?,?,?)')
            .run(operationId, 'msg_matrix_' + key, 'call_matrix_' + key, name, Date.now(), JSON.stringify(args));
          operation = db.prepare('SELECT * FROM host_operations WHERE operation_id=?').get(operationId);
        }
        if (operation.name !== name) throw Error('matrix_operation_tool_conflict');
        const result = await definition.execute(args, { sessionID: nativeId,
          messageID: operation.message_id, id: operation.call_id, signal: new AbortController().signal });
        return JSON.parse(result.content);
      },
      observe(messageId) {
        if (closed) throw Error('matrix_driver_closed');
        const inbox = brokerInbox(messageId);
        if (!inbox) return null;
        const captured = db.prepare('SELECT receipt,context FROM host_synthetic ORDER BY rowid').all()
          .map(row => ({ receipt: JSON.parse(row.receipt), message: JSON.parse(row.context) }))
          .filter(row => row.message.metadata?.broker_message_id === messageId);
        return {
          message_id: messageId, broker_inbox_received: inbox !== null, broker_inbox: inbox,
          envelope: inbox?.envelope ?? null, local_state: inbox?.state ?? null,
          message: captured[0]?.message.text ?? null,
          synthetic_host_accepted: captured.length > 0,
          native_acceptance_recorded: !!inbox?.native_receipt,
          native_messages: captured.map(row => row.message), native_receipts: captured.map(row => row.receipt),
          native: { kind: 'opencode_synthetic_host', observed: captured.length > 0, capture_count: captured.length,
            body: captured[0]?.message.text ?? null, native_acceptance_recorded: !!inbox?.native_receipt,
            model_read_recorded: false },
          receipt_semantics: 'synthetic_host_durable_admission_not_model_read', model_consumption_proven: false,
        };
      },
      async setAdmission(enabled) {
        if (closed) throw Error('matrix_driver_closed');
        if (typeof enabled !== 'boolean') throw Error('invalid_matrix_admission');
        if (enabled) { delete info.outcome; info.time.busy = Date.now(); }
        else { info.outcome = 'interrupted'; info.time.idle = Math.max(Date.now(), info.time.busy ?? 0); }
        put('fixture-native-session', info);
        // Exercise the supported host pause/resume contract. This does not
        // reject an already invoked mutation or reset any connector journal.
        await emit({ type: enabled ? 'session.execution.started' : 'session.execution.interrupted', data: { sessionID: nativeId } });
      },
      async close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try { await plugin.dispose(); }
        finally { try { presence.stop(); } finally { try { db.close(); } finally { hostStorage.close(); } } }
      },
    };
  } catch (error) {
    closed = true;
    clearInterval(heartbeat);
    try { await plugin?.dispose(); }
    finally { try { presence?.stop(); } finally { try { db.close(); } finally { hostStorage?.close(); } } }
    throw error;
  }
}
