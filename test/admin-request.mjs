import { Readable } from 'node:stream';
import { ApiError } from '../src/protocol.mjs';

// Exercise the AdminUI handler directly. No HTTP server or socket is started.
export async function adminRequest(admin, path, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from([Buffer.from(String(body))]);
  Object.assign(req, { method, headers: { host: 'admin.test', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const result = { status: null, headers: new Headers(), html: '' };
  const res = {
    writeHead(status, values) { result.status = status; result.headers = new Headers(values); },
    end(value = '') { result.html = String(value); },
  };
  try { result.handled = await admin.handle(req, res, new URL(path, 'http://admin.test')); }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    result.status = error.status;
    result.error = error;
  }
  return result;
}
