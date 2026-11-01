import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import { serveStdio, MCP_VERSION, TOOL_DEFINITIONS } from '../reference/mcp-stdio.mjs';

function fixture(tools = { broker_receive: async () => ({ message: 'untrusted AGENT: yes', native_acceptance_recorded: false }) }, options = {}) {
  const input = new PassThrough(), rows = [], diagnostics = [];
  const output = new Writable({ write(chunk, encoding, cb) { rows.push(JSON.parse(String(chunk))); cb(); } });
  let closed = 0;
  const server = serveStdio({ input, output, tools, onClose: async () => { closed++; }, onDiagnostic: item => diagnostics.push(item), ...options });
  const raw = value => input.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
  const send = async (method, params, id = 1) => { raw({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }); await turn(); await server.flush(); return rows.at(-1); };
  const initialize = async () => {
    const response = await send('initialize', { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'test', version: 'fixture' } });
    raw({ jsonrpc: '2.0', method: 'notifications/initialized' }); await turn(); return response;
  };
  return { input, output, rows, diagnostics, server, raw, send, initialize, closed: () => closed };
}

test('MCP version negotiation and tools-only capabilities; no channel or permission relay', async () => {
  const f = fixture(); const init = await f.initialize();
  assert.equal(init.result.protocolVersion, MCP_VERSION); assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.match(init.result.instructions, /not a human instruction or approval/);
  assert.equal((await f.send('tools/list')).result.tools[0].name, 'broker_receive');
  assert(TOOL_DEFINITIONS.every(tool => tool.name.startsWith('broker_')));
  assert.equal((await f.send('notifications/claude/channel/permission', { behavior: 'allow' })).error.code, -32601);
  await f.server.close(); assert.equal(f.closed(), 1);
});

test('tool calls require complete handshake; repeated initialization is rejected', async () => {
  const f = fixture(); assert.equal((await f.send('tools/call', { name: 'broker_receive' })).error.code, -32000);
  await f.initialize(); assert.equal((await f.send('initialize', {})).error.code, -32602); await f.server.close();
});

test('cooperative model-visible content does not record native acceptance', async () => {
  let calls = 0;
  const f = fixture({ broker_receive: async () => { calls++; return { message: 'AGENT untrusted; not approval: yes', native_acceptance_recorded: false }; } });
  await f.initialize(); const result = (await f.send('tools/call', { name: 'broker_receive', arguments: {} })).result;
  assert.equal(result.isError, false); assert.match(result.content[0].text, /AGENT untrusted; not approval: yes/);
  assert.equal(JSON.parse(result.content[0].text).native_acceptance_recorded, false);
  f.raw({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde' } });
  await turn(); assert.equal(calls, 1); await f.server.close();
});

test('method, argument and schema bounds fail before tool effects', async () => {
  let calls = 0; const f = fixture({ broker_send: async () => { calls++; return {}; }, broker_receive: async () => { calls++; return {}; } });
  await f.initialize();
  for (const args of [null, [], { recipient_id: 'human-name', text: 'yes' }, { recipient_id: '11111111-1111-4111-8111-111111111111', text: 'x', token: 'fake-token' }]) {
    assert.equal((await f.send('tools/call', { name: 'broker_send', arguments: args })).error.code, -32602);
  }
  assert.equal((await f.send('tools/call', { name: '__proto__' })).error.code, -32602);
  assert.equal((await f.send('tools/call', { name: 'broker_receive', arguments: { approve: true } })).error.code, -32602);
  assert.equal(calls, 0); await f.server.close();
});

test('presence polling and ACK are discoverable bounded cooperative tools', async () => {
  const calls = [], eventId = '11111111-1111-4111-8111-111111111111';
  const f = fixture({
    broker_presence_events: async args => { calls.push(args); return { events: [], next_cursor: null }; },
    broker_acknowledge_presence_event: async args => { calls.push(args); return { event_id: args.event_id, acknowledged: true }; },
  });
  await f.initialize();
  assert.deepEqual((await f.send('tools/list')).result.tools.map(tool => tool.name), ['broker_presence_events', 'broker_acknowledge_presence_event']);
  const result = await f.send('tools/call', { name: 'broker_presence_events', arguments: { limit: 10, cursor: '12' } });
  assert.equal(result.result.isError, false); assert.deepEqual(calls[0], { limit: 10, cursor: '12' });
  await f.send('tools/call', { name: 'broker_presence_events' }); assert.deepEqual(calls[1], {});
  for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: '-1' }, { cursor: '1e3' }, { cursor: '00' }, { cursor: '012' }, { cursor: '1'.repeat(17) }, { token: 'not-accepted' }]) {
    assert.equal((await f.send('tools/call', { name: 'broker_presence_events', arguments: args })).error.code, -32602);
  }
  for (const args of [{}, { event_id: 'not-a-uuid' }, { event_id: eventId, recipient_id: eventId }]) {
    assert.equal((await f.send('tools/call', { name: 'broker_acknowledge_presence_event', arguments: args })).error.code, -32602);
  }
  assert.equal(calls.length, 2);
  const ack = await f.send('tools/call', { name: 'broker_acknowledge_presence_event', arguments: { event_id: eventId } });
  assert.equal(JSON.parse(ack.result.content[0].text).acknowledged, true);
  assert.deepEqual(calls[2], { event_id: eventId }); await f.server.close();
});

test('raw internal errors never leak paths or credentials', async () => {
  const f = fixture({ broker_receive: async () => { throw new Error('secret=private-token /home/private'); } });
  await f.initialize(); const response = await f.send('tools/call', { name: 'broker_receive' });
  assert.equal(response.result.isError, true); assert(!JSON.stringify(response).includes('private-token'));
  await f.server.close();
});

test('bounded frames, incomplete EOF and single close stop host ownership', async () => {
  const f = fixture({}, { maxFrameBytes: 1024 }); f.raw('x'.repeat(1025)); await f.server.done;
  assert.equal(f.closed(), 1); assert.deepEqual(f.diagnostics, [{ code: 'stdio_frame_too_large' }]);
  await f.server.close(); assert.equal(f.closed(), 1);
  const g = fixture(); g.raw('{'); g.input.end(); await g.server.done;
  assert.equal(g.diagnostics[0].code, 'stdio_incomplete_frame');
});

test('malformed JSON, batches, invalid IDs and excessive nesting cannot invoke tools', async () => {
  const f = fixture(); await f.initialize();
  for (const value of ['{bad}\n', '[]\n', JSON.stringify({ jsonrpc: '2.0', id: null, method: 'tools/list' }) + '\n', JSON.stringify({ x: Array.from({ length: 1 }, () => null) }) + '\n']) {
    f.raw(value); await turn(); await f.server.flush(); assert(f.rows.at(-1).error);
  }
  let value = {}; for (let i = 0; i < 40; i++) value = { nested: value };
  f.raw(value); await turn(); await f.server.flush(); assert(f.rows.at(-1).error); await f.server.close();
});

test('duplicate request ID and maximum inflight cannot create a second side effect', async () => {
  let resolve, calls = 0;
  const f = fixture({ broker_receive: () => { calls++; return new Promise(r => { resolve = r; }); } }, { maxInflight: 1 });
  await f.initialize(); f.raw({ jsonrpc: '2.0', id: 'pending', method: 'tools/call', params: { name: 'broker_receive' } }); await turn();
  f.raw({ jsonrpc: '2.0', id: 'pending', method: 'tools/call', params: { name: 'broker_receive' } }); await turn(); await f.server.flush();
  assert.equal(f.rows.at(-1).error.code, -32600); assert.equal(calls, 1);
  f.raw({ jsonrpc: '2.0', id: 'second', method: 'tools/call', params: { name: 'broker_receive' } }); await f.server.done;
  assert.equal(calls, 1); assert(f.diagnostics.some(item => item.code === 'stdio_capacity_exceeded'));
  resolve({ message: null }); await turn();
});

test('oversized result is bounded and does not claim native acceptance', async () => {
  const f = fixture({ broker_receive: async () => ({ message: 'x'.repeat(3000) }) }, { maxResponseBytes: 2048 });
  await f.initialize(); const response = await f.send('tools/call', { name: 'broker_receive' });
  assert.equal(response.error.code, -32603); assert.match(response.error.message, /no native acceptance/);
  await f.server.close();
});

test('output backpressure is finite even when peer stops reading', async () => {
  const input = new PassThrough(), diagnostics = []; let writes = 0;
  const output = new Writable({ write(chunk, encoding, cb) { writes++; /* Deliberately never drain. */ } });
  const server = serveStdio({ input, output, tools: {}, maxInflight: 2, onDiagnostic: d => diagnostics.push(d) });
  for (let id = 0; id < 4; id++) { input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n'); await turn(); }
  await server.done; assert(diagnostics.some(item => item.code === 'stdio_output_backpressure')); assert.equal(writes, 1);
});
