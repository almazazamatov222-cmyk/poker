// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const socket = io();
let gameState   = null;
let myId        = null;
let localStream = null;
let peers       = {};   // peerId → RTCPeerConnection
let raiseTarget = 0;
let cameraOn    = false;

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ═══════════════════════════════════════════
//  LOBBY
// ═══════════════════════════════════════════
function switchTab(tab) {
  document.getElementById('tab-create-btn').classList.toggle('active', tab === 'create');
  document.getElementById('tab-join-btn').classList.toggle('active',   tab === 'join');
  document.getElementById('tab-create').classList.toggle('active', tab === 'create');
  document.getElementById('tab-join').classList.toggle('active',   tab === 'join');
}

function createRoom() {
  const name       = document.getElementById('create-name').value.trim();
  const buyIn      = +document.getElementById('s-buyin').value;
  const smallBlind = +document.getElementById('s-sb').value;
  const bigBlind   = +document.getElementById('s-bb').value;
  const ante       = +document.getElementById('s-ante').value;
  if (!name)                              return lobbyErr('Введите имя');
  if (!buyIn || !smallBlind || !bigBlind) return lobbyErr('Заполните все поля');
  if (smallBlind >= bigBlind)             return lobbyErr('Малый блайнд < Большого');
  socket.emit('create-room', { name, settings: { buyIn, smallBlind, bigBlind, ante } });
}

function joinRoom() {
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name) return lobbyErr('Введите имя');
  if (!code) return lobbyErr('Введите код комнаты');
  socket.emit('join-room', { name, roomId: code });
}

function startGame() { socket.emit('start-game'); }

function lobbyErr(msg) {
  const el = document.getElementById('lobby-error');
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 3000);
}

// ═══════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════
socket.on('joined', ({ roomId }) => {
  myId = socket.id;  // socket.io client exposes socket.id after connection
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').classList.add('active');
  document.getElementById('hdr-room').textContent     = 'ROOM: ' + roomId;
  document.getElementById('ov-room-code').textContent = roomId;
  document.getElementById('waiting-overlay').style.display = 'flex';
});

socket.on('state', state => {
  if (state.myId) myId = state.myId;
  gameState = state; renderGame(state);
});

socket.on('peer-joined', async ({ peerId }) => {
  const pc = getPC(peerId);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { to: peerId, sdp: offer });
});

socket.on('peer-left', ({ peerId }) => {
  peers[peerId]?.close(); delete peers[peerId];
});

socket.on('offer', async ({ from, sdp }) => {
  const pc = getPC(from);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, sdp: answer });
});

socket.on('answer', async ({ from, sdp }) => {
  if (peers[from]) await peers[from].setRemoteDescription(sdp);
});

socket.on('ice', async ({ from, candidate }) => {
  try { if (peers[from]) await peers[from].addIceCandidate(candidate); } catch(e) {}
});

socket.on('chat', ({ name, msg }) => {
  const box = document.getElementById('chat-messages');
  const d = document.createElement('div');
  d.className = 'chat-msg';
  d.innerHTML = `<span class="cn">${esc(name)}:</span> <span class="ct">${esc(msg)}</span>`;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
});

socket.on('err', showToast);

// ═══════════════════════════════════════════
//  WEBRTC
// ═══════════════════════════════════════════
function getPC(peerId) {
  if (peers[peerId]) return peers[peerId];
  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[peerId] = pc;
  pc.onicecandidate = e => { if (e.candidate) socket.emit('ice', { to: peerId, candidate: e.candidate }); };
  pc.ontrack = e => {
    pc._stream = e.streams[0];
    showVideoInSeat(peerId, e.streams[0], false);
  };
  return pc;
}

// Show a media stream inside the seat-video-wrap of a seat
function showVideoInSeat(pid, stream, muted) {
  const wrap = document.querySelector(`.seat[data-pid="${pid}"] .seat-video-wrap`);
  if (!wrap) return;
  let vid = wrap.querySelector('video.seat-video');
  if (!vid) {
    vid = document.createElement('video');
    vid.className = 'seat-video';
    vid.autoplay = true; vid.playsinline = true;
    wrap.appendChild(vid);
  }
  vid.muted = muted;
  if (vid.srcObject !== stream) vid.srcObject = stream;
  vid.style.display = 'block';
  // hide avatar when video active
  const av = wrap.querySelector('.seat-avatar');
  if (av) av.style.display = 'none';
}

async function toggleCamera() {
  const btn = document.getElementById('cam-btn');
  if (!cameraOn) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      cameraOn = true;
      btn.textContent = '📷 ВКЛ';
      btn.style.color = '#4caf50';
      showVideoInSeat(myId, localStream, true);
      // add tracks to existing connections
      for (const pid in peers) {
        localStream.getTracks().forEach(t => { try { peers[pid].addTrack(t, localStream); } catch(e) {} });
      }
    } catch(e) { showToast('Нет доступа к камере'); }
  } else {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null; cameraOn = false;
    btn.textContent = '📷 Камера'; btn.style.color = '';
    // restore avatar
    const wrap = document.querySelector(`.seat[data-pid="${myId}"] .seat-video-wrap`);
    if (wrap) {
      const vid = wrap.querySelector('video'); if (vid) vid.style.display = 'none';
      const av  = wrap.querySelector('.seat-avatar'); if (av) av.style.display = '';
    }
  }
}

// ═══════════════════════════════════════════
//  RENDER GAME
// ═══════════════════════════════════════════
// 10 seat positions as % of #table-area (860×480px), clockwise from bottom center
const SEAT_POS = [
  { x:50,   y:88   }, { x:75.3, y:80.7 }, { x:90.9, y:61.7 },
  { x:90.9, y:38.3 }, { x:75.3, y:19.3 }, { x:50,   y:12   },
  { x:24.7, y:19.3 }, { x:9.1,  y:38.3 }, { x:9.1,  y:61.7 },
  { x:24.7, y:80.7 },
];

function renderGame(state) {
  const waiting = state.phase === 'waiting';
  document.getElementById('waiting-overlay').style.display = waiting ? 'flex' : 'none';

  if (waiting) {
    const me = state.players.find(p => p.id === myId);
    document.getElementById('ov-players').innerHTML = state.players.map(p =>
      `<div class="ov-player-chip${p.isHost?' host':''}">${esc(p.name)}</div>`
    ).join('');
    show('ov-start-btn',    !!me?.isHost);
    show('ov-waiting-msg',  !me?.isHost);
    return;
  }

  // derive currentPlayerId from index
  state.currentPlayerId = state.players[state.currentIdx]?.id ?? null;

  const PHASE = { preflop:'Префлоп', flop:'Флоп', turn:'Тёрн', river:'Ривер', showdown:'Шоудаун' };
  document.getElementById('hdr-phase').textContent = PHASE[state.phase] || state.phase;
  document.getElementById('hdr-hand').textContent  = 'Раздача #' + state.handNum;
  document.getElementById('pot-amount').textContent = state.pot;
  document.getElementById('community-cards').innerHTML =
    (state.community || []).map(c => cardHtml(c)).join('');

  renderSeats(state);

  const me = state.players.find(p => p.id === myId);
  document.getElementById('my-cards').innerHTML =
    (me?.inHand && !me.folded && me.cards)
      ? me.cards.map(c => cardHtml(c, false, 'large')).join('') : '';
  document.getElementById('my-hand-name').textContent = me?.handName || '';
  document.getElementById('my-chips').textContent     = me?.chips ?? '';

  renderActions(state, me);

  if (state.phase === 'showdown') renderShowdown(state);
  else document.getElementById('showdown-overlay').style.display = 'none';
}

// ─── Seats ────────────────────────────────
function renderSeats(state) {
  const layer = document.getElementById('seats-layer');
  layer.innerHTML = '';

  const meIdx   = state.players.findIndex(p => p.id === myId);
  const ordered = meIdx < 0 ? state.players
    : [...state.players.slice(meIdx), ...state.players.slice(0, meIdx)];

  ordered.forEach((player, idx) => {
    if (idx >= SEAT_POS.length) return;
    const pos = SEAT_POS[idx];
    const isMe     = player.id === myId;
    const isActive = state.currentPlayerId === player.id;

    // ── seat element ──
    const seat = document.createElement('div');
    seat.className = 'seat'
      + (isMe          ? ' is-me'       : '')
      + (isActive      ? ' active-turn' : '')
      + (player.folded ? ' folded'      : '')
      + (player.winner ? ' winner'      : '');
    seat.dataset.pid = player.id;
    seat.style.left  = pos.x + '%';
    seat.style.top   = pos.y + '%';

    // avatar url as background
    const av = `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(player.name)}`;

    seat.innerHTML = `
      <div class="seat-video-wrap">
        <div class="seat-avatar" style="background-image:url('${av}');background-size:cover;background-position:center;"></div>
      </div>
      <div class="seat-name">${esc(player.name)}${player.isHost ? ' 👑' : ''}</div>
      <div class="seat-chips">${player.chips}</div>
      ${player.blindLabel ? `<div class="seat-blind">${player.blindLabel}</div>` : ''}
      ${player.allIn      ? `<div class="seat-allin">ALL IN</div>`               : ''}
      <div class="seat-cards">${seatCards(player, isMe || state.phase === 'showdown')}</div>
    `;
    layer.appendChild(seat);

    // ── bet chip (absolutely positioned between seat and center) ──
    if (player.bet > 0) {
      const chip = document.createElement('div');
      chip.className = 'seat-bet-chip';
      const bx = pos.x + (50 - pos.x) * 0.42;
      const by = pos.y + (50 - pos.y) * 0.42;
      chip.style.left = bx + '%';
      chip.style.top  = by + '%';
      chip.textContent = player.bet;
      layer.appendChild(chip);
    }

    // ── restore live video streams after re-render ──
    if (isMe && localStream)             showVideoInSeat(myId,      localStream,            true);
    else if (peers[player.id]?._stream)  showVideoInSeat(player.id, peers[player.id]._stream, false);
  });
}

function seatCards(player, reveal) {
  const back = '<div class="card face-down"></div>';
  if (!player.inHand) return '';
  if (player.folded)  return back + back;
  if (!reveal || !player.cards || player.cards.every(c => !c)) return back + back;
  return player.cards.map(c => cardHtml(c)).join('');
}

// ─── Action Bar ───────────────────────────
function renderActions(state, me) {
  const myTurn = !!(me && state.currentPlayerId === myId && !me.folded && !me.allIn);
  document.getElementById('action-bar').classList.toggle('my-turn', myTurn);

  show('btn-fold',    myTurn);
  show('btn-check',   myTurn && me.bet >= state.currentBet);
  show('btn-call',    myTurn && me.bet <  state.currentBet);
  show('raise-group', myTurn && me.chips > 0);
  show('btn-allin',   myTurn);

  if (!myTurn) return;

  const callAmt  = Math.min(state.currentBet - me.bet, me.chips);
  document.getElementById('btn-call').textContent = `Колл ${callAmt}`;

  const bb       = state.settings?.bigBlind || 20;
  const minRaise = Math.min(state.currentBet + (state.lastRaise || bb), me.chips + me.bet);
  const maxRaise = me.chips + me.bet;
  if (!raiseTarget || raiseTarget < minRaise) raiseTarget = minRaise;
  if (raiseTarget > maxRaise) raiseTarget = maxRaise;

  const sl = document.getElementById('raise-slider');
  sl.min = minRaise; sl.max = maxRaise; sl.step = bb; sl.value = raiseTarget;
  document.getElementById('raise-amount-display').textContent = raiseTarget;
}

function onSlider() {
  raiseTarget = +document.getElementById('raise-slider').value;
  document.getElementById('raise-amount-display').textContent = raiseTarget;
}

function sendAction(action) {
  socket.emit('action', action === 'raise' ? { action, amount: raiseTarget } : { action });
}

// ─── Showdown Overlay ─────────────────────
function renderShowdown(state) {
  const ov      = document.getElementById('showdown-overlay');
  const result  = state.showdown;  // { winners:[{id,name,handName}], allHands:[...] }
  const winners = result?.winners || state.players.filter(p => p.winner);

  // pot already distributed, grab from winner chip delta via result
  const winNames = winners.map(w => esc(w.name)).join(' и ');
  document.getElementById('sd-title').textContent = winNames
    ? `🏆 ${winNames} побеждает!`
    : 'Итоги раздачи';

  // show all hands that stayed in
  const hands = result?.allHands?.length
    ? result.allHands
    : state.players.filter(p => p.inHand && !p.folded && p.cards?.length);

  const winnerIds = new Set(winners.map(w => w.id));
  document.getElementById('sd-content').innerHTML = hands
    .map(p => `
      <div class="sd-hand-row${winnerIds.has(p.id) ? ' sd-winner' : ''}">
        <span class="sd-name">${esc(p.name)}</span>
        <div class="sd-cards">${(p.cards || []).map(c => cardHtml(c)).join('')}</div>
        <span class="sd-hand-type">${p.handName || ''}</span>
      </div>`).join('');

  ov.style.display = 'flex';

  // countdown bar
  const fill = document.getElementById('sd-timer-fill');
  fill.style.transition = 'none'; fill.style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fill.style.transition = 'width 7s linear'; fill.style.width = '0%';
  }));
}

// ─── Chat ─────────────────────────────────
function sendChat() {
  const inp = document.getElementById('chat-input');
  const msg = inp.value.trim(); if (!msg) return;
  socket.emit('chat', { msg }); inp.value = '';
}

// ═══════════════════════════════════════════
//  CARD HTML
// ═══════════════════════════════════════════
function cardHtml(card, hidden = false, size = '') {
  const cls = size ? ' ' + size : '';
  if (!card || hidden) return `<div class="card face-down${cls}"></div>`;
  const rm    = { 11:'J', 12:'Q', 13:'K', 14:'A' };
  const suits = { s:'♠', h:'♥', d:'♦', c:'♣' };
  const rank  = rm[card.r] || card.r;
  const red   = card.s === 'h' || card.s === 'd';
  return `<div class="card face-up${red ? ' red' : ''}${cls}">
    <span class="cr">${rank}</span><span class="cs">${suits[card.s]}</span>
  </div>`;
}

// ═══════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════
function show(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? '' : 'none';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.display = 'none'; }, 3500);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
