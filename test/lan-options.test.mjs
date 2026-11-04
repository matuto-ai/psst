import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLanOptions } from '../scripts/lan-broker.mjs';

test('HTTPS startup requires explicit local bind, wildcard acknowledgment and injection-safe SAN',()=>{
  const options={bind:'127.0.0.1',hostname:'host.containers.internal'};
  assert.equal(validateLanOptions(options).port,8787);
  assert.throws(()=>validateLanOptions({...options,bind:'0.0.0.0'}),/wildcard_ack_required/);
  assert.equal(validateLanOptions({...options,bind:'0.0.0.0',allowAllInterfaces:true}).bind,'0.0.0.0');
  assert.throws(()=>validateLanOptions({...options,bind:'192.0.2.123'}),/bind_not_local|interface_inspection_failed/);
  for(const hostname of ['*.example.com','evil\nDNS.2=wrong','a,b','-bad.example','bad/example','https://host.test','127.1','0.0.0.0',''])assert.throws(()=>validateLanOptions({...options,hostname}),/hostname_invalid/);
  for(const port of [80,-1,65536,NaN])assert.throws(()=>validateLanOptions({...options,port}),/port_invalid/);
});
