// Synthetic native host only. The packed connector owns binding, transport,
// durable inbox, waiter notices and explicit read/ACK semantics.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';

export async function createDriver(options) {
  const { packageRoot, installation, runtime, nativeId, brokerUrl, approved } = options;
  const load = path => import(pathToFileURL(join(packageRoot, path)));
  const { openInstallation } = await load('src/installation.mjs');
  if (approved) {
    const store = openInstallation(installation);
    if (!store.selected()) {
      store.beginPending({ brokerUrl, requestId: approved.requestId, previousRevision: null });
      store.commit({ ...approved, previousRevision: null });
    }
  }
  const { serveNativePlugin, readPrivateJson } = await load('src/native-plugin.mjs');
  const { processIdentity } = await load('src/native-binding.mjs');
  const { waitNativeProcess } = await load('src/native-process-waiter.mjs');
  const { PENDING_NOTICE } = await load('src/native-waiter.mjs');
  const host = processIdentity(process.pid), context = { host, conversationId: nativeId };
  const nativeMeta = { 'antigravity.google/conversation_id': nativeId,
    'antigravity.google/root_conversation_id': nativeId };
  const server = await serveNativePlugin({ base: runtime, installationRoot: installation,
    host, input: new PassThrough(), output: new PassThrough() });
  const call = (name, args = {}) => {
    if (typeof server.tools[name] !== 'function') throw Error('matrix_unknown_native_tool');
    return server.tools[name](server.binding.issue({ context, tool: name, args }), { nativeMeta });
  };
  await call('broker_setup_status');
  const identity = await call('broker_identity');
  assert.equal(identity.mode, 'automatic_required');
  const captures = new Map();
  let enabled = options.admitNative !== false, closed = false, controller, waiting,
    pendingRead = null, waiterFailure;
  function arm() {
    if (!enabled || closed || waiting || pendingRead) return;
    controller = new AbortController();
    const permit = server.binding.issue({ context, tool: 'broker_wait', args: {} }).__psst_permit;
    waiting = (async () => {
      const notice = await waitNativeProcess({ directory: server.directory, permit, signal: controller.signal });
      if (!enabled || closed || controller.signal.aborted) return;
      assert.equal(notice, PENDING_NOTICE, 'the actual waiter must produce the body-free agent notice');
      // Explicitly simulated model action AFTER the actual automatic waiter notice.
      // This is a production tool path, not diagnostic manual-mode enablement.
      const received = await call('broker_receive');
      assert.ok(received.message_id);
      assert.equal(received.native_acceptance_recorded, false);
      pendingRead = received.message_id;
      captures.set(received.message_id, { kind: 'synthetic_model_after_native_waiter', observed: true,
        capture_count: (captures.get(received.message_id)?.capture_count ?? 0) + 1,
        notice, body: received.message, native_acceptance_recorded: false, model_read_recorded: false });
    })().catch(error => { if (!closed && enabled && !controller.signal.aborted) waiterFailure = error; })
      .finally(() => { waiting = null; });
  }
  arm();
  return {
    call,
    observe(messageId) {
      if (waiterFailure) throw waiterFailure;
      const state = readPrivateJson(join(server.directory, 'session.json'));
      const db = new DatabaseSync(state.inboxPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT envelope,state,native_receipt FROM inbox WHERE message_id=?').get(messageId);
        if (!row) return null;
        return { message_id: messageId, envelope: JSON.parse(row.envelope), local_state: row.state,
          native: { ...(captures.get(messageId) ?? { kind: 'native_waiter_not_observed', observed: false, capture_count: 0,
            model_read_recorded: false }), native_acceptance_recorded: typeof row.native_receipt === 'string' } };
      } finally { db.close(); }
    },
    async acknowledge(messageId) {
      assert.ok(captures.has(messageId), 'only acknowledge an exact simulated native read');
      const result = await call('broker_acknowledge', { message_id: messageId });
      assert.equal(result.acknowledged, true);
      assert.equal(result.native_acceptance_recorded, false);
      if (pendingRead === messageId) pendingRead = null;
      await waiting;
      arm();
      return result;
    },
    async setAdmission(value) {
      enabled = value === true;
      if (!enabled) { controller?.abort(); await waiting; }
      else arm();
    },
    async close() {
      closed = true; controller?.abort();
      await waiting;
      await server.close();
    },
  };
}
