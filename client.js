// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const socket = io();
let gameState=null, myId=null, localStream=null;
let peers={}, raiseTarget=0, cameraOn=false;
let handHistory=[], bannerTimer=null;

const ICE = { iceServers:[
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun1.l.google.com:19302'}
]};

const SEAT_POS=[
  {x:50,  y:84  },{x:75.3,y:79  },{x:91,  y:61  },
  {x:91,  y:38  },{x:75.3,y:19.5},{x:50,  y:12  },
  {x:24.7,y:19.5},{x:9,   y:38  },{x:9,   y:61  },
  {x:24.7,y:79  },
];

// ═══ LOBBY ═══
function switchTab(tab){
  ['create','join'].forEach(t=>{
    el('tab-'+t+'-btn').classList.toggle('active',t===tab);
    el('tab-'+t).classList.toggle('active',t===tab);
  });
}
function createRoom(){
  const name=v('create-name'),buyIn=+v('s-buyin'),smallBlind=+v('s-sb'),
        bigBlind=+v('s-bb'),ante=+v('s-ante');
  if(!name) return lobbyErr('Введите имя');
  if(!buyIn||!smallBlind||!bigBlind) return lobbyErr('Заполните все поля');
  if(smallBlind>=bigBlind) return lobbyErr('МБ должен быть меньше ББ');
  socket.emit('create-room',{name,settings:{buyIn,smallBlind,bigBlind,ante}});
}
function joinRoom(){
  const name=v('join-name'),code=v('join-code').toUpperCase();
  if(!name) return lobbyErr('Введите имя');
  if(!code) return lobbyErr('Введите код');
  socket.emit('join-room',{name,roomId:code});
}
function startGame(){ socket.emit('start-game'); }
function leaveTable(){ socket.disconnect(); location.reload(); }
function lobbyErr(msg){ el('lobby-error').textContent=msg; setTimeout(()=>el('lobby-error').textContent='',3000); }

// ═══ SOCKETS ═══
socket.on('joined',({roomId})=>{
  myId=socket.id;
  el('lobby').style.display='none';
  el('game').classList.add('active');
  el('hdr-room').textContent='ROOM: '+roomId;
  el('ov-room-code').textContent=roomId;
  el('waiting-overlay').style.display='flex';
  setTimeout(updateScale,100);
});
socket.on('state',state=>{
  if(state.myId) myId=state.myId;
  const prev=gameState; gameState=state;
  handleSounds(state,prev);
  renderGame(state);
  if(state.phase==='showdown'&&prev?.phase!=='showdown') saveHistory(state);
});
socket.on('peer-joined',async({peerId})=>{
  // Existing player makes offer to new joiner
  const pc=mkPC(peerId);
  if(localStream) localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  const offer=await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer',{to:peerId,sdp:offer});
});
socket.on('peer-left',({peerId})=>{ peers[peerId]?.close(); delete peers[peerId]; });
socket.on('offer',async({from,sdp})=>{
  // New joiner receives offer from existing player
  const pc=mkPC(from);
  if(localStream) localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer=await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer',{to:from,sdp:answer});
});
socket.on('answer',async({from,sdp})=>{
  if(peers[from]) await peers[from].setRemoteDescription(new RTCSessionDescription(sdp));
});
socket.on('ice',async({from,candidate})=>{
  try{ if(peers[from]) await peers[from].addIceCandidate(new RTCIceCandidate(candidate)); }catch(e){}
});
socket.on('chat',({name,msg})=>{
  const box=el('chat-messages');
  const d=document.createElement('div'); d.className='chat-msg';
  d.innerHTML=`<span class="cn">${esc(name)}:</span> <span class="ct">${esc(msg)}</span>`;
  box.appendChild(d); box.scrollTop=box.scrollHeight;
});
socket.on('err',showToast);

// ═══ SOUNDS ═══
function handleSounds(state,prev){
  if(!prev) return;
  if(prev.phase==='waiting'&&state.phase==='preflop'){ SFX.shuffle(); return; }
  const myTurn=state.players[state.currentIdx]?.id===myId;
  const wasMine=prev.players?.[prev.currentIdx]?.id===myId;
  if(myTurn&&!wasMine) SFX.yourTurn();
  const newCards=(state.community||[]).length-(prev.community||[]).length;
  if(newCards>0&&state.phase!=='showdown')
    for(let i=0;i<newCards;i++) setTimeout(()=>SFX.deal(),i*150+80);
  if(state.phase==='showdown'&&prev.phase!=='showdown') setTimeout(()=>SFX.win(),400);
}

// ═══ WEBRTC — with proper renegotiation ═══
function mkPC(pid){
  if(peers[pid]) return peers[pid];
  const pc=new RTCPeerConnection(ICE);
  peers[pid]=pc;

  pc.onicecandidate=e=>{
    if(e.candidate) socket.emit('ice',{to:pid,candidate:e.candidate});
  };

  // Renegotiation: fires when we addTrack after connection
  pc.onnegotiationneeded=async()=>{
    try{
      const offer=await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer',{to:pid,sdp:offer});
    }catch(e){}
  };

  pc.ontrack=e=>{
    pc._stream=e.streams[0];
    attachVideo(pid,e.streams[0],false);
  };

  pc.onconnectionstatechange=()=>{
    if(pc.connectionState==='failed'||pc.connectionState==='closed'){
      pc.close(); delete peers[pid];
    }
  };

  return pc;
}

function attachVideo(pid,stream,muted){
  const wrap=document.querySelector(`.seat[data-pid="${pid}"] .seat-video-wrap`);
  if(!wrap) return;
  let vid=wrap.querySelector('video.seat-video');
  if(!vid){
    vid=document.createElement('video'); vid.className='seat-video';
    vid.autoplay=true; vid.playsinline=true; wrap.appendChild(vid);
  }
  vid.muted=muted;
  if(vid.srcObject!==stream) vid.srcObject=stream;
  vid.style.display='block';
  const av=wrap.querySelector('.seat-avatar'); if(av) av.style.display='none';
}

async function toggleCamera(){
  const btn=el('cam-btn');
  if(!cameraOn){
    try{
      localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
      cameraOn=true; btn.textContent='📷 ВКЛ'; btn.style.color='#4caf50';
      // Show own preview
      attachVideo(myId,localStream,true);
      // Send to all existing peers — onnegotiationneeded handles the offer
      for(const pid in peers){
        try{ localStream.getTracks().forEach(t=>peers[pid].addTrack(t,localStream)); }catch(e){}
      }
    }catch(e){ showToast('Нет доступа к камере'); }
  } else {
    localStream.getTracks().forEach(t=>t.stop());
    localStream=null; cameraOn=false;
    btn.textContent='📷 Камера'; btn.style.color='';
    const wrap=document.querySelector(`.seat[data-pid="${myId}"] .seat-video-wrap`);
    if(wrap){
      const vid=wrap.querySelector('video'); if(vid) vid.style.display='none';
      const av=wrap.querySelector('.seat-avatar'); if(av) av.style.display='';
    }
  }
}

// ═══ SCALE ═══
function updateScale(){
  const sec=el('table-section'),area=el('table-area'); if(!sec||!area) return;
  const s=Math.min((sec.clientWidth-20)/860,(sec.clientHeight-20)/480,1.7);
  area.style.transform=`scale(${Math.max(s,0.35)})`;
}
window.addEventListener('resize',updateScale);

// ═══ RENDER ═══
function renderGame(state){
  if(state.phase==='waiting'){
    el('waiting-overlay').style.display='flex';
    const me=state.players.find(p=>p.id===myId);
    el('ov-players').innerHTML=state.players.map(p=>
      `<div class="ov-player-chip${p.isHost?' host':''}">${esc(p.name)}</div>`).join('');
    show('ov-start-btn',!!me?.isHost); show('ov-waiting-msg',!me?.isHost);
    return;
  }
  el('waiting-overlay').style.display='none';
  state.currentPlayerId=state.players[state.currentIdx]?.id??null;

  const PHASE={preflop:'Префлоп',flop:'Флоп',turn:'Тёрн',river:'Ривер',showdown:'Шоудаун'};
  el('hdr-phase').textContent=PHASE[state.phase]||state.phase;
  el('hdr-hand').textContent='Раздача #'+state.handNum;
  el('pot-amount').textContent=state.pot;
  el('community-cards').innerHTML=(state.community||[]).map(c=>cardHtml(c)).join('');

  renderSeats(state);

  const me=state.players.find(p=>p.id===myId);
  el('my-chips').textContent=me?.chips??'';
  renderActions(state,me);

  if(state.phase==='showdown'){
    if(el('winner-banner').style.display!=='flex'){ showWinnerBanner(state); animateChips(state); }
  } else {
    clearTimeout(bannerTimer); el('winner-banner').style.display='none';
  }
}

// ═══ SEATS ═══
function avatarBg(name){
  const pals=['#c0392b','#2980b9','#27ae60','#c49a06','#8e44ad','#16a085','#e67e22','#1a5276','#d35400','#117a65'];
  return pals[(name.charCodeAt(0)+(name.charCodeAt(1)||0))%pals.length];
}

function renderSeats(state){
  const layer=el('seats-layer'); layer.innerHTML='';
  const mi=state.players.findIndex(p=>p.id===myId);
  const ord=mi<0?state.players:[...state.players.slice(mi),...state.players.slice(0,mi)];

  ord.forEach((p,idx)=>{
    if(idx>=SEAT_POS.length) return;
    const pos=SEAT_POS[idx];
    const isMe=p.id===myId, isActive=state.currentPlayerId===p.id;

    const seat=document.createElement('div');
    seat.className='seat'+(isMe?' is-me':'')+(isActive?' active-turn':'')
      +(p.folded?' folded':'')+(p.winner?' winner':'');
    seat.dataset.pid=p.id;
    seat.style.left=pos.x+'%'; seat.style.top=pos.y+'%';

    // Cards always visible at own seat (left of avatar) + opponent seats
    const revealCards=state.phase==='showdown';
    const cardsHtml=seatCards(p, isMe||revealCards);

    // Combo shown only if we have cards in hand
    const showCombo=p.handName&&p.inHand&&!p.folded;

    // Layout: for bottom seat (isMe at idx=0) — horizontal row with cards left, avatar, info right
    if(isMe){
      seat.innerHTML=`
        <div class="seat-row">
          <div class="seat-cards-left">${cardsHtml}</div>
          <div class="seat-video-wrap">
            <div class="seat-avatar" style="background:${avatarBg(p.name)}">${esc(p.name.slice(0,2).toUpperCase())}</div>
          </div>
          <div class="seat-info">
            <div class="seat-name">${esc(p.name)}${p.isHost?' 👑':''}</div>
            <div class="seat-chips-row"><span class="chip-dot"></span><span>${p.chips}</span></div>
            <div class="seat-badges">
              ${p.blindLabel?`<span class="seat-blind">${p.blindLabel}</span>`:''}
              ${p.allIn?`<span class="seat-allin">ВСЁ</span>`:''}
            </div>
            ${showCombo?`<div class="seat-combo">${p.handName}</div>`:''}
          </div>
        </div>
      `;
    } else {
      seat.innerHTML=`
        <div class="seat-video-wrap">
          <div class="seat-avatar" style="background:${avatarBg(p.name)}">${esc(p.name.slice(0,2).toUpperCase())}</div>
        </div>
        <div class="seat-info">
          <div class="seat-name">${esc(p.name)}${p.isHost?' 👑':''}</div>
          <div class="seat-chips-row"><span class="chip-dot"></span><span>${p.chips}</span></div>
          <div class="seat-badges">
            ${p.blindLabel?`<span class="seat-blind">${p.blindLabel}</span>`:''}
            ${p.allIn?`<span class="seat-allin">ВСЁ</span>`:''}
          </div>
          ${showCombo?`<div class="seat-combo">${p.handName}</div>`:''}
        </div>
        ${cardsHtml?`<div class="seat-cards">${cardsHtml}</div>`:''}
      `;
    }
    layer.appendChild(seat);

    // Bet chip
    if(p.bet>0){
      const chip=document.createElement('div');
      chip.className='seat-bet-chip';
      chip.style.left=(pos.x+(50-pos.x)*0.42)+'%';
      chip.style.top=(pos.y+(50-pos.y)*0.42)+'%';
      chip.textContent=p.bet; layer.appendChild(chip);
    }

    // Video
    if(isMe&&localStream) attachVideo(myId,localStream,true);
    else if(peers[p.id]?._stream) attachVideo(p.id,peers[p.id]._stream,false);
  });
}

function seatCards(p,reveal){
  const back='<div class="card face-down small"></div>';
  if(!p.inHand) return '';
  if(p.folded) return back+back;
  if(!reveal||!p.cards||p.cards.every(c=>!c)) return back+back;
  return p.cards.map(c=>cardHtml(c,false,'small')).join('');
}

// ═══ ACTIONS ═══
function renderActions(state,me){
  const myTurn=!!(me&&state.currentPlayerId===myId&&!me.folded&&!me.allIn);
  el('action-bar').classList.toggle('my-turn',myTurn);
  showBtn('btn-fold',  myTurn);
  showBtn('btn-check', myTurn&&me.bet>=state.currentBet);
  showBtn('btn-call',  myTurn&&me.bet<state.currentBet);
  showFlex('raise-group',myTurn&&me.chips>0);
  showBtn('btn-allin', myTurn);
  if(!myTurn) return;
  const callAmt=Math.min(state.currentBet-me.bet,me.chips);
  el('btn-call').textContent=`КОЛЛ ${callAmt}`;
  const bb=state.settings?.bigBlind||20;
  const minR=Math.min(state.currentBet+(state.lastRaise||bb),me.chips+me.bet);
  const maxR=me.chips+me.bet;
  if(!raiseTarget||raiseTarget<minR) raiseTarget=minR;
  if(raiseTarget>maxR) raiseTarget=maxR;
  const sl=el('raise-slider');
  sl.min=minR; sl.max=maxR; sl.step=bb; sl.value=raiseTarget;
  sl.dataset.pot=state.pot; sl.dataset.min=minR; sl.dataset.max=maxR;
  el('raise-amount-display').textContent=raiseTarget;
}
function setRaisePct(pct){
  const sl=el('raise-slider'); if(!sl) return;
  const pot=+sl.dataset.pot||0,mn=+sl.dataset.min||0,mx=+sl.dataset.max||0;
  raiseTarget=Math.max(mn,Math.min(mx,Math.round(pot*pct)));
  sl.value=raiseTarget; el('raise-amount-display').textContent=raiseTarget;
}
function onSlider(){ raiseTarget=+el('raise-slider').value; el('raise-amount-display').textContent=raiseTarget; }
function sendAction(action){
  if(action==='fold') SFX.fold();
  else if(action==='check') SFX.check();
  else if(action==='allin') SFX.allin();
  else SFX.chip();
  socket.emit('action',action==='raise'?{action,amount:raiseTarget}:{action});
}

// ═══ WINNER BANNER ═══
function showWinnerBanner(state){
  clearTimeout(bannerTimer);
  const result=state.showdown;
  const winners=result?.winners||state.players.filter(p=>p.winner);
  if(!winners.length) return;
  const names=winners.map(w=>w.name).join(' и ');
  const hand=winners[0]?.handName||'';
  el('winner-banner-text').innerHTML=`🏆 <strong>${esc(names)}</strong> победа${hand?' — <em>'+esc(hand)+'</em>':''}!`;
  el('winner-banner').style.display='flex';
  bannerTimer=setTimeout(()=>{ el('winner-banner').style.display='none'; },5000);
}

// ═══ CHIP ANIMATION ═══
function animateChips(state){
  const result=state.showdown;
  const winners=result?.winners||state.players.filter(p=>p.winner);
  if(!winners.length) return;
  const layer=el('chip-anim-layer'); layer.innerHTML='';
  const mi=state.players.findIndex(p=>p.id===myId);
  const ord=mi<0?state.players:[...state.players.slice(mi),...state.players.slice(0,mi)];
  const wi=ord.findIndex(p=>p.id===winners[0].id);
  if(wi<0||wi>=SEAT_POS.length) return;
  const wpos=SEAT_POS[wi];
  const tx=(wpos.x/100)*860, ty=(wpos.y/100)*480;
  const count=Math.min(14,Math.max(4,Math.ceil(state.pot/100)));
  SFX.chipSlide();
  for(let i=0;i<count;i++){
    setTimeout(()=>{
      const chip=document.createElement('div'); chip.className='flying-chip';
      const sx=380+Math.random()*100-50, sy=210+Math.random()*60-30;
      chip.style.left=sx+'px'; chip.style.top=sy+'px';
      layer.appendChild(chip);
      requestAnimationFrame(()=>{
        chip.style.transform=`translate(${tx-sx}px,${ty-sy}px)`; chip.style.opacity='0';
      });
      setTimeout(()=>chip.remove(),650);
    },i*40);
  }
}

// ═══ HAND HISTORY ═══
function saveHistory(state){
  const me=state.players.find(p=>p.id===myId); if(!me) return;
  const result=state.showdown;
  const winners=result?.winners||state.players.filter(p=>p.winner);
  handHistory.unshift({
    handNum:state.handNum,myCards:me.cards||[],community:state.community||[],
    myHand:me.handName||'',won:winners.some(w=>w.id===myId),
    winners:winners.map(w=>w.name),pot:state.pot,
    players:result?.allHands||state.players.filter(p=>p.inHand).map(p=>({name:p.name,cards:p.cards,handName:p.handName}))
  });
  if(handHistory.length>50) handHistory.pop();
  renderHistory();
}
function renderHistory(){
  const list=el('history-list'); if(!list) return;
  list.innerHTML=handHistory.map(h=>`
    <div class="history-entry${h.won?' h-won':''}">
      <div class="h-header">
        <span class="h-num">Раздача #${h.handNum}</span>
        <span class="h-result ${h.won?'h-win':'h-loss'}">${h.won?'✓ ПОБЕДА':'✗ ПОРАЖЕНИЕ'}</span>
      </div>
      <div class="h-cards"><span class="h-label">Рука:</span>
        ${h.myCards.map(c=>cardHtml(c,false,'small')).join('')}
        ${h.myHand?`<span class="h-hand-name">${h.myHand}</span>`:''}
      </div>
      ${h.community.length?`<div class="h-cards"><span class="h-label">Борд:</span>
        ${h.community.map(c=>cardHtml(c,false,'small')).join('')}</div>`:''}
      <div class="h-players">
        ${h.players.filter(p=>p.cards?.length).map(p=>`
          <span class="h-player">${esc(p.name)}: ${p.cards.map(c=>cardHtml(c,false,'small')).join('')}
          ${p.handName?`<em>${esc(p.handName)}</em>`:''}</span>`).join('')}
      </div>
      <div class="h-footer">🏆 ${h.winners.map(esc).join(', ')} • Банк: ${h.pot}</div>
    </div>`).join('');
}
function toggleHistory(){ const p=el('history-panel'); p.style.display=p.style.display==='none'?'flex':'none'; }

// ═══ CHAT ═══
function sendChat(){
  const inp=el('chat-input'); const msg=inp.value.trim(); if(!msg) return;
  socket.emit('chat',{msg}); inp.value='';
}

// ═══ CARDS ═══
function cardHtml(card,hidden=false,size=''){
  const cls=size?' '+size:'';
  if(!card||hidden) return `<div class="card face-down${cls}"></div>`;
  const rm={11:'J',12:'Q',13:'K',14:'A'};
  const suits={s:'♠',h:'♥',d:'♦',c:'♣'};
  const red=card.s==='h'||card.s==='d';
  return `<div class="card face-up${red?' red':''}${cls}"><span class="cr">${rm[card.r]||card.r}</span><span class="cs">${suits[card.s]}</span></div>`;
}

// ═══ UTILS ═══
function el(id){ return document.getElementById(id); }
function v(id){ return (el(id)?.value||'').trim(); }
function show(id,vis){ const e=el(id); if(e) e.style.display=vis?'':'none'; }
function showBtn(id,vis){ const e=el(id); if(e) e.style.display=vis?'inline-flex':'none'; }
function showFlex(id,vis){ const e=el(id); if(e) e.style.display=vis?'flex':'none'; }
function showToast(msg){
  const t=el('toast'); t.textContent=msg; t.style.display='block';
  clearTimeout(t._t); t._t=setTimeout(()=>{ t.style.display='none'; },3500);
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
