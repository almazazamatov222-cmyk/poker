const socket = io();
let gameState=null, myId=null, localStream=null;
let peers={}, raiseTarget=0, raiseMin=0, raiseMax=0, cameraOn=false;
let handHistory=[], bannerTimer=null, raisePanelOpen=false;

const ICE={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};

// ─── Seat positions (% of #arena w/h), 10 seats around oval ─────────────────
const SEATS=[
  {x:50,   y:86},   // 0 me — bottom center
  {x:70,   y:80},   // 1
  {x:86,   y:67},   // 2
  {x:90,   y:50},   // 3
  {x:86,   y:33},   // 4
  {x:70,   y:20},   // 5
  {x:50,   y:14},   // 6
  {x:30,   y:20},   // 7
  {x:14,   y:33},   // 8
  {x:10,   y:50},   // 9
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
function lerr(m){ el('lobby-error').textContent=m; setTimeout(()=>el('lobby-error').textContent='',3e3); }

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
  playSfx(state,prev);
  render(state);
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
socket.on('answer',async({from,sdp})=>{ try{if(peers[from])await peers[from].setRemoteDescription(new RTCSessionDescription(sdp));}catch(e){} });
socket.on('ice',async({from,candidate})=>{ try{if(peers[from])await peers[from].addIceCandidate(new RTCIceCandidate(candidate));}catch(e){} });
socket.on('err',toast);

// ═══ SFX ═══
function playSfx(s,prev){
  if(!prev) return;
  if(prev.phase==='waiting'&&s.phase==='preflop'){ SFX.shuffle(); return; }
  const myT=s.players[s.currentIdx]?.id===myId, wasT=prev.players?.[prev.currentIdx]?.id===myId;
  if(myT&&!wasT) SFX.yourTurn();
  const nc=(s.community||[]).length-(prev.community||[]).length;
  if(nc>0&&s.phase!=='showdown') for(let i=0;i<nc;i++) setTimeout(()=>SFX.deal(),i*150+80);
  if(s.phase==='showdown'&&prev.phase!=='showdown') setTimeout(()=>SFX.win(),350);
}

// ═══ WEBRTC ═══
function mkPC(pid){
  if(peers[pid]) return peers[pid];
  const pc=new RTCPeerConnection(ICE); peers[pid]=pc;
  pc.onicecandidate=e=>{ if(e.candidate) socket.emit('ice',{to:pid,candidate:e.candidate}); };
  pc.onnegotiationneeded=async()=>{
    try{const o=await pc.createOffer();await pc.setLocalDescription(o);socket.emit('offer',{to:pid,sdp:o});}catch(e){}
  };
  pc.ontrack=e=>{ pc._stream=e.streams[0]; attachVid(pid,e.streams[0],false); };
  pc.onconnectionstatechange=()=>{ if(['failed','closed'].includes(pc.connectionState)){pc.close();delete peers[pid];} };
  return pc;
}
function attachVid(pid,stream,muted){
  const av=document.querySelector(`.seat[data-pid="${pid}"] .seat-av`); if(!av) return;
  let vid=av.querySelector('video.seat-vid');
  if(!vid){
    vid=document.createElement('video'); vid.className='seat-vid';
    vid.autoplay=true; vid.playsinline=true; av.appendChild(vid);
  }
  vid.muted=muted; if(vid.srcObject!==stream) vid.srcObject=stream;
  vid.style.display='block';
  const ini=av.querySelector('.seat-initials'); if(ini) ini.style.display='none';
}
async function toggleCamera(){
  const btn=el('cam-btn');
  if(!cameraOn){
    try{
      localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
      cameraOn=true; btn.textContent='📷 ВКЛ'; btn.style.color='#4caf50';
      attachVid(myId,localStream,true);
      for(const pid in peers) localStream.getTracks().forEach(t=>{ try{peers[pid].addTrack(t,localStream);}catch(e){} });
    }catch(e){ toast('Нет доступа к камере'); }
  } else {
    localStream.getTracks().forEach(t=>t.stop());
    localStream=null; cameraOn=false; btn.textContent='📷 Камера'; btn.style.color='';
    const av=document.querySelector(`.seat[data-pid="${myId}"] .seat-av`);
    if(av){
      const vid=av.querySelector('video'); if(vid) vid.style.display='none';
      const ini=av.querySelector('.seat-initials'); if(ini) ini.style.display='';
    }
  }
}

// ═══ RENDER ═══
const PAL=['#c0392b','#2980b9','#27ae60','#c49a06','#8e44ad','#16a085','#e67e22','#1a5276','#d35400','#117a65'];
function abg(n){ return PAL[(n.charCodeAt(0)+(n.charCodeAt(1)||0))%PAL.length]; }

function render(s){
  if(s.phase==='waiting'){
    el('waiting-overlay').style.display='flex';
    const me=s.players.find(p=>p.id===myId);
    el('ov-players').innerHTML=s.players.map(p=>
      `<div class="opc${p.isHost?' host':''}">${esc(p.name)}</div>`).join('');
    sh('ov-start',!!me?.isHost); sh('ov-wait-msg',!me?.isHost);
    return;
  }
  el('waiting-overlay').style.display='none';
  s.curId=s.players[s.currentIdx]?.id??null;

  const PH={preflop:'Префлоп',flop:'Флоп',turn:'Тёрн',river:'Ривер',showdown:'Шоудаун'};
  el('hdr-phase').textContent=PH[s.phase]||s.phase;
  el('hdr-hand').textContent='Раздача #'+s.handNum;
  el('pot-amount').textContent=s.pot;
  el('community-cards').innerHTML=(s.community||[]).map(c=>cd(c)).join('');

  renderSeats(s);

  const me=s.players.find(p=>p.id===myId);
  // My hole cards — shown on table
  el('my-cards').innerHTML=(me?.inHand&&!me.folded&&me.cards)?me.cards.map(c=>cd(c,false,'large')).join(''):'';
  el('my-combo').textContent=me?.handName||'';
  el('my-chips').textContent=me?.chips??'';
  renderActions(s,me);

  // Banner
  if(s.phase==='showdown'){
    if(el('winner-banner').style.display!=='flex'){ showBanner(s); animChips(s); }
  } else {
    clearTimeout(bannerTimer); el('winner-banner').style.display='none';
  }
}

// ─── Seats ───────────────────────────────────────────────────────────────────
function renderSeats(s){
  const layer=el('seats');
  const mi=s.players.findIndex(p=>p.id===myId);
  const ord=mi<0?s.players:[...s.players.slice(mi),...s.players.slice(0,mi)];

  // Remove bet chips
  layer.querySelectorAll('.bet-chip').forEach(c=>c.remove());

  ord.forEach((p,idx)=>{
    if(idx>=SEATS.length) return;
    const pos=SEATS[idx];
    const isMe=p.id===myId, isAct=s.curId===p.id;

    let seat=layer.querySelector(`.seat[data-pid="${p.id}"]`);
    const isNew=!seat;
    if(isNew){
      seat=document.createElement('div'); seat.className='seat'; seat.dataset.pid=p.id;
      seat.innerHTML=`
        <div class="seat-av">
          <div class="seat-initials" style="background:${abg(p.name)}">${esc(p.name.slice(0,2).toUpperCase())}</div>
        </div>
        <div class="seat-badges"></div>
        <div class="seat-cards"></div>
        <div class="seat-label">
          <div class="seat-name"></div>
          <div class="seat-chips"><span class="sdot"></span><span class="cv"></span></div>
          <div class="seat-action"></div>
          <div class="seat-combo"></div>
        </div>`;
      layer.appendChild(seat);
    }

    // Classes
    seat.className='seat'+(isMe?' is-me':'')+(isAct?' active':'')
      +(p.folded?' folded':'')+(p.winner?' winner':'');
    seat.style.left=pos.x+'%'; seat.style.top=pos.y+'%';

    // Info
    seat.querySelector('.seat-name').textContent=p.name+(p.isHost?' 👑':'');
    seat.querySelector('.cv').textContent=p.chips;
    seat.querySelector('.seat-action').textContent=actionLabel(p,s);
    seat.querySelector('.seat-combo').textContent=(p.handName&&p.inHand&&!p.folded)?p.handName:'';

    // Badges
    const badges=seat.querySelector('.seat-badges');
    badges.innerHTML=[
      p.blindLabel?.includes('Д')&&p.blindLabel?.length===1 ? `<span class="badge badge-d">Д</span>` : '',
      p.blindLabel?.includes('МБ') ? `<span class="badge badge-mb">МБ</span>` : '',
      p.blindLabel?.includes('ББ') ? `<span class="badge badge-bb">ББ</span>` : '',
      p.blindLabel?.includes('Д')&&p.blindLabel?.length>1 ? `<span class="badge badge-d">Д</span>` : '',
      p.allIn ? `<span class="badge badge-allin">ALL IN</span>` : '',
    ].join('');

    // Opponent cards — shown ABOVE avatar (away from table center for bottom seats, toward center for top)
    const cardsDiv=seat.querySelector('.seat-cards');
    cardsDiv.innerHTML=seatCards(p,isMe||s.phase==='showdown');
    // Position cards: offset toward table center
    const cx=50, cy=50;
    const ang=Math.atan2(cy-pos.y, cx-pos.x);
    const dist=36;
    cardsDiv.style.position='absolute';
    cardsDiv.style.left=(Math.cos(ang)*dist)+'px';
    cardsDiv.style.top=(Math.sin(ang)*dist)+'px';
    cardsDiv.style.transform='translate(-50%,-50%)';

    // Restore video
    if(isMe&&localStream) attachVid(myId,localStream,true);
    else if(peers[p.id]?._stream) attachVid(p.id,peers[p.id]._stream,false);

    // Bet chip
    if(p.bet>0){
      const bc=document.createElement('div'); bc.className='bet-chip';
      const bx=pos.x+(50-pos.x)*0.4, by=pos.y+(50-pos.y)*0.4;
      bc.style.left=bx+'%'; bc.style.top=by+'%'; bc.textContent=p.bet;
      layer.appendChild(bc);
    }
  });

  // Remove seats no longer in game
  layer.querySelectorAll('.seat').forEach(seat=>{
    if(!ord.find(p=>p.id===seat.dataset.pid)) seat.remove();
  });
}

function actionLabel(p,s){
  if(!p.inHand) return '';
  if(p.folded) return 'Фолд';
  if(p.allIn) return 'All In';
  if(s.curId===p.id) return '⏳ Ход...';
  if(p.bet>0) return p.bet+'';
  return '';
}

function seatCards(p,reveal){
  const b='<div class="card face-down"></div>';
  if(!p.inHand) return '';
  if(p.folded) return b+b;
  if(!reveal||!p.cards||p.cards.every(c=>!c)) return b+b;
  return p.cards.map(c=>cd(c)).join('');
}

// ─── Actions ─────────────────────────────────────────────────────────────────
function renderActions(s,me){
  const myT=!!(me&&s.curId===myId&&!me.folded&&!me.allIn);
  el('actionbar').classList.toggle('my-turn',myT);

  sBtn('btn-fold',     myT);
  sBtn('btn-check',    myT&&me.bet>=s.currentBet);
  sBtn('btn-call',     myT&&me.bet<s.currentBet);
  sBtn('btn-allin',    myT);

  // Raise button: show if player has more chips than needed to call
  const callAmt=Math.min(s.currentBet-me.bet, me.chips);
  const canRaise=myT&&me.chips>callAmt;
  sBtn('btn-raise-open', canRaise);

  if(!myT){
    closeRaise();
    return;
  }

  if(me.bet<s.currentBet){
    el('btn-call').textContent=`КОЛЛ ${callAmt}`;
  }

  // Compute raise range
  const bb=s.settings?.bigBlind||20;
  raiseMin=Math.min(s.currentBet+(s.lastRaise||bb), me.chips+me.bet);
  raiseMax=me.chips+me.bet;
  if(raiseTarget<raiseMin) raiseTarget=raiseMin;
  if(raiseTarget>raiseMax) raiseTarget=raiseMax;

  const sl=el('raise-slider');
  sl.min=raiseMin; sl.max=raiseMax; sl.step=bb; sl.value=raiseTarget;
  sl.dataset.pot=s.pot;
  el('rp-amount').textContent=raiseTarget;
}

function toggleRaisePanel(){
  raisePanelOpen=!raisePanelOpen;
  el('raise-panel').classList.toggle('open',raisePanelOpen);
  el('btn-raise-open').textContent=raisePanelOpen?'РЕЙЗ ▼':'РЕЙЗ ▲';
}
function closeRaise(){
  raisePanelOpen=false;
  el('raise-panel').classList.remove('open');
  el('btn-raise-open').textContent='РЕЙЗ ▲';
}

function setR(v){
  const sl=el('raise-slider');
  const pot=+(sl.dataset.pot||0);
  if(v==='min') raiseTarget=raiseMin;
  else if(v==='allin') raiseTarget=raiseMax;
  else raiseTarget=Math.max(raiseMin,Math.min(raiseMax,Math.round(pot*v)));
  sl.value=raiseTarget; el('rp-amount').textContent=raiseTarget;
}
function sliderR(){ raiseTarget=+el('raise-slider').value; el('rp-amount').textContent=raiseTarget; }
function nudgeR(d){
  const bb=gameState?.settings?.bigBlind||20;
  raiseTarget=Math.max(raiseMin,Math.min(raiseMax,raiseTarget+d*bb));
  el('raise-slider').value=raiseTarget; el('rp-amount').textContent=raiseTarget;
}
function doRaise(){
  SFX.chip();
  socket.emit('action',{action:'raise',amount:raiseTarget});
  closeRaise();
}
function sendAction(a){
  if(a==='fold') SFX.fold(); else if(a==='check') SFX.check();
  else if(a==='allin') SFX.allin(); else SFX.chip();
  socket.emit('action',{action:a});
  closeRaise();
}

// ─── Banner + chips ───────────────────────────────────────────────────────────
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
  const layer=el('chip-layer'); layer.innerHTML='';
  const mi=s.players.findIndex(p=>p.id===myId);
  const ord=mi<0?s.players:[...s.players.slice(mi),...s.players.slice(0,mi)];
  const wi=ord.findIndex(p=>p.id===w[0].id); if(wi<0||wi>=SEATS.length) return;
  const wp=SEATS[wi], arena=el('arena'), r=arena.getBoundingClientRect();
  const tx=(wp.x/100)*r.width, ty=(wp.y/100)*r.height;
  const cnt=Math.min(18,Math.max(4,Math.ceil(s.pot/80)));
  SFX.chipSlide();
  for(let i=0;i<cnt;i++) setTimeout(()=>{
    const c=document.createElement('div'); c.className='flying-chip';
    const sx=r.width/2+Math.random()*80-40, sy=r.height/2+Math.random()*40-20;
    c.style.left=sx+'px'; c.style.top=sy+'px'; layer.appendChild(c);
    requestAnimationFrame(()=>{ c.style.transform=`translate(${tx-sx}px,${ty-sy}px)`; c.style.opacity='0'; });
    setTimeout(()=>c.remove(),650);
  },i*40);
}

// ─── History ──────────────────────────────────────────────────────────────────
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
  const list=el('hist-list'); if(!list) return;
  list.innerHTML=handHistory.map(h=>`
    <div class="he${h.won?' won':''}">
      <div class="he-hdr"><span class="he-n">Раздача #${h.handNum}</span>
        <span class="${h.won?'hw':'hl'}">${h.won?'✓ ПОБЕДА':'✗'}</span></div>
      <div class="he-r"><span class="he-lbl">Рука:</span>${h.myCards.map(c=>cd(c,false,'small')).join('')}${h.myHand?`<span class="he-hn">${h.myHand}</span>`:''}</div>
      ${h.community.length?`<div class="he-r"><span class="he-lbl">Борд:</span>${h.community.map(c=>cd(c,false,'small')).join('')}</div>`:''}
      <div class="he-pp">${h.players.filter(p=>p.cards?.length).map(p=>`
        <span class="he-p">${esc(p.name)}: ${p.cards.map(c=>cd(c,false,'small')).join('')}${p.handName?` <em>${esc(p.handName)}</em>`:''}</span>`).join('')}</div>
      <div class="he-ft">🏆 ${h.winners.map(esc).join(', ')} · Банк: ${h.pot}</div>
    </div>`).join('');
}
function toggleHistory(){ const p=el('history-panel'); p.style.display=p.style.display==='none'?'flex':'none'; }

// ─── Cards ────────────────────────────────────────────────────────────────────
function cd(card,hidden=false,size=''){
  const cls=size?' '+size:'';
  if(!card||hidden) return `<div class="card face-down${cls}"></div>`;
  const rm={11:'J',12:'Q',13:'K',14:'A'},suits={s:'♠',h:'♥',d:'♦',c:'♣'};
  const red=card.s==='h'||card.s==='d';
  return `<div class="card face-up${red?' red':''}${cls}"><span class="cr">${rm[card.r]||card.r}</span><span class="cs">${suits[card.s]}</span></div>`;
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function el(id){ return document.getElementById(id); }
function v(id){ return (el(id)?.value||'').trim(); }
function sh(id,vis){ const e=el(id); if(e) e.style.display=vis?'':'none'; }
function sBtn(id,vis){ const e=el(id); if(e) e.style.display=vis?'inline-flex':'none'; }
function toast(msg){ const t=el('toast'); t.textContent=msg; t.style.display='block';
  clearTimeout(t._t); t._t=setTimeout(()=>{ t.style.display='none'; },3500); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
