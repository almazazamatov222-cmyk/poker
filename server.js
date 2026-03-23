const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve static files — works whether public/ exists or files are at root
const fs2 = require('fs');
const publicDir = path.join(__dirname, 'public');
const hasPublic = fs2.existsSync(publicDir);
app.use(express.static(hasPublic ? publicDir : __dirname));

// Debug + fallback root handler
app.get('/', (req, res) => {
  const idx1 = path.join(__dirname, 'public', 'index.html');
  const idx2 = path.join(__dirname, 'index.html');
  if (fs2.existsSync(idx1)) return res.sendFile(idx1);
  if (fs2.existsSync(idx2)) return res.sendFile(idx2);
  // Show debug info so we can see what's wrong
  const files = fs2.readdirSync(__dirname);
  res.status(500).send('Cannot find index.html. Dir: ' + __dirname + ' | Files: ' + files.join(', '));
});

const rooms = {};

// ═══════════════════════════════════════════
//  DECK
// ═══════════════════════════════════════════
const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = [2,3,4,5,6,7,8,9,10,11,12,13,14];

function createDeck() {
  return SUITS.flatMap(s => RANKS.map(r => ({ r, s })));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ═══════════════════════════════════════════
//  HAND EVALUATION
// ═══════════════════════════════════════════
function evalFive(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const isFlush = new Set(cards.map(c => c.s)).size === 1;

  let straight = false, strHigh = ranks[0];
  if (new Set(ranks).size === 5 && ranks[0] - ranks[4] === 4) straight = true;
  if (ranks[0]===14 && ranks[1]===5 && ranks[2]===4 && ranks[3]===3 && ranks[4]===2) {
    straight = true; strHigh = 5;
  }

  const cnt = {};
  ranks.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
  const grps = Object.entries(cnt)
    .sort((a, b) => b[1] - a[1] || +b[0] - +a[0])
    .map(e => +e[0]);
  const freq = grps.map(r => cnt[r]);

  if (isFlush && straight) return [8, strHigh];
  if (freq[0] === 4)               return [7, ...grps];
  if (freq[0] === 3 && freq[1]===2)return [6, ...grps];
  if (isFlush)                     return [5, ...ranks];
  if (straight)                    return [4, strHigh];
  if (freq[0] === 3)               return [3, ...grps];
  if (freq[0] === 2 && freq[1]===2)return [2, ...grps];
  if (freq[0] === 2)               return [1, ...grps];
  return [0, ...ranks];
}

function bestHand(cards) {
  if (cards.length < 5) return [0];
  if (cards.length === 5) return evalFive(cards);
  let best = [-1];
  const n = cards.length;
  for (let a=0;a<n-4;a++) for (let b=a+1;b<n-3;b++)
  for (let c=b+1;c<n-2;c++) for (let d=c+1;d<n-1;d++)
  for (let e=d+1;e<n;e++) {
    const v = evalFive([cards[a],cards[b],cards[c],cards[d],cards[e]]);
    if (cmp(v, best) > 0) best = v;
  }
  return best;
}

function cmp(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

const HAND_NAMES = [
  'Старшая карта','Одна пара','Две пары','Тройка',
  'Стрит','Флеш','Фулл Хаус','Каре','Стрит-флеш'
];

// ═══════════════════════════════════════════
//  GAME STATE
// ═══════════════════════════════════════════
function makeRoom(settings) {
  return {
    id: crypto.randomBytes(3).toString('hex').toUpperCase(),
    settings,
    players: [],
    deck: [],
    community: [],
    pot: 0,
    phase: 'waiting',
    dealerIdx: 0,
    currentIdx: -1,
    currentBet: 0,
    lastRaise: settings.bigBlind,
    handNum: 0,
    nextHandTimer: null
  };
}

function makePlayer(id, name, chips, isHost) {
  return {
    id, name, chips,
    cards: [], bet: 0,
    folded: false, allIn: false,
    inHand: false, acted: false,
    isHost, blindLabel: null,
    winner: false, handName: null, handValue: null
  };
}

const active  = r => r.players.filter(p => p.inHand && !p.folded);
const canBet  = r => r.players.filter(p => p.inHand && !p.folded && !p.allIn);

// ═══════════════════════════════════════════
//  GAME FLOW
// ═══════════════════════════════════════════
function startHand(room) {
  const eligible = room.players.filter(p => p.chips > 0);
  if (eligible.length < 2) { room.phase = 'waiting'; return; }

  room.handNum++;
  room.deck = shuffle(createDeck());
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.lastRaise = room.settings.bigBlind;
  room.phase = 'preflop';

  room.players.forEach(p => {
    p.cards = []; p.bet = 0;
    p.folded = false; p.allIn = false;
    p.inHand = p.chips > 0;
    p.acted = false; p.blindLabel = null;
    p.winner = false; p.handName = null; p.handValue = null;
  });

  const n = eligible.length;
  const dIdx = room.dealerIdx % n;
  const sbIdx = n === 2 ? dIdx : (dIdx + 1) % n;
  const bbIdx = (sbIdx + 1) % n;
  const firstIdx = n === 2 ? bbIdx : (bbIdx + 1) % n;

  // Ante
  if (room.settings.ante > 0) {
    eligible.forEach(p => {
      const a = Math.min(p.chips, room.settings.ante);
      p.chips -= a; room.pot += a;
      if (!p.chips) p.allIn = true;
    });
  }

  // Deal 2 cards
  eligible.forEach(p => { p.cards = [room.deck.pop(), room.deck.pop()]; });

  // Blinds
  const sb = eligible[sbIdx];
  const bb = eligible[bbIdx];

  const sbAmt = Math.min(sb.chips, room.settings.smallBlind);
  sb.chips -= sbAmt; sb.bet = sbAmt; room.pot += sbAmt;
  sb.blindLabel = 'МБ';
  if (!sb.chips) sb.allIn = true;

  const bbAmt = Math.min(bb.chips, room.settings.bigBlind);
  bb.chips -= bbAmt; bb.bet = bbAmt; room.pot += bbAmt;
  bb.blindLabel = 'ББ';
  if (!bb.chips) bb.allIn = true;

  room.currentBet = bbAmt;

  // Dealer label
  const dealer = eligible[dIdx];
  dealer.blindLabel = dealer.blindLabel ? dealer.blindLabel + '/Д' : 'Д';

  // First to act
  const firstPlayer = eligible[firstIdx];
  room.currentIdx = room.players.indexOf(firstPlayer);
  skipAllIn(room);
}

function skipAllIn(room) {
  if (room.currentIdx < 0) return;
  const p = room.players[room.currentIdx];
  if (p && (p.allIn || p.folded || !p.inHand)) advanceTurn(room);
}

function advanceTurn(room) {
  const n = room.players.length;
  let idx = (room.currentIdx + 1) % n;
  for (let i = 0; i < n; i++) {
    const p = room.players[idx];
    if (p.inHand && !p.folded && !p.allIn) { room.currentIdx = idx; return; }
    idx = (idx + 1) % n;
  }
  room.currentIdx = -1;
}

function roundDone(room) {
  const can = canBet(room);
  if (!can.length) return true;
  return can.every(p => p.acted && p.bet === room.currentBet);
}

function advanceStreet(room) {
  room.players.forEach(p => {
    if (p.inHand) { p.bet = 0; p.acted = false; }
  });
  room.currentBet = 0;
  room.lastRaise = room.settings.bigBlind;

  if      (room.phase === 'preflop') { room.phase = 'flop';  room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); }
  else if (room.phase === 'flop')    { room.phase = 'turn';  room.community.push(room.deck.pop()); }
  else if (room.phase === 'turn')    { room.phase = 'river'; room.community.push(room.deck.pop()); }
  else if (room.phase === 'river')   { return doShowdown(room); }

  const can = canBet(room);
  if (!can.length) return advanceStreet(room); // everyone all-in, run it out

  const n = room.players.length;
  const d = room.dealerIdx % n;
  let idx = (d + 1) % n;
  for (let i = 0; i < n; i++) {
    const p = room.players[idx];
    if (p.inHand && !p.folded && !p.allIn) { room.currentIdx = idx; return null; }
    idx = (idx + 1) % n;
  }
  return doShowdown(room);
}

function doShowdown(room) {
  room.phase = 'showdown';
  const inHand = active(room);

  inHand.forEach(p => {
    p.handValue = bestHand([...p.cards, ...room.community]);
    p.handName = HAND_NAMES[p.handValue[0]] || '?';
  });

  inHand.sort((a, b) => cmp(b.handValue, a.handValue));
  const top = inHand[0].handValue;
  const winners = inHand.filter(p => cmp(p.handValue, top) === 0);
  const share = Math.floor(room.pot / winners.length);
  const rem = room.pot % winners.length;
  winners.forEach((p, i) => { p.chips += share + (i === 0 ? rem : 0); p.winner = true; });
  room.pot = 0;

  return {
    winners: winners.map(p => ({ id: p.id, name: p.name, handName: p.handName })),
    allHands: inHand.map(p => ({ id: p.id, name: p.name, cards: p.cards, handName: p.handName }))
  };
}

function doAction(room, playerId, action, amount) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;
  if (room.players[room.currentIdx]?.id !== playerId) return;
  if (room.phase === 'waiting' || room.phase === 'showdown') return;

  switch (action) {
    case 'fold':
      player.folded = true; player.inHand = false; player.acted = true;
      break;

    case 'check':
      if (player.bet < room.currentBet) return;
      player.acted = true;
      break;

    case 'call': {
      const need = Math.min(player.chips, room.currentBet - player.bet);
      player.chips -= need; room.pot += need; player.bet += need;
      if (!player.chips) player.allIn = true;
      player.acted = true;
      break;
    }

    case 'raise': {
      const minTo = room.currentBet + room.lastRaise;
      const to = Math.max(+amount || 0, minTo);
      const add = Math.min(player.chips, to - player.bet);
      player.chips -= add; room.pot += add;
      const newBet = player.bet + add;
      room.lastRaise = Math.max(room.lastRaise, newBet - room.currentBet);
      room.currentBet = newBet; player.bet = newBet;
      if (!player.chips) player.allIn = true;
      room.players.forEach(p => {
        if (p.id !== playerId && p.inHand && !p.folded && !p.allIn) p.acted = false;
      });
      player.acted = true;
      break;
    }

    case 'allin': {
      const add = player.chips;
      player.chips = 0; room.pot += add;
      const newBet = player.bet + add;
      if (newBet > room.currentBet) {
        room.lastRaise = Math.max(room.lastRaise, newBet - room.currentBet);
        room.currentBet = newBet;
        room.players.forEach(p => {
          if (p.id !== playerId && p.inHand && !p.folded && !p.allIn) p.acted = false;
        });
      }
      player.bet = newBet; player.allIn = true; player.acted = true;
      break;
    }
  }

  // Only one player left?
  const left = active(room);
  if (left.length === 1) {
    left[0].chips += room.pot; left[0].winner = true; room.pot = 0; room.phase = 'showdown';
    return { winners: [{ id: left[0].id, name: left[0].name }], allHands: [] };
  }

  if (roundDone(room)) return advanceStreet(room);

  advanceTurn(room);
  return null;
}

// ═══════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════
io.on('connection', socket => {
  console.log(`+ ${socket.id}`);

  socket.on('create-room', ({ name, settings }) => {
    if (!name?.trim()) return socket.emit('err', 'Введите имя');
    const room = makeRoom(settings);
    const p = makePlayer(socket.id, name.trim().slice(0,20), settings.buyIn, true);
    room.players.push(p);
    rooms[room.id] = room;
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit('joined', { roomId: room.id });
    broadcastState(room);
    console.log(`Room ${room.id} created by ${name}`);
  });

  socket.on('join-room', ({ name, roomId }) => {
    if (!name?.trim()) return socket.emit('err', 'Введите имя');
    const room = rooms[roomId?.toUpperCase?.()];
    if (!room) return socket.emit('err', 'Комната не найдена');
    if (room.players.length >= 10) return socket.emit('err', 'Комната заполнена');
    if (room.players.find(p => p.id === socket.id)) return socket.emit('err', 'Вы уже в комнате');

    const p = makePlayer(socket.id, name.trim().slice(0,20), room.settings.buyIn, false);
    room.players.push(p);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit('joined', { roomId: room.id });
    socket.to(room.id).emit('peer-joined', { peerId: socket.id, name: p.name });
    broadcastState(room);
  });

  socket.on('start-game', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p?.isHost) return socket.emit('err', 'Только хост может начать игру');
    if (room.players.length < 2) return socket.emit('err', 'Нужно минимум 2 игрока');
    if (room.nextHandTimer) { clearTimeout(room.nextHandTimer); room.nextHandTimer = null; }
    startHand(room);
    broadcastState(room);
  });

  socket.on('action', ({ action, amount }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (room.phase === 'waiting' || room.phase === 'showdown') return;
    const result = doAction(room, socket.id, action, amount);
    if (room.phase === 'showdown') {
      broadcastState(room, result);
      room.nextHandTimer = setTimeout(() => {
        const r = rooms[room.id]; if (!r) return;
        r.dealerIdx = (r.dealerIdx + 1) % Math.max(r.players.length, 1);
        r.players = r.players.filter(p => p.chips > 0);
        if (r.players.length >= 2) startHand(r); else r.phase = 'waiting';
        broadcastState(r);
        r.nextHandTimer = null;
      }, 7000);
    } else {
      broadcastState(room);
    }
  });

  // WebRTC signaling
  socket.on('offer',  ({to,sdp})       => io.to(to).emit('offer',  {from:socket.id,sdp}));
  socket.on('answer', ({to,sdp})       => io.to(to).emit('answer', {from:socket.id,sdp}));
  socket.on('ice',    ({to,candidate}) => io.to(to).emit('ice',    {from:socket.id,candidate}));

  socket.on('chat', ({ msg }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !msg?.trim()) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p) return;
    io.to(room.id).emit('chat', { name: p.name, msg: msg.slice(0,200), ts: Date.now() });
  });

  socket.on('disconnect', () => {
    console.log(`- ${socket.id}`);
    const room = rooms[socket.data.roomId];
    if (!room) return;
    io.to(room.id).emit('peer-left', { peerId: socket.id });
    room.players = room.players.filter(p => p.id !== socket.id);
    if (!room.players.length) { delete rooms[room.id]; return; }
    if (!room.players.find(p => p.isHost)) room.players[0].isHost = true;

    if (room.phase !== 'waiting' && room.phase !== 'showdown') {
      const left = active(room);
      if (left.length === 1) {
        left[0].chips += room.pot; left[0].winner = true; room.pot = 0; room.phase = 'showdown';
        const result = { winners:[{id:left[0].id,name:left[0].name}], allHands:[] };
        broadcastState(room, result);
        room.nextHandTimer = setTimeout(() => {
          const r = rooms[room.id]; if (!r) return;
          r.dealerIdx = (r.dealerIdx+1) % Math.max(r.players.length,1);
          r.players = r.players.filter(p => p.chips > 0);
          if (r.players.length >= 2) startHand(r); else r.phase = 'waiting';
          broadcastState(r); r.nextHandTimer = null;
        }, 3000);
        return;
      }
      // If current player disconnected, advance turn
      if (room.currentIdx >= room.players.length) room.currentIdx = 0;
    }
    broadcastState(room);
  });
});

function broadcastState(room, extra = null) {
  room.players.forEach(p => {
    const state = viewFor(room, p.id);
    if (extra) state.showdown = extra;
    io.to(p.id).emit('state', state);
  });
}

function viewFor(room, myId) {
  return {
    roomId: room.id,
    settings: room.settings,
    phase: room.phase,
    pot: room.pot,
    community: room.community,
    dealerIdx: room.dealerIdx % Math.max(room.players.length, 1),
    currentIdx: room.currentIdx,
    currentBet: room.currentBet,
    lastRaise: room.lastRaise,
    handNum: room.handNum,
    myId,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, chips: p.chips,
      bet: p.bet, folded: p.folded, allIn: p.allIn,
      inHand: p.inHand, isHost: p.isHost,
      blindLabel: p.blindLabel, winner: p.winner,
      handName: p.handName || null,
      cardCount: p.cards?.length || 0,
      cards: (p.id === myId || room.phase === 'showdown')
        ? (p.cards || [])
        : (p.cards || []).map(() => null),
      idx: i
    }))
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🃏  Poker Night running on port ${PORT}`);
});
