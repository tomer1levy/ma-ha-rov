'use strict';

const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });
const rooms = new Map();
const PHASE_LENGTH_MS = 60 * 1000; // 60 seconds for both voting and guessing

const DEFAULT_QUESTIONS = [
  { question: 'מה עדיף?', a: 'להיות קרח', b: 'לשתות בקבוק קטשופ בכל יום' },
  { question: 'איפה הייתם מעדיפים לגור?', a: 'וילה בעפולה', b: 'דירת שני חדרים בתל אביב' },
  { question: 'איזה סידור מילואים הייתם מעדיפים?', a: '42 ימים ברצף', b: 'שלושה חודשים של 9–5' },
  { question: 'מה הייתם בוחרים?', a: 'לדבר רק בחרוזים במשך שנה', b: 'לשיר כל משפט שני' },
  { question: 'מה פחות גרוע?', a: 'להגיע תמיד 20 דקות מוקדם', b: 'להגיע תמיד 10 דקות באיחור' },
  { question: 'מה הייתם מעדיפים?', a: 'לוותר על קפה לשנה', b: 'לוותר על שוקולד לשנה' },
  { question: 'איזה כישרון הייתם בוחרים?', a: 'לזכור כל שם ששמעתם', b: 'לזכור כל מספר טלפון שראיתם' },
  { question: 'מה הייתם בוחרים?', a: 'חופשה בלי טלפון', b: 'חופשה בלי מזוודה' }
];

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function localIp() {
  const entries = Object.values(os.networkInterfaces()).flat();
  const ipv4 = entries.find(i => i && i.family === 'IPv4' && !i.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
  return ipv4?.address || entries.find(i => i && i.family === 'IPv4' && !i.internal)?.address || 'localhost';
}

function publicUrl() {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://${localIp()}:${PORT}`).replace(/\/$/, '');
}

function err(ack, message) {
  if (typeof ack === 'function') ack({ ok: false, error: message });
}
function success(ack, data = {}) {
  if (typeof ack === 'function') ack({ ok: true, ...data });
}
function getRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}
function currentQuestion(room) {
  return room.questions[room.index] || null;
}
function votesOf(room) {
  return [...room.players.values()].filter(p => p.vote === 'a' || p.vote === 'b');
}
function isHost(socket, room) {
  return room && socket.data?.role === 'host' && socket.data?.roomCode === room.code && socket.data?.hostToken === room.hostToken;
}
function asPlayer(socket, room) {
  if (!room || socket.data?.role !== 'player' || socket.data?.roomCode !== room.code) return null;
  return room.players.get(socket.data.playerId) || null;
}
function publicState(room) {
  const votes = votesOf(room);
  const resultVisible = room.phase === 'results' || room.phase === 'finished';
  const aCount = votes.filter(p => p.vote === 'a').length;
  const guessCount = votes.filter(p => Number.isInteger(p.guess)).length;
  return {
    code: room.code,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt ?? null,
    phaseDurationMs: room.phaseEndsAt ? PHASE_LENGTH_MS : null,
    serverNow: Date.now(),
    index: room.index,
    round: room.index + 1,
    totalRounds: room.questions.length,
    question: currentQuestion(room),
    players: [...room.players.values()].map(p => ({
      name: p.name,
      score: p.score,
      earned: resultVisible ? p.earned : null,
      connected: p.sockets.size > 0,
      voted: Boolean(p.vote),
      guessed: Number.isInteger(p.guess)
    })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'he')),
    votedCount: votes.length,
    guessCount,
    guessTotal: room.phase === 'guessing' || resultVisible ? votes.length : null,
    result: resultVisible && room.index >= 0 ? {
      total: votes.length,
      aCount,
      bCount: votes.length - aCount,
      percentA: votes.length ? Math.round(aCount / votes.length * 100) : 0
    } : null
  };
}
function broadcast(room) {
  room.updatedAt = Date.now();
  io.to(room.code).emit('room:state', publicState(room));
  for (const player of room.players.values()) {
    for (const socketId of player.sockets) {
      io.to(socketId).emit('player:state', {
        id: player.id,
        name: player.name,
        vote: player.vote,
        guess: player.guess,
        earned: room.phase === 'results' || room.phase === 'finished' ? player.earned : null,
        score: player.score
      });
    }
  }
  io.to(`host:${room.code}`).emit('host:questions', room.questions);
}
function clearPhaseTimer(room) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  room.phaseTimer = null;
  room.phaseEndsAt = null;
}
function startTimedPhase(room, phase) {
  clearPhaseTimer(room);
  room.phase = phase;
  room.phaseEndsAt = Date.now() + PHASE_LENGTH_MS;
  const roundIndex = room.index;
  room.phaseTimer = setTimeout(() => {
    if (room.index !== roundIndex || room.phase !== phase) return;
    if (phase === 'voting') closeVoting(room);
    else revealResults(room);
  }, PHASE_LENGTH_MS);
  room.phaseTimer.unref?.();
}
function closeVoting(room) {
  if (room.phase !== 'voting') return;
  startTimedPhase(room, 'guessing');
  broadcast(room);
}
function pointsForGuess(guess, actual) {
  if (!Number.isInteger(guess)) return 0;
  return [30, 10, 5, 2][Math.abs(guess - actual)] || 0;
}
function revealResults(room) {
  if (room.phase !== 'guessing') return;
  const votes = votesOf(room);
  const countA = votes.filter(p => p.vote === 'a').length;
  for (const player of room.players.values()) {
    player.earned = pointsForGuess(player.guess, countA);
    player.score += player.earned;
  }
  clearPhaseTimer(room);
  room.phase = 'results';
  broadcast(room);
}

function setAssociation(socket, room, role, player) {
  if (socket.data?.roomCode) socket.leave(socket.data.roomCode);
  if (socket.data?.role === 'host') socket.leave(`host:${socket.data.roomCode}`);
  if (socket.data?.role === 'player') {
    const oldRoom = getRoom(socket.data.roomCode);
    const oldPlayer = oldRoom?.players.get(socket.data.playerId);
    oldPlayer?.sockets.delete(socket.id);
  }
  socket.data = { roomCode: room.code, role, ...(player ? { playerId: player.id } : { hostToken: room.hostToken }) };
  socket.join(room.code);
  if (role === 'host') socket.join(`host:${room.code}`);
  if (role === 'player') player.sockets.add(socket.id);
}
function validateQuestions(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) return null;
  const arr = [];
  for (const q of input) {
    if (typeof q?.question !== 'string' || typeof q?.a !== 'string' || typeof q?.b !== 'string') return null;
    const question = q.question.trim(), a = q.a.trim(), b = q.b.trim();
    if (!question || !a || !b || question.length > 180 || a.length > 160 || b.length > 160 || a === b) return null;
    arr.push({ question, a, b });
  }
  return arr;
}

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
app.get('/api/info', (_req, res) => res.json({ suggestedBase: publicUrl() }));
app.get('/api/qr', async (req, res) => {
  const value = String(req.query.value || '');
  if (value.length < 8 || value.length > 450 || !/^https?:\/\//i.test(value)) return res.status(400).end();
  try {
    res.type('image/png');
    res.set('Cache-Control', 'no-store');
    res.send(await QRCode.toBuffer(value, { width: 340, margin: 2, color: { dark: '#111827', light: '#FFFFFFFF' } }));
  } catch {
    res.status(500).end();
  }
});
app.get(['/host', '/play'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', socket => {
  socket.on('host:create', (_payload, ack) => {
    const code = roomCode();
    const room = {
      code,
      hostToken: crypto.randomBytes(24).toString('hex'),
      questions: DEFAULT_QUESTIONS.map(q => ({ ...q })),
      phase: 'waiting', index: -1, phaseEndsAt: null, phaseTimer: null,
      players: new Map(),
      createdAt: Date.now(), updatedAt: Date.now()
    };
    rooms.set(code, room);
    setAssociation(socket, room, 'host');
    success(ack, { code, token: room.hostToken });
    broadcast(room);
  });

  socket.on('host:attach', ({ code, token } = {}, ack) => {
    const room = getRoom(code);
    if (!room || !token || token !== room.hostToken) return err(ack, 'לא נמצא חדר ניהול מתאים.');
    setAssociation(socket, room, 'host');
    success(ack, { code: room.code });
    broadcast(room);
  });

  socket.on('player:join', ({ code, name, playerId } = {}, ack) => {
    const room = getRoom(code);
    if (!room) return err(ack, 'קוד החדר שגוי או שהחדר כבר נסגר.');
    name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
    if (!name) return err(ack, 'צריך לבחור שם להצטרפות.');
    let player = typeof playerId === 'string' ? room.players.get(playerId) : null;
    if (!player) {
      if (room.players.size >= 250) return err(ack, 'החדר מלא.');
      if ([...room.players.values()].some(p => p.name.toLocaleLowerCase('he') === name.toLocaleLowerCase('he'))) {
        return err(ack, 'השם הזה כבר תפוס. נסו שם מעט שונה.');
      }
      player = { id: crypto.randomBytes(16).toString('hex'), name, score: 0, earned: 0, vote: null, guess: null, sockets: new Set() };
      room.players.set(player.id, player);
    }
    setAssociation(socket, room, 'player', player);
    success(ack, { code: room.code, id: player.id, name: player.name });
    broadcast(room);
  });

  socket.on('host:questions:set', ({ code, questions } = {}, ack) => {
    const room = getRoom(code);
    if (!isHost(socket, room)) return err(ack, 'אין הרשאת ניהול.');
    if (room.phase !== 'waiting') return err(ack, 'אפשר לערוך את השאלות רק לפני תחילת המשחק.');
    const valid = validateQuestions(questions);
    if (!valid) return err(ack, 'רשימת שאלות לא תקינה. כל שורה צריכה להכיל שאלה ושתי תשובות שונות.');
    room.questions = valid;
    success(ack, { count: valid.length });
    broadcast(room);
  });

  socket.on('host:next', ({ code } = {}, ack) => {
    const room = getRoom(code);
    if (!isHost(socket, room)) return err(ack, 'אין הרשאת ניהול.');
    if (room.phase !== 'waiting' && room.phase !== 'results') return err(ack, 'כבר מתנהל סבב.');
    if (room.index + 1 >= room.questions.length) {
      clearPhaseTimer(room);
      room.phase = 'finished';
    } else {
      room.index++;
      for (const p of room.players.values()) {
        p.vote = null; p.guess = null; p.earned = 0;
      }
      startTimedPhase(room, 'voting');
    }
    success(ack);
    broadcast(room);
  });

  socket.on('player:vote', ({ code, choice } = {}, ack) => {
    const room = getRoom(code);
    const player = asPlayer(socket, room);
    if (!player) return err(ack, 'צריך להצטרף למשחק מחדש.');
    if (room.phase !== 'voting') return err(ack, 'ההצבעה לשאלה זו הסתיימה.');
    if (Date.now() >= room.phaseEndsAt) { closeVoting(room); return err(ack, 'זמן ההצבעה הסתיים.'); }
    if (choice !== 'a' && choice !== 'b') return err(ack, 'בחירה לא תקינה.');
    player.vote = choice;
    success(ack);
    broadcast(room);
  });

  socket.on('host:lock', ({ code } = {}, ack) => {
    const room = getRoom(code);
    if (!isHost(socket, room)) return err(ack, 'אין הרשאת ניהול.');
    if (room.phase !== 'voting') return err(ack, 'לא ניתן לסגור כעת את ההצבעה.');
    if (votesOf(room).length === 0) return err(ack, 'עדיין לא הצביע אף משתתף.');
    closeVoting(room);
    success(ack);
  });

  socket.on('player:guess', ({ code, guess } = {}, ack) => {
    const room = getRoom(code);
    const player = asPlayer(socket, room);
    if (!player) return err(ack, 'צריך להצטרף למשחק מחדש.');
    if (room.phase !== 'guessing') return err(ack, 'שלב הניחושים אינו פתוח.');
    if (Date.now() >= room.phaseEndsAt) { revealResults(room); return err(ack, 'זמן ההימור הסתיים.'); }
    if (!player.vote) return err(ack, 'רק מי שהצביע בסבב יכול להמר.');
    if (!Number.isInteger(guess) || guess < 0 || guess > votesOf(room).length) return err(ack, 'הניחוש חייב להיות מספר משתתפים חוקי.');
    player.guess = guess;
    success(ack);
    broadcast(room);
  });

  socket.on('host:reveal', ({ code } = {}, ack) => {
    const room = getRoom(code);
    if (!isHost(socket, room)) return err(ack, 'אין הרשאת ניהול.');
    if (room.phase !== 'guessing') return err(ack, 'לא ניתן לחשוף תוצאות כעת.');
    revealResults(room);
    success(ack);
  });

  socket.on('host:restart', ({ code } = {}, ack) => {
    const room = getRoom(code);
    if (!isHost(socket, room)) return err(ack, 'אין הרשאת ניהול.');
    if (room.phase !== 'finished') return err(ack, 'אפשר לפתוח משחק חדש רק לאחר הסיום.');
    clearPhaseTimer(room);
    room.phase = 'waiting'; room.index = -1;
    for (const p of room.players.values()) { p.score = 0; p.earned = 0; p.vote = null; p.guess = null; }
    success(ack);
    broadcast(room);
  });

  socket.on('disconnect', () => {
    if (socket.data?.role === 'player') {
      const room = getRoom(socket.data.roomCode);
      const player = room?.players.get(socket.data.playerId);
      player?.sockets.delete(socket.id);
      if (room) broadcast(room);
    }
  });
});

const cleanup = setInterval(() => {
  const oldest = Date.now() - 24 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.updatedAt < oldest) {
      clearPhaseTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 60 * 1000);
cleanup.unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nמה הרוב? רץ: http://localhost:${PORT}/host`);
  console.log(`קישור הצטרפות: ${publicUrl()}/play\n`);
});
