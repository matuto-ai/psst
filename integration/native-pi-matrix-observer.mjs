// Official local faux provider only. Never calls connector APIs or writes journals.
import { appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
export default async function observe(pi) {
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(join(
    process.env.PSST_PI_HOST, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')));
  const record = value => appendFileSync(process.env.PSST_PI_OBSERVATIONS, JSON.stringify({ ...value, at: Date.now() }) + '\n', { mode: 0o600 });
  const provider = fauxProvider({ tokensPerSecond: 100000, models: [{ id: 'faux-1' }, { id: 'faux-2' }] });
  let ctx;
  provider.appendResponses(Array.from({ length: 100 }, () => async (context, options) => {
    record({ event: 'provider_call', content: context.messages, model: ctx.model.id });
    const last = context.messages.at(-1);
    const text = last?.role === 'user' ? (typeof last.content === 'string' ? last.content : last.content.filter(x => x.type === 'text').map(x => x.text).join('\n')) : '';
    if (text.startsWith('SEND ')) return fauxAssistantMessage(fauxToolCall('broker_send', JSON.parse(text.slice(5))), { stopReason: 'toolUse' });
    if (text.startsWith('HOLD ')) {
      const marker = text.slice(5); if (!/^[a-z]+$/.test(marker)) throw Error('Invalid fixture hold');
      record({ event: 'holding', marker });
      const deadline = Date.now() + 30000;
      while (!options.signal.aborted && !existsSync(join(dirname(process.env.PSST_PI_OBSERVATIONS), 'release-' + marker))) {
        if (Date.now() > deadline) throw Error('Bounded fixture hold expired');
        await delay(25);
      }
      record({ event: 'released', marker, aborted: options.signal.aborted });
    }
    return fauxAssistantMessage('Disposable local provider completed.');
  }));
  pi.registerProvider(provider.provider);
  pi.on('model_select', (event, c) => record({ event: 'model_select', model_id: event.model.id, sessionId: c.sessionManager.getSessionId() }));
  pi.on('agent_settled', event => record({ event: 'agent_settled', aborted: event.aborted === true }));
  let timer;
  pi.on('session_start', (_event, c) => {
    ctx = c; record({ event: 'session_start', sessionId: c.sessionManager.getSessionId(), sessionFile: c.sessionManager.getSessionFile() });
    let last;
    timer = setInterval(() => {
      const state = { draft: c.ui.getEditorText(), idle: c.isIdle(), model: c.model.id };
      if (JSON.stringify(state) !== last) { last = JSON.stringify(state); record({ event: 'state', ...state }); }
    }, 25); timer.unref();
  });
  pi.on('session_shutdown', () => clearInterval(timer));
}
