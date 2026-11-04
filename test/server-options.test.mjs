import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerServer } from '../src/server.mjs';

test('non-loopback plaintext and implicit insecure startup are rejected',()=>{
 assert.throws(()=>createBrokerServer({host:'0.0.0.0',insecureDevelopment:true}),/TLS|loopback/);
 assert.throws(()=>createBrokerServer({host:'127.0.0.1'}),/TLS/);
});

test('proxy transport must be explicit boolean and cannot combine with TLS or development exceptions',()=>{
 for(const options of [
  {proxyTransport:'true'},{proxyTransport:1},{proxyTransport:true,insecureDevelopment:true},
  {proxyTransport:true,proxyLoopback:true},{proxyTransport:true,tls:{certFile:'unused',keyFile:'unused'}},
  {host:'0.0.0.0',proxyLoopback:true},{host:'0.0.0.0'}
 ])assert.throws(()=>createBrokerServer(options));
});
