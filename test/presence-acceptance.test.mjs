import test from 'node:test';
import assert from 'node:assert/strict';
import { credential, fixture, registration, sendBody, uuid } from './helpers.mjs';

function pair(f) {
  const sender = registration(), recipient = registration();
  f.store.register(f.a.entry, sender); f.store.register(f.b.entry, recipient);
  return { sender, recipient };
}
function send(f, sender, recipient, key = uuid(), extra = {}) {
  return f.store.send(f.a.entry, sender.client_id, 1, key, sendBody(recipient.client_id, 'opaque never included in notices', extra));
}
const code = (fn, expected) => assert.throws(fn, error => error.code === expected);

test('a prolonged offline recipient without pending mail creates no sender notice', t => {
  const f = fixture(t), { sender, recipient } = pair(f);
  f.store.disconnect(f.b.entry, recipient.client_id, 1);
  f.advance(600001);
  assert.equal(f.store.session(f.b.entry, recipient.client_id).presence_state, 'disconnected');
  assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  assert.deepEqual(f.store.presence.page(f.b.entry, recipient.client_id).events, []);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM presence_events').get().n, 0);
});

test('restart before the grace boundary preserves absolute last-heartbeat timing with a nondefault lease', t => {
  const f = fixture(t, { limits: { heartbeat_seconds: 30, lease_seconds: 90 } });
  const { sender, recipient } = pair(f);
  const message = send(f, sender, recipient);
  f.advance(15000);
  f.store.heartbeat(f.b.entry, recipient.client_id, 1);
  const lastHeartbeat = new Date(f.now).toISOString();
  f.advance(90000);
  assert.equal(f.store.session(f.b.entry, recipient.client_id).presence_state, 'disconnected');
  assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  f.advance(210000); f.restart();
  assert.equal(f.store.session(f.b.entry, recipient.client_id).last_heartbeat_at, lastHeartbeat);
  assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  f.advance(299999);
  assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  f.advance(1);
  const threshold = f.store.presence.page(f.a.entry, sender.client_id).events;
  assert.equal(threshold.length, 1);
  assert.equal(threshold[0].last_heartbeat_at, lastHeartbeat);
  assert.deepEqual(threshold[0].messages, [{ message_id: message.message_id, delivery_state: 'queued', delivery_uncertain: false }]);
  f.advance(1);
  const afterThreshold = f.store.presence.page(f.a.entry, sender.client_id).events;
  assert.equal(afterThreshold.length, 1);
  assert.equal(afterThreshold[0].event_id, threshold[0].event_id);
  assert.equal(afterThreshold[0].created_at, threshold[0].created_at);
  assert.equal(afterThreshold[0].observed_at, new Date(f.now).toISOString());
});

test('one offline recipient has independent scoped sender notices and acknowledgements throughout an absence', t => {
  const f = fixture(t), recipient = registration();
  const recipientAuth = { ...f.b.entry, scopes: ['default', 'private'] };
  f.store.register(recipientAuth, recipient);
  const senders = [f.a.entry, f.c.entry].map(auth => {
    const session = registration();
    f.store.register(auth, session);
    const first = f.store.send(auth, session.client_id, 1, uuid(), sendBody(recipient.client_id));
    return { auth, session, first };
  });
  const outsiderAuth = credential('isolated-adapter', ['unrelated']).entry, outsider = registration();
  f.store.register(outsiderAuth, outsider);
  code(() => f.store.send(outsiderAuth, outsider.client_id, 1, uuid(), sendBody(recipient.client_id)), 'recipient_not_found');
  f.advance(600000);
  const events = senders.map(({ auth, session, first }) => {
    const page = f.store.presence.page(auth, session.client_id);
    assert.equal(page.events.length, 1);
    assert.equal(page.next_cursor, null);
    assert.equal(page.events[0].recipient_id, recipient.client_id);
    assert.deepEqual(page.events[0].messages, [{ message_id: first.message_id, delivery_state: 'queued', delivery_uncertain: false }]);
    assert.deepEqual(f.store.presence.page(auth, session.client_id), page);
    return page.events[0];
  });
  assert.notEqual(events[0].event_id, events[1].event_id);
  for (const [i, { auth, session }] of senders.entries()) {
    const other = senders[1 - i], narrowed = { ...auth, scopes: ['unrelated'] };
    code(() => f.store.presence.page(auth, other.session.client_id), 'recipient_not_found');
    code(() => f.store.presence.acknowledge(auth, session.client_id, events[1 - i].event_id), 'message_not_found');
    assert.deepEqual(f.store.presence.page(narrowed, session.client_id).events, []);
    code(() => f.store.presence.acknowledge(narrowed, session.client_id, events[i].event_id), 'message_not_found');
    code(() => f.store.presence.acknowledge(outsiderAuth, outsider.client_id, events[i].event_id), 'message_not_found');
  }
  assert.deepEqual(f.store.presence.page(outsiderAuth, outsider.client_id).events, []);
  assert.deepEqual(f.store.presence.page(recipientAuth, recipient.client_id).events, []);

  const [first, second] = senders;
  assert.equal(f.store.presence.acknowledge(first.auth, first.session.client_id, events[0].event_id).acknowledged, true);
  assert.deepEqual(f.store.presence.page(first.auth, first.session.client_id).events, []);
  assert.equal(f.store.presence.page(second.auth, second.session.client_id).events[0].event_id, events[1].event_id);
  for (const sender of senders) {
    f.store.register(sender.auth, { ...sender.session, previous_epoch: 1, connection_id: uuid() });
    sender.later = f.store.send(sender.auth, sender.session.client_id, 2, uuid(), sendBody(recipient.client_id));
    assert.equal(sender.later.recipient_connected_at_acceptance, false);
  }
  assert.deepEqual(f.store.presence.page(first.auth, first.session.client_id).events, []);
  const stillPending = f.store.presence.page(second.auth, second.session.client_id).events;
  assert.equal(stillPending.length, 1);
  assert.equal(stillPending[0].event_id, events[1].event_id);
  assert.deepEqual(stillPending[0].messages.map(message => message.message_id), [second.first.message_id, second.later.message_id]);
  assert.equal(f.store.presence.acknowledge(second.auth, second.session.client_id, events[1].event_id).acknowledged, true);
  for (const [i, { auth, session, first: original, later }] of senders.entries()) {
    assert.deepEqual(f.store.presence.page(auth, session.client_id).events, []);
    assert.equal(f.store.presence.acknowledge(auth, session.client_id, events[i].event_id).acknowledged, true);
    for (const message of [original, later]) assert.equal(f.store.receipt(auth, session.client_id, message.message_id).delivery_state, 'queued');
  }
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM presence_events').get().n, 2);
});

test('existing notices disappear when their last pending message is cancelled or expires, including uncertain delivery', async t => {
  for (const terminal of ['cancelled', 'expired']) for (const claimed of [false, true]) {
    await t.test(`${terminal}, ${claimed ? 'previously claimed' : 'never claimed'}`, t => {
      const f = fixture(t), { sender, recipient } = pair(f);
      const message = send(f, sender, recipient, uuid(), { ttl_seconds: 601 });
      if (claimed) {
        const claim = f.store.claim(f.b.entry, recipient.client_id, 1, uuid(), {});
        assert.equal(claim.envelope.message_id, message.message_id);
        assert.equal(f.store.receipt(f.a.entry, sender.client_id, message.message_id).delivery_state, 'claimed');
      }
      f.advance(600000);
      const before = f.store.presence.page(f.a.entry, sender.client_id).events;
      assert.equal(before.length, 1);
      assert.deepEqual(before[0].messages, [{ message_id: message.message_id, delivery_state: 'queued', delivery_uncertain: claimed }]);
      if (terminal === 'cancelled') {
        f.store.register(f.a.entry, { ...sender, previous_epoch: 1, connection_id: uuid() });
        const cancelled = f.store.cancel(f.a.entry, sender.client_id, 2, message.message_id);
        assert.equal(cancelled.cancel_result, 'cancelled');
        assert.equal(cancelled.delivery_may_have_occurred, claimed);
      } else {
        f.advance(999);
        assert.equal(f.store.presence.page(f.a.entry, sender.client_id).events[0].event_id, before[0].event_id);
        f.advance(1);
      }
      assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
      const receipt = f.store.receipt(f.a.entry, sender.client_id, message.message_id);
      assert.equal(receipt.delivery_state, terminal);
      assert.equal(receipt.reason, terminal === 'cancelled' ? 'sender_cancelled' : 'ttl_expired');
      assert.equal(receipt.delivery_uncertain, claimed);
      assert.equal(receipt.delivered_at, null);
      f.restart();
      assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
      // Suppression is not an implicit ACK: a caller can still reconcile the
      // observed event after its final pending message becomes terminal.
      assert.equal(f.store.presence.acknowledge(f.a.entry, sender.client_id, before[0].event_id).acknowledged, true);
      assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
    });
  }
});

test('64 KiB notice byte limit truncates genuine metadata and continuation returns every event exactly once', t => {
  const f = fixture(t), sender = registration(), expected = new Map();
  f.store.register(f.a.entry, sender);
  for (let i = 0; i < 60; i++) {
    // Refill the default sender rate budget with the fake clock; retain all
    // production limits and create every session/message through public methods.
    f.store.heartbeat(f.a.entry, sender.client_id, 1);
    const recipient = registration();
    f.store.register(f.b.entry, recipient);
    const messages = Array.from({ length: 10 }, () => send(f, sender, recipient).message_id);
    expected.set(recipient.client_id, messages);
    f.advance(10000);
  }
  f.advance(600000);
  const first = f.store.presence.page(f.a.entry, sender.client_id, { limit: 100 });
  assert.ok(first.events.length > 0 && first.events.length < expected.size);
  assert.ok(first.next_cursor, 'byte truncation must supply a continuation before the requested 100-event limit');
  assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id, { limit: 100 }), first);
  const second = f.store.presence.page(f.a.entry, sender.client_id, { limit: 100, cursor: first.next_cursor });
  assert.equal(second.next_cursor, null);
  assert.ok(second.events.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...first, events: [...first.events, second.events[0]] })) > 65536,
    'adding the next genuine event would exceed the wire byte limit');
  const events = [...first.events, ...second.events];
  assert.ok(Buffer.byteLength(JSON.stringify({ ...first, events })) > 65536, 'all genuine metadata must exceed one page');
  for (const page of [first, second]) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65536);
    assert.equal(page.capacity_limited, false);
  }
  assert.equal(events.length, expected.size);
  assert.equal(new Set(events.map(event => event.event_id)).size, expected.size);
  assert.deepEqual(new Set(events.map(event => event.recipient_id)), new Set(expected.keys()));
  for (const event of events) {
    assert.deepEqual(event.messages, expected.get(event.recipient_id).map(message_id => ({ message_id, delivery_state: 'queued', delivery_uncertain: false })));
    assert.equal(event.has_more_messages, false);
  }
  assert.ok(!JSON.stringify(events).includes('opaque'));
  t.diagnostic(`60 notices / 600 messages: ${first.events.length} + ${second.events.length} events, ${Buffer.byteLength(JSON.stringify(first))} + ${Buffer.byteLength(JSON.stringify(second))} page bytes`);
});
