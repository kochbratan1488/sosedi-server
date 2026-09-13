const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const rooms = new Map();

function makeCode(){
  let code;
  do { code = Math.random().toString(36).slice(2,8).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function send(ws, data){
  if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(room, data){
  if(!room) return;
  send(room.host, data);
  send(room.guest, data);
}

function newQuestionFor(room){
  // The browser already chooses the country. The server only controls turn/score/state.
  const turn = room.nextTurn;
  room.nextTurn = turn;
  broadcast(room, {type:'requestQuestion', turn});
}

const server = http.createServer((req,res)=>{
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if(urlPath === '/') urlPath='/index.html';
  const file = path.normalize(path.join(ROOT,urlPath));
  if(!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file,(err,data)=>{
    if(err){ res.writeHead(404); return res.end('Not found'); }
    const ext=path.extname(file);
    const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[ext] || 'application/octet-stream';
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});
    res.end(data);
  });
});

const wss = new WebSocket.Server({server});

wss.on('connection',(ws)=>{
  ws.room=null;
  ws.role=null;

  ws.on('message',(raw)=>{
    let data;
    try { data=JSON.parse(raw.toString()); } catch { return; }

    if(data.type==='create'){
      if(ws.room) return;
      const code=makeCode();
      const room={code,host:ws,guest:null,score:0,nextTurn:'host'};
      rooms.set(code,room);
      ws.room=room; ws.role='host';
      send(ws,{type:'roomCreated',room:code});
      return;
    }

    if(data.type==='join'){
      const room=rooms.get(String(data.room||'').toUpperCase());
      if(!room){ send(ws,{type:'error',message:'Комната не найдена.'}); return; }
      if(room.guest && room.guest!==ws){ send(ws,{type:'error',message:'Комната уже занята.'}); return; }
      ws.room=room; ws.role='guest'; room.guest=ws;
      send(ws,{type:'joined',room:room.code});
      send(room.host,{type:'roomReady'});
      return;
    }

    const room=ws.room;
    if(!room) return;

    if(data.type==='map' || data.type==='input'){
      const other=ws.role==='host'?room.guest:room.host;
      send(other,data);
      return;
    }

    if(data.type==='answer'){
      // Only the player whose turn it is may submit.
      if(ws.role!==room.nextTurn) return;
      if(data.correct) room.score++;
      const nextTurn=ws.role==='host'?'guest':'host';
      room.nextTurn=nextTurn;
      broadcast(room,{type:'answer',score:room.score,correct:!!data.correct,result:data.result||'',nextTurn});
      return;
    }

    if(data.type==='next'){
      if(ws.role!==room.nextTurn) return;
      // The player who just received the turn requests the host to create the next question.
      const host=room.host;
      send(host,{type:'makeNextQuestion',turn:room.nextTurn,score:room.score});
      return;
    }
  });

  ws.on('close',()=>{
    const room=ws.room;
    if(!room) return;
    if(room.host===ws){ send(room.guest,{type:'left'}); rooms.delete(room.code); }
    else if(room.guest===ws){ room.guest=null; send(room.host,{type:'left'}); }
  });
});

server.listen(PORT,()=>console.log(`Соседи России server: http://localhost:${PORT}`));
