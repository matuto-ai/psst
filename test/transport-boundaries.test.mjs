import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, registration, sendBody } from './helpers.mjs';

function pair(f) {
  const sender = registration(), recipient = registration();
  f.store.register(f.a.entry, sender);
  f.store.register(f.b.entry, recipient);
  return { sender, recipient };
}
const rows = (f, table) => f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const rejected = (fn, status, code) => assert.throws(fn, e => e.status === status && e.code === code && e.effect === 'not_applied');

for (const level of ['sender', 'principal', 'global']) {
  test(`${level} send bucket: exact 429/refill boundary, transactional rollback and replay`, t => {
    const limits = { send_burst: 100, principal_send_burst: 100, global_send_burst: 100,
      send_per_minute: 60, principal_send_per_minute: 60, global_send_per_minute: 60 };
    limits[level === 'sender' ? 'send_burst' : `${level}_send_burst`] = 1;
    const f = fixture(t, { limits }), { sender, recipient } = pair(f);
    const first = f.store.send(f.a.entry, sender.client_id, 1, 'accepted', sendBody(recipient.client_id));
    let auth = f.a.entry, candidate = sender;
    if (level !== 'sender') {
      // Principal spans native sessions; global additionally spans principals.
      auth = level === 'global' ? { ...f.a.entry, principal_id: 'second-owner' } : f.a.entry;
      candidate = registration(); f.store.register(auth, candidate);
    }
    const before = rows(f, 'rates');
    const body = sendBody(recipient.client_id, 'bounded fixture', { metadata_patch: { name: 'after-refill' }, expected_metadata_revision: 1 });
    const attempt = () => f.store.send(auth, candidate.client_id, 1, 'retry-key', body);
    const limited = () => assert.throws(attempt, e => e.status === 429 && e.code === 'rate_limited' && e.retryable === true && e.effect === 'not_applied' && e.retry_after === 1);
    limited();
    assert.deepEqual(rows(f, 'rates'), before, 'later bucket rejection rolls back earlier debits/new rows');
    assert.equal(rows(f, 'messages').length, 1); assert.equal(rows(f, 'sends').length, 1);
    assert.equal(f.store.session(auth, candidate.client_id).metadata_revision, 1);
    assert.equal(f.store.db.prepare('SELECT next_sequence FROM sessions WHERE id=?').get(recipient.client_id).next_sequence, 1);
    f.advance(999); limited(); assert.deepEqual(rows(f, 'rates'), before);
    f.advance(1); const second = attempt();
    assert.equal(second.recipient_sequence, first.recipient_sequence + 1);
    assert.equal(f.store.session(auth, candidate.client_id).metadata_revision, 2);
    const charged = rows(f, 'rates');
    assert.deepEqual(attempt(), second, 'stored replay succeeds while bucket is empty');
    assert.deepEqual(rows(f, 'rates'), charged, 'stored replay does not charge any rate bucket');
    assert.equal(rows(f, 'messages').length, 2); assert.equal(rows(f, 'sends').length, 2);
  });
}

test('send pre-commit fault rolls back all three rate debits with metadata and sequence', t => {
  let armed = false;
  const f = fixture(t, { limits: { send_burst: 1, principal_send_burst: 1, global_send_burst: 1 },
    fault: stage => { if (armed && stage === 'before_commit') { armed = false; throw Error('synthetic commit fault'); } } });
  const { sender, recipient } = pair(f);
  const body = sendBody(recipient.client_id, 'fixture', { metadata_patch: { name: 'atomic' }, expected_metadata_revision: 1 });
  armed = true;
  rejected(() => f.store.send(f.a.entry, sender.client_id, 1, 'same-key', body), 503, 'storage_unavailable');
  for (const table of ['rates', 'messages', 'sends']) assert.equal(rows(f, table).length, 0);
  assert.equal(f.store.session(f.a.entry, sender.client_id).metadata_revision, 1);
  assert.equal(f.store.db.prepare('SELECT next_sequence FROM sessions WHERE id=?').get(recipient.client_id).next_sequence, 0);
  const result = f.store.send(f.a.entry, sender.client_id, 1, 'same-key', body);
  assert.equal(result.recipient_sequence, 1); assert.equal(rows(f, 'rates').length, 3);
  assert(rows(f, 'rates').every(row => row.tokens === 0));
});

for (const elapsed of [59999, 60000, 60001]) {
  test(`ACK at TTL offset ${elapsed - 60000}ms has exact terminal/replay semantics`, t => {
    const f = fixture(t), { sender, recipient } = pair(f);
    const sent = f.store.send(f.a.entry, sender.client_id, 1, 'send', sendBody(recipient.client_id, 'fixture', { ttl_seconds: 60 }));
    const claim = f.store.claim(f.b.entry, recipient.client_id, 1, 'claim', {});
    const completion = { claim_id: claim.claim_id, outcome: 'delivered' };
    f.advance(elapsed);
    if (elapsed < 60000) {
      const result = f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id, completion);
      assert.equal(result.delivery_state, 'delivered'); assert.equal(result.delivery_uncertain, false);
      f.advance(2);
      assert.deepEqual(f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id, completion), result, 'committed ACK replay remains the original result after TTL');
      assert.equal(rows(f, 'completions').length, 1);
    } else {
      rejected(() => f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id, completion), 410, 'message_expired');
      assert.equal(rows(f, 'completions').length, 0);
      const receipt = f.store.receipt(f.a.entry, sender.client_id, sent.message_id);
      assert.equal(receipt.delivery_state, 'expired'); assert.equal(receipt.delivery_uncertain, true); assert.equal(receipt.delivered_at, null);
    }
  });
}

for (const elapsed of [119999, 120000, 120001]) {
  test(`ACK at claim deadline offset ${elapsed - 120000}ms while TTL remains valid`, t => {
    const f = fixture(t), { sender, recipient } = pair(f);
    const sent = f.store.send(f.a.entry, sender.client_id, 1, 'send', sendBody(recipient.client_id, 'fixture', { ttl_seconds: 300 }));
    const claim = f.store.claim(f.b.entry, recipient.client_id, 1, 'claim', {});
    const completion = { claim_id: claim.claim_id, outcome: 'delivered' };
    f.advance(elapsed);
    if (elapsed < 120000) assert.equal(f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id, completion).delivery_state, 'delivered');
    else {
      rejected(() => f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id, completion), 409, 'claim_conflict');
      assert.equal(rows(f, 'completions').length, 0);
      const retry = f.store.claim(f.b.entry, recipient.client_id, 1, 'retry-claim', {});
      assert.notEqual(retry.claim_id, claim.claim_id); assert.equal(retry.attempt, 2);
      rejected(() => f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id, completion), 409, 'claim_conflict');
      assert.equal(f.store.receipt(f.a.entry, sender.client_id, sent.message_id).delivery_uncertain, true);
    }
  });
}

for (const mode of ['negative-ack', 'unconfirmed-claim']) {
  test(`attempt exhaustion after ${mode} preserves truthful uncertainty and no extra admission`, t => {
    const f = fixture(t, { limits: { max_attempts: 2, claim_seconds: 1 } }), { sender, recipient } = pair(f);
    const sent = f.store.send(f.a.entry, sender.client_id, 1, 'send', sendBody(recipient.client_id));
    for (let attempt = 1; attempt <= 2; attempt++) {
      const claim = f.store.claim(f.b.entry, recipient.client_id, 1, `claim-${attempt}`, {});
      assert.equal(claim.attempt, attempt);
      if (mode === 'negative-ack') {
        const result = f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id,
          { claim_id: claim.claim_id, outcome: 'retryable_not_stored', reason: 'inbox_full' });
        assert.equal(result.delivery_state, attempt === 2 ? 'failed' : 'queued');
      } else f.advance(1000);
    }
    assert.equal(f.store.claim(f.b.entry, recipient.client_id, 1, 'never-third', {}), null);
    const receipt = f.store.receipt(f.a.entry, sender.client_id, sent.message_id);
    assert.equal(receipt.delivery_state, 'failed'); assert.equal(receipt.reason, 'attempts_exhausted');
    assert.equal(receipt.attempt_count, 2); assert.equal(receipt.delivery_uncertain, mode === 'unconfirmed-claim');
    assert.equal(receipt.delivered_at, null);
  });
}

for (const stage of ['before_commit', 'commit_attempt', 'after_commit']) {
  test(`ACK ${stage} fault preserves atomic outcome and exact completion replay`, t => {
    let armed = false;
    const f = fixture(t, { fault: where => { if (armed && where === stage) { armed = false; throw Error('synthetic ACK fault'); } } });
    const { sender, recipient } = pair(f);
    const sent = f.store.send(f.a.entry, sender.client_id, 1, 'send', sendBody(recipient.client_id));
    const claim = f.store.claim(f.b.entry, recipient.client_id, 1, 'claim', {});
    const completion = { claim_id: claim.claim_id, outcome: 'delivered' }, before = rows(f, 'messages');
    armed = true;
    assert.throws(() => f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id, completion),
      e => e.status === 503 && e.code === 'storage_unavailable' && e.effect === (stage === 'after_commit' ? 'unknown' : 'not_applied'));
    if (stage === 'after_commit') {
      assert.equal(rows(f, 'completions').length, 1); assert.equal(rows(f, 'messages')[0].state, 'delivered');
    } else {
      assert.equal(rows(f, 'completions').length, 0); assert.deepEqual(rows(f, 'messages'), before);
    }
    const result = f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id, completion);
    assert.equal(result.delivery_state, 'delivered'); assert.equal(result.delivery_uncertain, false);
    assert.deepEqual(f.store.complete(f.b.entry, recipient.client_id, 1, sent.message_id, completion), result);
    assert.equal(rows(f, 'completions').length, 1); assert.equal(rows(f, 'messages')[0].attempts, 1);
  });
}
