// Test-only observer/provider for an actual official CLI. It never controls the
// connector, edits an inbox, emits native lifecycle events or changes a draft.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function observe(pi) {
  const { fauxProvider, fauxAssistantMessage } = await import(pathToFileURL(join(
    process.env.PSST_PI_HOST, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')));
  const record = value => appendFileSync(process.env.PSST_PI_OBSERVATIONS,
    JSON.stringify({ ...value, at: Date.now(), pid: process.pid }) + '\n', { mode: 0o600 });
  const provider = fauxProvider({ tokensPerSecond: 100000, models: [{ id: 'faux-1' }, { id: 'faux-2' }] });
  provider.appendResponses(Array.from({ length: 64 }, () => context => {
    record({ event: 'provider_call', content: context.messages });
    return fauxAssistantMessage('Disposable local provider receipt.');
  }));
  pi.registerProvider(provider.provider);
  pi.on('model_select', event => record({ event: 'model_select', model_id: event.model.id, provider: event.model.provider }));
  pi.on('agent_settled', event => record({ event: 'agent_settled', aborted: event.aborted === true }));
  let interval;
  pi.on('session_start', (_event, ctx) => {
    record({ event: 'session_start', sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() });
    clearInterval(interval);
    let last;
    interval = setInterval(() => {
      const draft = ctx.ui.getEditorText();
      if (draft !== last) {
        record({ event: 'editor', sessionId: ctx.sessionManager.getSessionId(), text: draft });
        last = draft;
      }
    }, 25);
    interval.unref();
  });
  pi.on('session_shutdown', (_event, ctx) => {
    clearInterval(interval);
    record({ event: 'session_shutdown', sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() });
  });
}
