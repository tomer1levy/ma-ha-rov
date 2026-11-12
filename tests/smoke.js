'use strict';
// Dependency-free Socket.IO simulation with fake time, no 2-minute wait.
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const originalDateNow = Date.now;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
let fakeNow = 1000000;
Date.now = () => fakeNow;
const timers = new Map();
let nextTimer = 0;
global.setTimeout = (fn, delay) => {
  const id = ++nextTimer;
  timers.set(id, { at: fakeNow + delay, fn });
  return { id, unref() {} };
};
global.clearTimeout = timer => timers.delete(timer?.id);
function tick(ms) {
  const to = fakeNow + ms;
  while (true) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > to) break;
    fakeNow = next[1].at;
    timers.delete(next[0]);
    next[1].fn();
  }
  fakeNow = to;
}
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
const players = ['איתי','רוני','מיכל','ערן','רותם'].map(name => {
  const p = connect();
  const response = p.send('player:join', { code, name });
  assert.equal(response.ok, true);
  assert.equal(p.getPlayerState().id, response.id);
  return p;
});
const intruder = connect();
assert.equal(intruder.send('host:next', { code }).ok, false, 'Non-host cannot advance');
assert.equal(host.send('host:questions:set', { code, questions: [{ question: 'מה עדיף?', a: 'א', b: 'ב' }] }).ok, true);
assert.equal(host.send('host:next', { code }).ok, true);
assert.equal(host.getState().phase, 'voting');
assert.equal(host.getState().phaseEndsAt, fakeNow + 60000);
assert.equal(host.getState().phaseDurationMs, 60000);
assert.equal(host.send('host:lock', { code }).ok, false, 'Must have one vote for manual lock');
for (const [i, p] of players.entries()) assert.equal(p.send('player:vote', { code, choice: i < 4 ? 'a' : 'b' }).ok, true);
assert.equal(host.getState().result, null, 'Voting must remain secret');
tick(59999);
assert.equal(host.getState().phase, 'voting', 'Voting lasts a full minute');
tick(1);
assert.equal(host.getState().phase, 'guessing', 'Automatically starts guessing after 60 seconds');
assert.equal(host.getState().result, null, 'Guessing must remain secret');
assert.equal(host.getState().guessTotal, 5);
assert.equal(host.getState().phaseEndsAt, fakeNow + 60000);
assert.equal(players[0].send('player:vote', { code, choice: 'b' }).ok, false, 'Late votes denied');
assert.equal(players[0].send('player:guess', { code, guess: 6 }).ok, false, 'Out-of-range guess denied');
for (const [i, p] of players.entries()) assert.equal(p.send('player:guess', { code, guess: 4 - i }).ok, true);
tick(59999);
assert.equal(host.getState().phase, 'guessing', 'Guessing lasts a full minute');
tick(1);
assert.equal(host.getState().phase, 'results', 'Automatically reveals at 60 seconds');
assert.equal(host.getState().result.aCount, 4);
assert.equal(host.getState().result.bCount, 1);
assert.deepEqual(players.map(p => p.getPlayerState().earned), [30, 10, 5, 2, 0], 'Exact new scoring system');
assert.equal(host.send('host:reveal', { code }).ok, false, 'Cannot double-score');
assert.equal(host.send('host:next', { code }).ok, true);
assert.equal(host.getState().phase, 'finished');
assert.equal(host.send('host:restart', { code }).ok, true);
assert.equal(host.getState().phase, 'waiting');
assert.equal(host.getState().phaseEndsAt, null);
assert.equal(host.getState().players[0].score, 0);
// Empty-vote scenario must not block automatic progress or divide by zero.
assert.equal(host.send('host:next', { code }).ok, true);
tick(60000);
assert.equal(host.getState().phase, 'guessing', 'No votes still transitions');
tick(60000);
assert.equal(host.getState().phase, 'results', 'No votes still reveal results');
assert.equal(host.getState().result.aCount, 0);
assert.equal(host.getState().result.total, 0);
assert.equal(host.getState().players.every(p => p.score === 0), true);
const restored = connect();
assert.equal(restored.send('host:attach', { code, token: created.token }).ok, true);
assert.equal(restored.getState().code, code);
Date.now = originalDateNow;
global.setTimeout = originalSetTimeout;
global.clearTimeout = originalClearTimeout;
console.log('✓ Smoke test passed: 60s automatic voting/guessing, scores [30,10,5,2,0], no votes, secrecy, permissions, reset, reconnect');
