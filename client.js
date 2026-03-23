const socket = io();
let gameState=null, myId=null, localStream=null;
let peers={}, raiseTarget=0, cameraOn=false;
let handHistory=[], bannerTimer=null;

const ICE={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};

// ─── Seat positions: % of #game-main (viewport minus header/bar) ───────────
// Layout: 10 seats arranged as an ellipse around the table
// Positions are % of container width/height
const SEATS = [
  // Bottom row (closest to action bar)
  {x:50,   y:88},   // 0 = me (center bottom)
  {x:71,   y:83},   // 1 right of me
  {x:88,   y:72},   // 2 far right
  {x:92,   y:55},   // 3 right middle
  {x:88,   y:35},   // 4 upper right
  {x:70,   y:18},   // 5 top right
  {x:50,   y:12},   // 6 top center
  {x:30,   y:18},   // 7 top left
  {x:12,   y:35},   // 8 upper left
  {x:8,    y:55},   // 9 left middle
  // {x:12, y:72},  // if >10 needed
];

// ═══ LOBBY ═══
function switchTab(t){
  ['create','join'].forEach(n=>{
    el('tab-'+n+'-btn').classList.toggle('active',n===t);
    el('tab-'+n).classList.toggle('active',n===t);
  });
}
function createRoom(){
  const name=v('create-name'),buyIn=+v('s-buyin'),sb=+v('s-sb'),bb=+v('s-bb'),ante=+v('s-ante');
  if(!name) return lerr('Введите имя');
  if(!buyIn||!sb||!bb) return lerr('Заполните все поля');
  if(sb>=bb) return lerr('МБ должен быть меньше ББ');
  socket.emit('create-room',{name,settings:{buyIn,smallBlind:sb,bigBlind:bb,ante}});
}
function joinRoom(){
  const name=v('join-name'),code=v('join-code').toUpperCase();
  if(!name) return lerr('Введите имя'); if(!code) return lerr('Введите код');
  socket.emit('join-room',{name,roomId:code});
}
function startGame(){ socket.emit('start-game'); }
function leaveTable(){ socket.disconnect(); location.reload(); }
function lerr(m){ el('lobby-error').textContent=m; setTimeout(()=>el('lobby-error').textContent='',3000); }

// ═══ SOCKETS ═══
socket.on('joined',({roomId})=>{
  myId=socket.id;
  el('lobby').style.display='none';
  el('game').classList.add('active');
  el('hdr-room').textContent='ROOM: '+roomId;
  el('ov-room-code').textContent=roomId;
  el('waiting-overlay').style.display='flex';
});
socket.on('state',state=>{
  if(state.myId) myId=state.myId;
  const prev=gameState; gameState=state;
  sfx(state,prev);
  renderGame(state);
  if(state.phase==='showdown'&&prev?.phase!=='showdown') saveHist(state);
});
socket.on('peer-joined',async({peerId})=>{
  const pc=mkPC(peerId);
  if(localStream) localStream.getTracks().forEach(t=>{ try{pc.addTrack(t,localStream);}catch(e){} });
  try{const o=await pc.createOffer();await pc.setLocalDescription(o);socket.emit('offer',{to:peerId,sdp:o});}catch(e){}
});
socket.on('peer-left',({peerId})=>{ peers[peerId]?.close(); delete peers[peerId]; });
socket.on('offer',async({from,sdp})=>{
  const pc=mkPC(from);
  if(localStream) localStream.getTracks().forEach(t=>{ try{pc.addTrack(t,localStream);}catch(e){} });
  try{
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const a=await pc.createAnswer(); await pc.setLocalDescription(a);
    socket.emit('answer',{to:from,sdp:a});
  }catch(e){}
});
socket.on('answer',async({from,sdp})=>{
  try{ if(peers[from]) await peers[from].setRemoteDescription(new RTCSessionDescription(sdp)); }catch(e){}
});
socket.on('ice',async({from,candidate})=>{
  try{ if(peers[from]) await peers[from].addIceCandidate(new RTCIceCandidate(candidate)); }catch(e){}
});
socket.on('chat',({name,msg})=>{
  // No chat panel in this layout — show as toast briefly or skip
});
socket.on('err',toast);

// ═══ SOUNDS ═══
function sfx(s,prev){
  if(!prev) return;
  if(prev.phase==='waiting'&&s.phase==='preflop'){ SFX.shuffle(); return; }
  const myT=s.players[s.currentIdx]?.id===myId, wasT=prev.players?.[prev.currentIdx]?.id===myId;
  if(myT&&!wasT) SFX.yourTurn();
  const nc=(s.community||[]).length-(prev.community||[]).length;
  if(nc>0&&s.phase!=='showdown') for(let i=0;i<nc;i++) setTimeout(()=>SFX.deal(),i*150+80);
  if(s.phase==='showdown'&&prev.phase!=='showdown') setTimeout(()=>SFX.win(),400);
}

// ═══ WEBRTC ═══
function mkPC(pid){
  if(peers[pid]) return peers[pid];
  const pc=new RTCPeerConnection(ICE); peers[pid]=pc;
  pc.onicecandidate=e=>{ if(e.candidate) socket.emit('ice',{to:pid,candidate:e.candidate}); };
  pc.onnegotiationneeded=async()=>{
    try{const o=await pc.createOffer();await pc.setLocalDescription(o);socket.emit('offer',{to:pid,sdp:o});}catch(e){}
  };
  pc.ontrack=e=>{ pc._stream=e.streams[0]; showVid(pid,e.streams[0],false); };
  pc.onconnectionstatechange=()=>{
    if(['failed','closed'].includes(pc.connectionState)){ pc.close(); delete peers[pid]; }
  };
  return pc;
}

function showVid(pid,stream,muted){
  const tile=document.querySelector(`.ptile[data-pid="${pid}"]`); if(!tile) return;
  const box=tile.querySelector('.ptile-video'); if(!box) return;
  let vid=box.querySelector('video.ptile-vid');
  if(!vid){
    vid=document.createElement('video'); vid.className='ptile-vid';
    vid.autoplay=true; vid.playsinline=true; box.appendChild(vid);
  }
  vid.muted=muted; if(vid.srcObject!==stream) vid.srcObject=stream;
  vid.style.display='block';
  const av=box.querySelector('.ptile-avatar'); if(av) av.style.display='none';
}

async function toggleCamera(){
  const btn=el('cam-btn');
  if(!cameraOn){
    try{
      localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
      cameraOn=true; btn.textContent='📷 ВКЛ'; btn.style.color='#4caf50';
      showVid(myId,localStream,true);
      // Offer to all existing peers
      for(const pid in peers){
        localStream.getTracks().forEach(t=>{ try{peers[pid].addTrack(t,localStream);}catch(e){} });
        // onnegotiationneeded will fire and send offer automatically
      }
    }catch(e){ toast('Нет доступа к камере'); }
  } else {
    localStream.getTracks().forEach(t=>t.stop());
    localStream=null; cameraOn=false; btn.textContent='📷 Камера'; btn.style.color='';
    const tile=document.querySelector(`.ptile[data-pid="${myId}"]`);
    if(tile){
      const vid=tile.querySelector('video.ptile-vid'); if(vid) vid.style.display='none';
      const av=tile.querySelector('.ptile-avatar'); if(av) av.style.display='';
    }
  }
}

// ═══ RENDER ═══
function renderGame(s){
  if(s.phase==='waiting'){
    el('waiting-overlay').style.display='flex';
    const me=s.players.find(p=>p.id===myId);
    el('ov-players').innerHTML=s.players.map(p=>
      `<div class="ov-player-chip${p.isHost?' host':''}">${esc(p.name)}</div>`).join('');
    show('ov-start-btn',!!me?.isHost); show('ov-waiting-msg',!me?.isHost);
    return;
  }
  el('waiting-overlay').style.display='none';
  s.curId=s.players[s.currentIdx]?.id??null;

  const PH={preflop:'Префлоп',flop:'Флоп',turn:'Тёрн',river:'Ривер',showdown:'Шоудаун'};
  el('hdr-phase').textContent=PH[s.phase]||s.phase;
  el('hdr-hand').textContent='Раздача #'+s.handNum;
  el('pot-amount').textContent=s.pot;
  el('community-cards').innerHTML=(s.community||[]).map(c=>ch(c)).join('');

  renderTiles(s);

  const me=s.players.find(p=>p.id===myId);
  el('my-hole-cards').innerHTML=(me?.inHand&&!me.folded&&me.cards)?me.cards.map(c=>ch(c,false,'large')).join(''):'';
  el('my-combo-label').textContent=me?.handName||'';
  el('my-chips').textContent=me?.chips??'';
  renderActions(s,me);

  if(s.phase==='showdown'){
    if(el('winner-banner').style.display!=='flex'){ showBanner(s); animChips(s); }
  } else {
    clearTimeout(bannerTimer); el('winner-banner').style.display='none';
  }
}

// ─── Player Tiles ────────────────────────────────────────────────────────────
const PAL=['#c0392b','#2980b9','#27ae60','#c49a06','#8e44ad','#16a085','#e67e22','#1a5276','#d35400','#117a65'];
function abg(name){ return PAL[(name.charCodeAt(0)+(name.charCodeAt(1)||0))%PAL.length]; }

function renderTiles(s){
  const layer=el('players-layer');
  const mi=s.players.findIndex(p=>p.id===myId);
  const ord=mi<0?s.players:[...s.players.slice(mi),...s.players.slice(0,mi)];

  // Remove tiles for players no longer present
  layer.querySelectorAll('.ptile').forEach(t=>{
    if(!ord.find(p=>p.id===t.dataset.pid)) t.remove();
  });
  // Remove orphan bet chips
  layer.querySelectorAll('.bet-chip').forEach(c=>c.remove());

  ord.forEach((p,idx)=>{
    if(idx>=SEATS.length) return;
    const pos=SEATS[idx];
    const isMe=p.id===myId, isAct=s.curId===p.id;

    // Get or create tile
    let tile=layer.querySelector(`.ptile[data-pid="${p.id}"]`);
    if(!tile){
      tile=document.createElement('div');
      tile.className='ptile'; tile.dataset.pid=p.id;
      tile.innerHTML=`
        <div class="ptile-video">
          <div class="ptile-avatar" style="background:${abg(p.name)}">${esc(p.name.slice(0,2).toUpperCase())}</div>
          <div class="ptile-status"></div>
          <div class="ptile-cards"></div>
        </div>
        <div class="ptile-info">
          <div class="ptile-name"></div>
          <div class="ptile-chips"><span class="chip-pip"></span><span class="chips-val"></span></div>
          <div class="ptile-combo"></div>
        </div>`;
      layer.appendChild(tile);
    }

    // Update classes
    tile.className='ptile'+(isMe?' is-me':'')+(isAct?' active-turn':'')
      +(p.folded?' folded':'')+(p.winner?' winner':'');
    tile.style.left=pos.x+'%'; tile.style.top=pos.y+'%';

    // Name & chips
    tile.querySelector('.ptile-name').textContent=p.name+(p.isHost?' 👑':'');
    tile.querySelector('.chips-val').textContent=p.chips;
    tile.querySelector('.ptile-combo').textContent=(p.handName&&p.inHand&&!p.folded)?p.handName:'';

    // Badges
    const badges=tile.querySelector('.ptile-status');
    badges.innerHTML=[
      p.blindLabel?`<span class="badge badge-blind">${p.blindLabel}</span>`:'',
      p.allIn?`<span class="badge badge-allin">ВСЁ</span>`:'',
    ].join('');

    // Cards inside tile
    const cards=tile.querySelector('.ptile-cards');
    const showRev=isMe||s.phase==='showdown';
    cards.innerHTML=tileCards(p,showRev);

    // Restore video
    if(isMe&&localStream) showVid(myId,localStream,true);
    else if(peers[p.id]?._stream) showVid(p.id,peers[p.id]._stream,false);

    // Bet chip
    if(p.bet>0){
      const bc=document.createElement('div'); bc.className='bet-chip';
      const bx=pos.x+(50-pos.x)*0.38, by=pos.y+(50-pos.y)*0.38;
      bc.style.left=bx+'%'; bc.style.top=by+'%'; bc.textContent=p.bet;
      layer.appendChild(bc);
    }
  });
}

function tileCards(p,reveal){
  const b='<div class="card face-down small"></div>';
  if(!p.inHand) return '';
  if(p.folded) return b+b;
  if(!reveal||!p.cards||p.cards.every(c=>!c)) return b+b;
  return p.cards.map(c=>ch(c,false,'small')).join('');
}

// ─── Actions ────────────────────────────────────────────────────────────────
function renderActions(s,me){
  const myT=!!(me&&s.curId===myId&&!me.folded&&!me.allIn);
  el('action-bar').classList.toggle('my-turn',myT);
  sBtn('btn-fold', myT);
  sBtn('btn-check',myT&&me.bet>=s.currentBet);
  sBtn('btn-call', myT&&me.bet<s.currentBet);
  sFlex('raise-group',myT&&me.chips>0);
  sBtn('btn-allin',myT);
  if(!myT) return;
  const call=Math.min(s.currentBet-me.bet,me.chips);
  el('btn-call').textContent=`КОЛЛ ${call}`;
  const bb=s.settings?.bigBlind||20;
  const minR=Math.min(s.currentBet+(s.lastRaise||bb),me.chips+me.bet);
  const maxR=me.chips+me.bet;
  if(!raiseTarget||raiseTarget<minR) raiseTarget=minR;
  if(raiseTarget>maxR) raiseTarget=maxR;
  const sl=el('raise-slider');
  sl.min=minR; sl.max=maxR; sl.step=bb; sl.value=raiseTarget;
  sl.dataset.pot=s.pot; sl.dataset.min=minR; sl.dataset.max=maxR;
  el('raise-val').textContent=raiseTarget;
}
function setRaisePct(p){
  const sl=el('raise-slider'); if(!sl) return;
  const pot=+sl.dataset.pot||0,mn=+sl.dataset.min||0,mx=+sl.dataset.max||0;
  raiseTarget=Math.max(mn,Math.min(mx,Math.round(pot*p)));
  sl.value=raiseTarget; el('raise-val').textContent=raiseTarget;
}
function onSlider(){ raiseTarget=+el('raise-slider').value; el('raise-val').textContent=raiseTarget; }
function sendAction(a){
  if(a==='fold') SFX.fold(); else if(a==='check') SFX.check();
  else if(a==='allin') SFX.allin(); else SFX.chip();
  socket.emit('action',a==='raise'?{action:a,amount:raiseTarget}:{action:a});
}

// ─── Winner banner ───────────────────────────────────────────────────────────
function showBanner(s){
  clearTimeout(bannerTimer);
  const w=s.showdown?.winners||s.players.filter(p=>p.winner); if(!w.length) return;
  const h=w[0]?.handName||'';
  el('winner-text').innerHTML=`🏆 <strong>${esc(w.map(x=>x.name).join(' и '))}</strong> победа${h?' — <em>'+esc(h)+'</em>':''}!`;
  el('winner-banner').style.display='flex';
  bannerTimer=setTimeout(()=>{ el('winner-banner').style.display='none'; },5000);
}
function animChips(s){
  const w=s.showdown?.winners||s.players.filter(p=>p.winner); if(!w.length) return;
  const layer=el('chip-anim-layer'); layer.innerHTML='';
  const mi=s.players.findIndex(p=>p.id===myId);
  const ord=mi<0?s.players:[...s.players.slice(mi),...s.players.slice(0,mi)];
  const wi=ord.findIndex(p=>p.id===w[0].id); if(wi<0||wi>=SEATS.length) return;
  const wp=SEATS[wi], main=el('game-main'), rect=main.getBoundingClientRect();
  const tx=(wp.x/100)*rect.width, ty=(wp.y/100)*rect.height;
  const cnt=Math.min(16,Math.max(4,Math.ceil(s.pot/80)));
  SFX.chipSlide();
  for(let i=0;i<cnt;i++) setTimeout(()=>{
    const c=document.createElement('div'); c.className='flying-chip';
    const sx=rect.width/2+Math.random()*80-40, sy=rect.height/2+Math.random()*40-20;
    c.style.left=sx+'px'; c.style.top=sy+'px'; layer.appendChild(c);
    requestAnimationFrame(()=>{ c.style.transform=`translate(${tx-sx}px,${ty-sy}px)`; c.style.opacity='0'; });
    setTimeout(()=>c.remove(),650);
  },i*40);
}

// ─── History ─────────────────────────────────────────────────────────────────
function saveHist(s){
  const me=s.players.find(p=>p.id===myId); if(!me) return;
  const res=s.showdown, w=res?.winners||s.players.filter(p=>p.winner);
  handHistory.unshift({handNum:s.handNum,myCards:me.cards||[],community:s.community||[],
    myHand:me.handName||'',won:w.some(x=>x.id===myId),winners:w.map(x=>x.name),pot:s.pot,
    players:res?.allHands||s.players.filter(p=>p.inHand).map(p=>({name:p.name,cards:p.cards,handName:p.handName}))});
  if(handHistory.length>50) handHistory.pop();
  rehist();
}
function rehist(){
  const list=el('history-list'); if(!list) return;
  list.innerHTML=handHistory.map(h=>`
    <div class="history-entry${h.won?' h-won':''}">
      <div class="h-header"><span class="h-num">Раздача #${h.handNum}</span>
        <span class="${h.won?'h-win':'h-loss'}">${h.won?'✓ ПОБЕДА':'✗ ПОРАЖЕНИЕ'}</span></div>
      <div class="h-row"><span class="h-lbl">Рука:</span>${h.myCards.map(c=>ch(c,false,'small')).join('')}
        ${h.myHand?`<span class="h-hn">${h.myHand}</span>`:''}</div>
      ${h.community.length?`<div class="h-row"><span class="h-lbl">Борд:</span>${h.community.map(c=>ch(c,false,'small')).join('')}</div>`:''}
      <div class="h-pp">${h.players.filter(p=>p.cards?.length).map(p=>`
        <span class="h-p">${esc(p.name)}: ${p.cards.map(c=>ch(c,false,'small')).join('')}
        ${p.handName?`<em>${esc(p.handName)}</em>`:''}</span>`).join('')}</div>
      <div class="h-ft">🏆 ${h.winners.map(esc).join(', ')} · Банк: ${h.pot}</div>
    </div>`).join('');
}
function toggleHistory(){ const p=el('history-panel'); p.style.display=p.style.display==='none'?'flex':'none'; }

// ─── Card HTML ────────────────────────────────────────────────────────────────
function ch(card,hidden=false,size=''){
  const cls=size?' '+size:'';
  if(!card||hidden) return `<div class="card face-down${cls}"></div>`;
  const rm={11:'J',12:'Q',13:'K',14:'A'}, suits={s:'♠',h:'♥',d:'♦',c:'♣'};
  const red=card.s==='h'||card.s==='d';
  return `<div class="card face-up${red?' red':''}${cls}"><span class="cr">${rm[card.r]||card.r}</span><span class="cs">${suits[card.s]}</span></div>`;
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function el(id){ return document.getElementById(id); }
function v(id){ return (el(id)?.value||'').trim(); }
function show(id,vis){ const e=el(id); if(e) e.style.display=vis?'':'none'; }
function sBtn(id,vis){ const e=el(id); if(e) e.style.display=vis?'inline-flex':'none'; }
function sFlex(id,vis){ const e=el(id); if(e) e.style.display=vis?'flex':'none'; }
function toast(msg){ const t=el('toast'); t.textContent=msg; t.style.display='block';
  clearTimeout(t._t); t._t=setTimeout(()=>{ t.style.display='none'; },3500); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
