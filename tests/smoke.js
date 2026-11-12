'use strict';
// Dependency-free simulation of the Socket.IO event flows. Does not replace browser/E2E testing.
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const fakeSockets = new Map();
let connectionHandler;
let nextId = 0;
class FakeIo {
  on(event, cb) { if (event === 'connection') connectionHandler = cb; }
  to(room) {
    return { emit(event, data) {
      for (const socket of fakeSockets.values()) {
        if (socket.rooms.has(room)) socket.messages.push({ event, data });
      }
    }};
  }
}
function fakeExpress() { return { disable() {}, use() {}, get() {} }; }
fakeExpress.static = () => () => {};
Module._load = function(name, parent, isMain) {
  if (name === 'express') return fakeExpress;
  if (name === 'http') return { createServer: () => ({ listen(port, host, cb) { if (cb) cb(); } }) };
  if (name === 'socket.io') return { Server: FakeIo };
  if (name === 'qrcode') return { toBuffer: async () => Buffer.from('fake PNG') };
  return originalLoad.call(this, name, parent, isMain);
};
require('../server.js');
Module._load = originalLoad;
function connect() {
  const socket = { id: `socket-${++nextId}`, data: {}, rooms: new Set([`socket-${nextId}`]), messages: [], handlers: {},
    on(event, cb) { this.handlers[event] = cb; },
    join(room) { this.rooms.add(room); },
    leave(room) { this.rooms.delete(room); },
    send(event, data) { let result; const cb = this.handlers[event]; assert.ok(cb, event); cb(data, answer => { result = answer; }); return result; },
    getState() { return [...this.messages].reverse().find(x => x.event === 'room:state')?.data; },
    getPlayerState() { return [...this.messages].reverse().find(x => x.event === 'player:state')?.data; }
  };
  fakeSockets.set(socket.id, socket);
  connectionHandler(socket);
  return socket;
}
const host = connect();
const created = host.send('host:create', {});
assert.equal(created.ok, true);
const code = created.code;
assert.equal(host.getState().phase, 'waiting');
const p1 = connect(), p2 = connect(), p3 = connect();
for (const [socket, name] of [[p1,'איתי'],[p2,'רוני'],[p3,'מיכל']]) {
  const response = socket.send('player:join', { code, name });
  assert.equal(response.ok, true);
  assert.equal(socket.getPlayerState().id, response.id);
}
const intruder = connect();
assert.equal(intruder.send('host:next', { code }).ok, false, 'Non-host cannot advance');
assert.equal(host.send('host:questions:set', { code, questions: [{ question: 'מה עדיף?', a: 'א', b: 'ב' }] }).ok, true);
assert.equal(host.send('host:next', { code }).ok, true);
assert.equal(host.getState().phase, 'voting');
assert.equal(host.send('host:lock', { code }).ok, false, 'Must have one vote');
assert.equal(p1.send('player:vote', { code, choice: 'a' }).ok, true);
assert.equal(p2.send('player:vote', { code, choice: 'a' }).ok, true);
assert.equal(p3.send('player:vote', { code, choice: 'b' }).ok, true);
assert.equal(host.getState().result, null, 'Voting must remain secret');
assert.equal(host.send('host:lock', { code }).ok, true);
assert.equal(p1.getState().phase, 'guessing');
assert.equal(p1.getState().result, null, 'Guessing must remain secret');
assert.equal(p1.getState().guessTotal, 3);
assert.equal(p1.send('player:guess', { code, guess: 4 }).ok, false, 'Out-of-range guess denied');
assert.equal(p1.send('player:guess', { code, guess: 2 }).ok, true);
assert.equal(p2.send('player:guess', { code, guess: 1 }).ok, true);
assert.equal(p3.send('player:guess', { code, guess: 0 }).ok, true);
assert.equal(host.send('host:reveal', { code }).ok, true);
assert.equal(host.getState().phase, 'results');
assert.equal(host.getState().result.aCount, 2);
assert.equal(host.getState().result.bCount, 1);
assert.equal(p1.getPlayerState().earned, 100);
assert.equal(p2.getPlayerState().earned, 17);
assert.equal(p3.getPlayerState().earned, 0);
assert.equal(host.send('host:reveal', { code }).ok, false, 'Cannot double-score');
assert.equal(host.send('host:next', { code }).ok, true);
assert.equal(host.getState().phase, 'finished');
assert.equal(host.send('host:restart', { code }).ok, true);
assert.equal(host.getState().phase, 'waiting');
assert.equal(host.getState().players[0].score, 0);
const restored = connect();
assert.equal(restored.send('host:attach', { code, token: created.token }).ok, true);
assert.equal(restored.getState().code, code);
console.log('✓ Smoke test passed: join, voting, secrecy, guess, score, advance, reset, reconnect, permissions');
