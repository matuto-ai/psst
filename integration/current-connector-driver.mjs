// One isolated synthetic native host process. No real host credentials or models.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const options = JSON.parse(process.argv[2]);
mkdirSync(options.runtime, { recursive: true, mode: 0o700 });
mkdirSync(join(options.runtime, 'home'), { recursive: true, mode: 0o700 });
const files = { pi: 'pi', 'claude-code': 'claude', 'antigravity-cli': 'antigravity', opencode: 'opencode' };
if (!Object.hasOwn(files, options.type)) throw Error('matrix_unknown_connector');
const { createDriver } = await import(`./current-${files[options.type]}-driver.mjs`);
let driver = await createDriver(options);
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { id, name, args = {}, operationId } = JSON.parse(line);
  try {
    let value;
    if (name === 'observe') value = await driver.observe(args.message_id);
    else if (name === 'acknowledge') value = driver.acknowledge ? await driver.acknowledge(args.message_id) : { automatic: true };
    else if (name === 'set_admission') {
      if (!driver.setAdmission) throw Error('matrix_admission_control_unavailable');
      options.admitNative = args.enabled === true;
      await driver.setAdmission(options.admitNative); value = { enabled: options.admitNative };
    } else if (name === 'restart') {
      if (driver.restart) await driver.restart();
      else { await driver.close(); driver = await createDriver({ ...options, approved: undefined }); }
      value = { restarted: true };
    } else if (name === 'close') { await driver.close(); value = { closed: true }; }
    else value = await driver.call(name, args, operationId);
    process.stdout.write(JSON.stringify({ id, value }) + '\n');
    if (name === 'close') break;
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, error: error.code || error.message }) + '\n');
  }
}
