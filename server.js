
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function id() {
  return crypto.randomBytes(4).toString("hex");
}
function cleanNames(names) {
  return [...new Set((names || []).map(x => String(x).trim()).filter(Boolean))].slice(0, 20);
}
function publicRoom(room) {
  return {
    code: room.code, league: room.league, startAt: room.startAt,
    status: room.status, teams: room.teams,
    joined: [...room.joined], results: room.results,
    race: room.race
  };
}

app.post("/api/rooms", (req,res) => {
  const league = String(req.body.league || "Fantasy League").trim().slice(0,60);
  const teams = cleanNames(req.body.teams);
  if (teams.length < 2) return res.status(400).json({error:"Add at least 2 teams."});
  const code = id();
  const room = {
    code, league, teams, startAt: req.body.startAt || null,
    status:"lobby", joined:[], results:[], race:null, started:false
  };
  rooms.set(code, room);
  res.json({code, url:`/r/${code}`, room:publicRoom(room)});
});

app.get("/api/rooms/:code", (req,res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({error:"Draft Rush not found."});
  res.json(publicRoom(room));
});

app.get("/r/:code", (req,res) => {
  res.sendFile(path.join(__dirname,"public","index.html"));
});

function broadcast(room) {
  io.to(room.code).emit("state", publicRoom(room));
}

function shuffle(a) {
  a = [...a];
  for (let i=a.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function runRoom(room) {
  if (room.started) return;
  room.started = true;
  room.status = "live";
  let remaining = shuffle(room.teams);
  room.race = {pick:remaining.length, runners:remaining.map((name,i)=>({name,lane:i}))};
  broadcast(room);

  while (remaining.length) {
    const pick = remaining.length;
    room.race = {pick, runners:remaining.map((name,i)=>({name,lane:i,progress:0})), event:null};
    broadcast(room);

    const progress = Object.fromEntries(remaining.map(n=>[n,0]));
    for (let step=0;step<6;step++) {
      await sleep(650);
      remaining.forEach(name => {
        progress[name] = Math.min(94, progress[name] + 7 + Math.random()*15);
      });

      let event = null;
      if (Math.random() < .7) {
        const name = remaining[Math.floor(Math.random()*remaining.length)];
        if (Math.random()<.5) {
          progress[name] = Math.min(94, progress[name]+10+Math.random()*10);
          event = {type:"boost", name, text:"⚡ HITS THE GAP!"};
        } else {
          progress[name] = Math.max(0, progress[name]-7);
          event = {type:"slow", name, text:"🚧 RUNS INTO TRAFFIC!"};
        }
      }
      room.race.runners = remaining.map((name,i)=>({name,lane:i,progress:progress[name]}));
      room.race.event = event;
      broadcast(room);
    }

    const winner = remaining.reduce((a,b)=>progress[b]>progress[a]?b:a);
    progress[winner]=100;
    room.race.runners = remaining.map((name,i)=>({name,lane:i,progress:progress[name]}));
    room.race.winner = winner;
    broadcast(room);
    await sleep(1200);

    room.results.push(winner);
    remaining = remaining.filter(n=>n!==winner);
    if (remaining.length) {
      room.race = null;
      broadcast(room);
      await sleep(850);
    }
  }

  room.status = "complete";
  room.race = null;
  broadcast(room);
}

io.on("connection", socket => {
  socket.on("join", ({code,name}) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("errorMessage","Draft Rush not found.");
    socket.join(code);
    const clean = String(name||"").trim().slice(0,30);
    if (clean && !room.joined.includes(clean)) room.joined.push(clean);
    socket.emit("state",publicRoom(room));
    broadcast(room);
  });

  socket.on("commissionerStart", ({code}) => {
    const room=rooms.get(code);
    if (!room) return;
    runRoom(room).catch(console.error);
  });
});

setInterval(()=>{
  const cutoff=Date.now()-24*60*60*1000;
  for (const [code,room] of rooms) {
    const t = room.startAt ? new Date(room.startAt).getTime() : Infinity;
    if (room.status==="lobby" && t <= Date.now()) runRoom(room).catch(console.error);
    if (room.status==="complete" && t < cutoff) rooms.delete(code);
  }
},1000);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Draft Rush listening on ${PORT}`));
