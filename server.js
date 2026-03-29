const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sleepyafk-super-secret-2024';
const DATA_DIR    = path.join(__dirname, 'data');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const BOTS_FILE   = path.join(DATA_DIR, 'bots.json');
const RUNNING_FILE= path.join(DATA_DIR, 'running.json');
const STATS_FILE  = path.join(DATA_DIR, 'stats.json'); // per-bot uptime + event history

if (!fs.existsSync(DATA_DIR))     fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE))   fs.writeFileSync(USERS_FILE,  '[]');
if (!fs.existsSync(BOTS_FILE))    fs.writeFileSync(BOTS_FILE,   '[]');
if (!fs.existsSync(RUNNING_FILE)) fs.writeFileSync(RUNNING_FILE,'[]');
if (!fs.existsSync(STATS_FILE))   fs.writeFileSync(STATS_FILE,  '{}');

function readUsers()    { return JSON.parse(fs.readFileSync(USERS_FILE,  'utf8')); }
function writeUsers(d)  { fs.writeFileSync(USERS_FILE,  JSON.stringify(d, null, 2)); }
function readBots()     { return JSON.parse(fs.readFileSync(BOTS_FILE,   'utf8')); }
function writeBots(d)   { fs.writeFileSync(BOTS_FILE,   JSON.stringify(d, null, 2)); }
function readRunning()  { try { return JSON.parse(fs.readFileSync(RUNNING_FILE,'utf8')); } catch { return []; } }
function writeRunning(ids) { fs.writeFileSync(RUNNING_FILE, JSON.stringify(ids)); }
function readStats()    { try { return JSON.parse(fs.readFileSync(STATS_FILE,'utf8')); } catch { return {}; } }
function writeStats(d)  { fs.writeFileSync(STATS_FILE, JSON.stringify(d, null, 2)); }

function markRunning(id) { const ids=readRunning(); if(!ids.includes(id)){ids.push(id);writeRunning(ids);} }
function markStopped(id) { writeRunning(readRunning().filter(x=>x!==id)); }

// ─── Per-bot stats tracking ───────────────────────────────────────────────────
// stats[botId] = { totalUptime, sessionStart, kicks, reconnects, messagesOut, uptimeHistory: [{t,v},...] }

function getStats(botId) {
  const s = readStats();
  if (!s[botId]) s[botId] = { totalUptime:0, sessionStart:null, kicks:0, reconnects:0, messagesOut:0, uptimeHistory:[] };
  return s[botId];
}
function saveStats(botId, data) {
  const s = readStats(); s[botId] = data; writeStats(s);
}
function recordUptimeTick(botId) {
  const st = getStats(botId);
  const now = Date.now();
  // add one data point per minute tick
  st.uptimeHistory.push({ t: now, online: 1 });
  // keep only last 24h (1440 minutes)
  const cutoff = now - 24*60*60*1000;
  st.uptimeHistory = st.uptimeHistory.filter(p => p.t > cutoff);
  if (st.sessionStart) st.totalUptime += 60; // 60 seconds per tick
  saveStats(botId, st);
}
function recordDowntimeTick(botId) {
  const st = getStats(botId);
  const now = Date.now();
  st.uptimeHistory.push({ t: now, online: 0 });
  const cutoff = now - 24*60*60*1000;
  st.uptimeHistory = st.uptimeHistory.filter(p => p.t > cutoff);
  saveStats(botId, st);
}

// ─── Active Bot Runtime ───────────────────────────────────────────────────────
const activeBots = new Map();

// Uptime tick interval (per-minute)
const uptimeTickers = new Map();
function startUptimeTicker(botId) {
  stopUptimeTicker(botId);
  uptimeTickers.set(botId, setInterval(() => recordUptimeTick(botId), 60*1000));
}
function stopUptimeTicker(botId) {
  if (uptimeTickers.has(botId)) { clearInterval(uptimeTickers.get(botId)); uptimeTickers.delete(botId); }
}

function addLog(botId, message, type='info') {
  const runtime = activeBots.get(botId);
  const entry = { time: new Date().toISOString(), message, type };
  if (runtime) { runtime.logs.push(entry); if (runtime.logs.length > 500) runtime.logs.shift(); }
  io.emit('bot:log', { botId, entry });
  io.emit('home:activity', { botId, entry }); // also send to home screen
}

// ─── Anti-AFK ────────────────────────────────────────────────────────────────
function startAntiAfk(botId, bot, config) {
  const intervals = [];
  if (config.jumpEnabled && config.jumpInterval > 0)
    intervals.push(setInterval(() => { try { if (bot?.entity) { bot.setControlState('jump',true); setTimeout(()=>bot.setControlState('jump',false),300); addLog(botId,'🦘 Anti-AFK: jumped','afk'); } } catch {} }, config.jumpInterval*1000));
  if (config.walkEnabled && config.walkInterval > 0)
    intervals.push(setInterval(() => { try { if (bot?.entity) { const dirs=['forward','back','left','right']; const d=dirs[Math.floor(Math.random()*4)]; bot.setControlState(d,true); setTimeout(()=>bot.setControlState(d,false),800+Math.random()*400); addLog(botId,`🚶 Anti-AFK: walked ${d}`,'afk'); } } catch {} }, config.walkInterval*1000));
  if (config.lookEnabled && config.lookInterval > 0)
    intervals.push(setInterval(() => { try { if (bot?.entity) { bot.look((Math.random()*Math.PI*2)-Math.PI,(Math.random()*Math.PI/2)-Math.PI/4,false); addLog(botId,'👀 Anti-AFK: looked','afk'); } } catch {} }, config.lookInterval*1000));
  return intervals;
}

// ─── Timed Messages ───────────────────────────────────────────────────────────
function startTimedMessages(botId, bot, timedMessages) {
  const intervals = [];
  if (!Array.isArray(timedMessages)) return intervals;
  timedMessages.forEach(tm => {
    if (!tm.enabled || !tm.message?.trim()) return;
    const ms = ((parseInt(tm.hours)||0)*3600+(parseInt(tm.minutes)||0)*60+(parseInt(tm.seconds)||0))*1000;
    if (ms < 5000) { addLog(botId,`⚠️ Skipped "${tm.message}" — too short`,'warn'); return; }
    intervals.push(setInterval(() => {
      try { if (bot?.entity) {
        bot.chat(tm.message.trim());
        const label = tm.message.trim().startsWith('/') ? '⚡ Command' : '📢 Timed';
        addLog(botId,`${label}: ${tm.message.trim()}`,'timed');
        const st = getStats(botId); st.messagesOut++; saveStats(botId, st);
      } } catch {}
    }, ms));
    const hS=(parseInt(tm.hours)||0)>0?`${tm.hours}h `:'', mS=(parseInt(tm.minutes)||0)>0?`${tm.minutes}m `:'', sS=(parseInt(tm.seconds)||0)>0?`${tm.seconds}s`:'';
    addLog(botId,`⏱ Scheduled: "${tm.message.trim()}" every ${hS}${mS}${sS}`,'info');
  });
  return intervals;
}

function stopIntervals(arr) { if(arr) arr.forEach(id=>clearInterval(id)); }

// ─── Cycle ────────────────────────────────────────────────────────────────────
function scheduleCycle(botId, botConfig) {
  const runtime = activeBots.get(botId);
  if (!runtime || !botConfig.cycleEnabled) return;
  const leaveMs  = (botConfig.cycleLeaveEvery  || 15) * 60000;
  const rejoinMs = (botConfig.cycleRejoinAfter || 5)  * 1000;
  addLog(botId,`🔁 Cycle: leave in ${botConfig.cycleLeaveEvery||15}m, rejoin after ${botConfig.cycleRejoinAfter||5}s`,'info');
  runtime.cycleTimeout = setTimeout(() => {
    const rt = activeBots.get(botId);
    if (!rt || rt.stopping) return;
    addLog(botId,`🔁 Cycle leave — offline for ${botConfig.cycleRejoinAfter||5}s`,'warn');
    stopIntervals(rt.afkIntervals); stopIntervals(rt.msgIntervals);
    if (rt.cycleTimeout) clearTimeout(rt.cycleTimeout);
    if (rt.statsPoller)  clearInterval(rt.statsPoller);
    if (rt.watchdog)      clearInterval(rt.watchdog);
    try { rt.bot.quit('cycle'); } catch {}
    activeBots.delete(botId); stopUptimeTicker(botId);
    io.emit('bot:statusChange', { botId, status:'offline' });
    setTimeout(() => {
      const fresh = readBots().find(b=>b.id===botId);
      if (fresh && !activeBots.has(botId)) { addLog(botId,'🔁 Cycle rejoin...','info'); startBot(fresh); }
    }, rejoinMs);
  }, leaveMs);
}

function sendOnJoinCommand(botId, bot, cmd) {
  if (!cmd?.trim()) return;
  setTimeout(() => { try { if(bot?.entity){bot.chat(cmd.trim()); addLog(botId,`⚡ On-join: ${cmd.trim()}`,'sent'); const st=getStats(botId); st.messagesOut++; saveStats(botId,st); } } catch {} }, 1500);
}

// ─── Bot Lifecycle ────────────────────────────────────────────────────────────
function startBot(botConfig) {
  const { id, host, port, username, version, antiAfk, timedMessages, autoRejoin, autoLeave, onJoinCommand, onJoinCommands, cycleEnabled, cycleLeaveEvery, cycleRejoinAfter, autoRespawn, discordWebhook } = botConfig;
  if (activeBots.has(id)) { addLog(id,'⚠️ Already running','warn'); return; }
  addLog(id,`🔌 Connecting to ${host}:${port} as ${username}...`,'info');
  io.emit('bot:statusChange', { botId:id, status:'connecting' });
  let bot;
  try { bot = mineflayer.createBot({ host, port:parseInt(port,10), username, version:version||false, auth:'offline', hideErrors:false }); }
  catch(err) { addLog(id,`❌ Failed: ${err.message}`,'error'); io.emit('bot:statusChange',{botId:id,status:'error'}); return; }

  const runtime = { bot, afkIntervals:[], msgIntervals:[], cycleTimeout:null, logs:activeBots.get(id)?.logs||[], stopping:false };
  activeBots.set(id, runtime);
  markRunning(id);

  // Track reconnect count
  const st = getStats(id);
  if (st.sessionStart !== null) { st.reconnects++; }
  st.sessionStart = Date.now();
  saveStats(id, st);

  bot.once('spawn', () => {
    addLog(id,`✅ Spawned on ${host}:${port}`,'success');
    if (discordWebhook) sendDiscordWebhook(discordWebhook, {
      embeds:[{ title:'✅ Bot Online', description:`**${username}** connected to \`${host}:${port}\``, color:0x00ff88, timestamp:new Date().toISOString(), footer:{text:'SleepyAfk'} }]
    });
    io.emit('bot:statusChange', { botId:id, status:'online' });
    io.emit('home:botOnline', { botId:id });
    runtime.afkIntervals = startAntiAfk(id, bot, antiAfk||{});
    runtime.msgIntervals = startTimedMessages(id, bot, timedMessages||[]);
    sendOnJoinCommands(id, bot, onJoinCommands || onJoinCommand);
    scheduleCycle(id, botConfig);
    if (autoRespawn) enableAutoRespawn(id, bot);
    startUptimeTicker(id);
  });

  bot.on('chat',    (u,m) => addLog(id,`💬 <${u}> ${m}`,'chat'));
  bot.on('whisper', (u,m) => addLog(id,`📩 [Whisper] <${u}> ${m}`,'chat'));

  function handleDisconnect(label, reason) {
    const rt = activeBots.get(id);
    if (!rt) return;
    addLog(id,`${label}: ${reason||'ended'}`,'error');
    stopIntervals(rt.afkIntervals); stopIntervals(rt.msgIntervals);
    if (rt.cycleTimeout) clearTimeout(rt.cycleTimeout);
    if (rt.statsPoller)  clearInterval(rt.statsPoller);
    if (rt.watchdog)      clearInterval(rt.watchdog);
    activeBots.delete(id); stopUptimeTicker(id);
    // record downtime ticks for the gap (approximate — 1 tick for the event)
    recordDowntimeTick(id);
    const st2 = getStats(id); st2.sessionStart = null; saveStats(id, st2);
    io.emit('bot:statusChange', { botId:id, status:'offline' });
    if (!rt.stopping && discordWebhook) sendDiscordWebhook(discordWebhook, {
      embeds:[{ title:'🔴 Bot Offline', description:`**${username}** disconnected from \`${host}:${port}\``, color:0xff6b35, timestamp:new Date().toISOString(), footer:{text:'SleepyAfk'} }]
    });
    if (rt.stopping) { markStopped(id); return; }
    if (autoRejoin) { addLog(id,'🔄 Auto-rejoin in 5s...','warn'); setTimeout(()=>{ const f=readBots().find(b=>b.id===id); if(f&&!activeBots.has(id)) startBot(f); },5000); }
    else markStopped(id);
  }

  bot.on('kicked', (reason) => {
    let msg=reason; try{msg=JSON.parse(reason)?.text||JSON.stringify(JSON.parse(reason));}catch{}
    const st2=getStats(id); st2.kicks++; saveStats(id,st2);
    if (discordWebhook) sendDiscordWebhook(discordWebhook, {
      embeds:[{ title:'👢 Bot Kicked', description:`**${username}** was kicked from \`${host}:${port}\`\n\`${msg}\``, color:0xff4757, timestamp:new Date().toISOString(), footer:{text:'SleepyAfk'} }]
    });
    if (autoLeave) { addLog(id,`👢 Kicked (auto-leave): ${msg}`,'warn'); const rt=activeBots.get(id); if(rt){stopIntervals(rt.afkIntervals);stopIntervals(rt.msgIntervals);if(rt.cycleTimeout)clearTimeout(rt.cycleTimeout);if(rt.statsPoller)clearInterval(rt.statsPoller);if(rt.watchdog)clearInterval(rt.watchdog);} activeBots.delete(id); stopUptimeTicker(id); markStopped(id); io.emit('bot:statusChange',{botId:id,status:'offline'}); return; }
    handleDisconnect('👢 Kicked', msg);
  });
  bot.on('error', err => handleDisconnect('❌ Error', err.message));
  bot.on('end',   reason => { const rt=activeBots.get(id); handleDisconnect(rt?.stopping?'🔴 Stopped':'🔴 Disconnected', reason); });
  // Poll stats every 3 seconds so health/food/ping always show (not just on change)
  const statsPoller = setInterval(() => {
    try {
      if (!activeBots.has(id)) { clearInterval(statsPoller); return; }
      if (bot?.entity && bot.health !== undefined) {
        io.emit('bot:stats', {
          botId: id,
          health: Math.round(bot.health ?? 0),
          food:   Math.round(bot.food   ?? 0),
          ping:   bot.player?.ping ?? 0
        });
      }
    } catch {}
  }, 3000);
  runtime.statsPoller = statsPoller;

  // Watchdog: every 8s verify bot is truly connected — catches server shutdowns that don't emit events
  const watchdog = setInterval(() => {
    try {
      if (!activeBots.has(id)) { clearInterval(watchdog); return; }
      const isDisconnected =
        bot?.state === 'disconnected' ||
        bot?.state === 'errored'      ||
        (!bot?.entity && bot?._client?.socket?.destroyed);
      if (isDisconnected) {
        clearInterval(watchdog);
        const rt2 = activeBots.get(id);
        if (rt2) handleDisconnect('❌ Connection lost', 'server unreachable');
      }
    } catch {}
  }, 8000);
  runtime.watchdog = watchdog;

  // Also emit immediately on health change event
  bot.on('health', () => {
    try {
      io.emit('bot:stats', {
        botId: id,
        health: Math.round(bot.health ?? 0),
        food:   Math.round(bot.food   ?? 0),
        ping:   bot.player?.ping ?? 0
      });
    } catch {}
  });
}

function stopBot(botId) {
  const rt = activeBots.get(botId);
  if (!rt) return;
  rt.stopping = true;
  addLog(botId,'🛑 Stopping...','warn');
  stopIntervals(rt.afkIntervals); stopIntervals(rt.msgIntervals);
  if (rt.cycleTimeout)  clearTimeout(rt.cycleTimeout);
  if (rt.statsPoller)   clearInterval(rt.statsPoller);
  if (rt.watchdog)      clearInterval(rt.watchdog);
  try { rt.bot.quit('User stopped'); } catch {}
  activeBots.delete(botId); stopUptimeTicker(botId); markStopped(botId);
  io.emit('bot:statusChange',{botId,status:'offline'});
}

function restoreRunningBots() {
  const ids = readRunning(); if (!ids.length) return;
  const all = readBots(); let n=0;
  ids.forEach(id => { const c=all.find(b=>b.id===id); if(c){startBot(c);n++;}else markStopped(id); });
  if (n) console.log(`[SleepyAfk] Restored ${n} bot(s)`);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req,res,next) {
  const t=req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({error:'No token'});
  try { req.user=jwt.verify(t,JWT_SECRET); next(); } catch { res.status(401).json({error:'Invalid token'}); }
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/register', async (req,res) => {
  const {username,password}=req.body;
  if (!username||!password) return res.status(400).json({error:'Required'});
  if (username.length<3) return res.status(400).json({error:'Username min 3 chars'});
  if (password.length<6) return res.status(400).json({error:'Password min 6 chars'});
  const users=readUsers();
  if (users.find(u=>u.username.toLowerCase()===username.toLowerCase())) return res.status(409).json({error:'Username taken'});
  const hash=await bcrypt.hash(password,10);
  users.push({id:Date.now().toString(),username,password:hash,createdAt:new Date().toISOString()});
  writeUsers(users);
  res.json({token:jwt.sign({username},JWT_SECRET,{expiresIn:'7d'}),username});
});
app.post('/api/login', async (req,res) => {
  const {username,password}=req.body; const users=readUsers();
  const user=users.find(u=>u.username.toLowerCase()===username?.toLowerCase());
  if (!user||!(await bcrypt.compare(password,user.password))) return res.status(401).json({error:'Invalid credentials'});
  res.json({token:jwt.sign({username:user.username},JWT_SECRET,{expiresIn:'7d'}),username:user.username});
});

// ─── Stats / Uptime API ───────────────────────────────────────────────────────
app.get('/api/stats', auth, (req,res) => {
  const bots = readBots().filter(b=>b.owner===req.user.username);
  const allStats = readStats();
  const result = {};
  bots.forEach(b => {
    const st = allStats[b.id] || {totalUptime:0,kicks:0,reconnects:0,messagesOut:0,uptimeHistory:[]};
    const isOnline = activeBots.has(b.id);
    // compute current session uptime
    let currentSession = 0;
    if (isOnline && st.sessionStart) currentSession = Math.floor((Date.now()-st.sessionStart)/1000);
    result[b.id] = { ...st, isOnline, currentSession };
  });
  res.json(result);
});

app.get('/api/stats/:id/uptime', auth, (req,res) => {
  const bot = readBots().find(b=>b.id===req.params.id&&b.owner===req.user.username);
  if (!bot) return res.status(404).json({error:'Not found'});
  const st = getStats(req.params.id);
  res.json(st.uptimeHistory || []);
});

// ─── Bot Routes ───────────────────────────────────────────────────────────────
function defaultTimedMessages() {
  return Array.from({length:3},(_,i)=>({id:(Date.now()+i).toString(),enabled:false,message:'',hours:0,minutes:5,seconds:0}));
}

app.get('/api/bots', auth, (req,res) => {
  const bots=readBots().filter(b=>b.owner===req.user.username);
  res.json(bots.map(b=>({...b,status:activeBots.has(b.id)?'online':'offline',logs:activeBots.get(b.id)?.logs||[]})));
});
app.post('/api/bots', auth, (req,res) => {
  const {name,host,port,username,version,antiAfk,timedMessages,autoRejoin,autoLeave,onJoinCommand,cycleEnabled,cycleLeaveEvery,cycleRejoinAfter}=req.body;
  if (!name||!host||!port||!username) return res.status(400).json({error:'name/host/port/username required'});
  const bots=readBots();
  const nb={id:Date.now().toString(),owner:req.user.username,name,host,port:parseInt(port,10),username,version:version||'',
    antiAfk:{jumpEnabled:antiAfk?.jumpEnabled??true,jumpInterval:antiAfk?.jumpInterval??30,walkEnabled:antiAfk?.walkEnabled??true,walkInterval:antiAfk?.walkInterval??45,lookEnabled:antiAfk?.lookEnabled??true,lookInterval:antiAfk?.lookInterval??20},
    timedMessages:timedMessages??defaultTimedMessages(),autoRejoin:autoRejoin??false,autoLeave:autoLeave??false,onJoinCommand:onJoinCommand??'',
    cycleEnabled:cycleEnabled??false,cycleLeaveEvery:cycleLeaveEvery??15,cycleRejoinAfter:cycleRejoinAfter??5,createdAt:new Date().toISOString()};
  bots.push(nb); writeBots(bots); res.json(nb);
});
app.put('/api/bots/:id', auth, (req,res) => {
  const bots=readBots(); const idx=bots.findIndex(b=>b.id===req.params.id&&b.owner===req.user.username);
  if (idx===-1) return res.status(404).json({error:'Not found'});
  const {name,host,port,username,version,antiAfk,timedMessages,autoRejoin,autoLeave,onJoinCommand,onJoinCommands,cycleEnabled,cycleLeaveEvery,cycleRejoinAfter,autoRespawn,discordWebhook}=req.body;
  bots[idx]={...bots[idx],name,host,port:parseInt(port,10),username,version:version||'',antiAfk,timedMessages,autoRejoin:autoRejoin??false,autoLeave:autoLeave??false,onJoinCommand:onJoinCommand??'',onJoinCommands:onJoinCommands??[],cycleEnabled:cycleEnabled??false,cycleLeaveEvery:cycleLeaveEvery??15,cycleRejoinAfter:cycleRejoinAfter??5,autoRespawn:autoRespawn??false,discordWebhook:discordWebhook??''};
  writeBots(bots);
  const rt=activeBots.get(req.params.id);
  if (rt) { stopIntervals(rt.afkIntervals); stopIntervals(rt.msgIntervals); if(rt.cycleTimeout)clearTimeout(rt.cycleTimeout); rt.afkIntervals=startAntiAfk(req.params.id,rt.bot,antiAfk||{}); rt.msgIntervals=startTimedMessages(req.params.id,rt.bot,timedMessages||[]); scheduleCycle(req.params.id,bots[idx]); addLog(req.params.id,'⚙️ Settings applied live','info'); }
  res.json(bots[idx]);
});
app.delete('/api/bots/:id', auth, (req,res) => {
  const bots=readBots(); const idx=bots.findIndex(b=>b.id===req.params.id&&b.owner===req.user.username);
  if (idx===-1) return res.status(404).json({error:'Not found'});
  if (activeBots.has(req.params.id)) stopBot(req.params.id);
  bots.splice(idx,1); writeBots(bots); res.json({success:true});
});
app.post('/api/bots/:id/start', auth, (req,res) => { const b=readBots().find(b=>b.id===req.params.id&&b.owner===req.user.username); if(!b)return res.status(404).json({error:'Not found'}); startBot(b); res.json({success:true}); });
app.post('/api/bots/:id/stop',  auth, (req,res) => { const b=readBots().find(b=>b.id===req.params.id&&b.owner===req.user.username); if(!b)return res.status(404).json({error:'Not found'}); stopBot(req.params.id); res.json({success:true}); });
app.post('/api/bots/:id/chat',  auth, (req,res) => {
  const {message}=req.body; if(!message)return res.status(400).json({error:'Message required'});
  const rt=activeBots.get(req.params.id); if(!rt)return res.status(400).json({error:'Not running'});
  try { rt.bot.chat(message); addLog(req.params.id,`📤 [You] ${message}`,'sent'); const st=getStats(req.params.id); st.messagesOut++; saveStats(req.params.id,st); res.json({success:true}); }
  catch(err){ res.status(500).json({error:err.message}); }
});
app.get('/api/bots/:id/logs', auth, (req,res) => { const b=readBots().find(b=>b.id===req.params.id&&b.owner===req.user.username); if(!b)return res.status(404).json({error:'Not found'}); res.json(activeBots.get(req.params.id)?.logs||[]); });

// ─── Socket ───────────────────────────────────────────────────────────────────
io.use((socket,next) => {
  const t=socket.handshake.auth?.token;
  if(!t)return next(new Error('Unauthorized'));
  try{socket.user=jwt.verify(t,JWT_SECRET);next();}catch{next(new Error('Invalid token'));}
});
io.on('connection', socket => { console.log(`[Socket] ${socket.user.username} connected`); });

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║        SleepyAfk is running!         ║`);
  console.log(`║   http://localhost:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  restoreRunningBots();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NEW FEATURES: Discord Webhooks, Multi On-Join, Auto-Respawn, Servers ─────
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Discord Webhook Helper ───────────────────────────────────────────────────
async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    const body = JSON.stringify(payload);
    const url = new URL(webhookUrl);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const req = mod.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        res.on('data', () => {}); res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
  } catch (err) { console.error('[Webhook] Failed:', err.message); }
}

// ─── Enhanced sendOnJoinCommands (multi-command with delays) ─────────────────
function sendOnJoinCommands(botId, bot, onJoinCommands) {
  // onJoinCommands is array of { command, delay } or legacy single string
  let cmds = [];
  if (typeof onJoinCommands === 'string') {
    if (onJoinCommands.trim()) cmds = [{ command: onJoinCommands.trim(), delay: 1500 }];
  } else if (Array.isArray(onJoinCommands)) {
    cmds = onJoinCommands.filter(c => c.command?.trim());
  }
  if (!cmds.length) return;
  cmds.forEach((c, i) => {
    const delayMs = (c.delay || 1500) + (i * 200); // stagger if no explicit delay
    setTimeout(() => {
      try {
        if (bot?.entity) {
          bot.chat(c.command.trim());
          addLog(botId, `⚡ On-join cmd ${i+1}: ${c.command.trim()}`, 'sent');
          const st = getStats(botId); st.messagesOut++; saveStats(botId, st);
        }
      } catch {}
    }, delayMs);
  });
}

// ─── Auto-Respawn ─────────────────────────────────────────────────────────────
function enableAutoRespawn(botId, bot) {
  bot.on('death', () => {
    addLog(botId, '💀 Bot died — respawning in 1s...', 'warn');
    setTimeout(() => {
      try { bot.respawn(); addLog(botId, '✅ Respawned', 'success'); } catch {}
    }, 1000);
  });
}

// ─── Servers (Pterodactyl) Storage ───────────────────────────────────────────
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
if (!fs.existsSync(SERVERS_FILE)) fs.writeFileSync(SERVERS_FILE, '[]');
function readServers()   { try { return JSON.parse(fs.readFileSync(SERVERS_FILE,'utf8')); } catch { return []; } }
function writeServers(d) { fs.writeFileSync(SERVERS_FILE, JSON.stringify(d, null, 2)); }

// Pterodactyl proxy routes — keeps API keys server-side, never exposed to browser
app.get('/api/servers', auth, (req, res) => {
  const servers = readServers().filter(s => s.owner === req.user.username);
  res.json(servers.map(s => ({ id: s.id, name: s.name, panelUrl: s.panelUrl, serverId: s.serverId, createdAt: s.createdAt })));
});

app.post('/api/servers', auth, (req, res) => {
  const { name, panelUrl, serverId, apiKey } = req.body;
  if (!name || !panelUrl || !serverId || !apiKey) return res.status(400).json({ error: 'name, panelUrl, serverId, apiKey required' });
  const servers = readServers();
  const ns = { id: Date.now().toString(), owner: req.user.username, name, panelUrl: panelUrl.replace(/\/$/, ''), serverId, apiKey, createdAt: new Date().toISOString() };
  servers.push(ns); writeServers(servers);
  res.json({ id: ns.id, name: ns.name, panelUrl: ns.panelUrl, serverId: ns.serverId, createdAt: ns.createdAt });
});

app.put('/api/servers/:id', auth, (req, res) => {
  const servers = readServers();
  const idx = servers.findIndex(s => s.id === req.params.id && s.owner === req.user.username);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { name, panelUrl, serverId, apiKey } = req.body;
  servers[idx] = { ...servers[idx], name: name||servers[idx].name, panelUrl: (panelUrl||servers[idx].panelUrl).replace(/\/$/, ''), serverId: serverId||servers[idx].serverId, apiKey: apiKey||servers[idx].apiKey };
  writeServers(servers);
  res.json({ id: servers[idx].id, name: servers[idx].name, panelUrl: servers[idx].panelUrl, serverId: servers[idx].serverId });
});

app.delete('/api/servers/:id', auth, (req, res) => {
  const servers = readServers();
  const idx = servers.findIndex(s => s.id === req.params.id && s.owner === req.user.username);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  servers.splice(idx, 1); writeServers(servers);
  res.json({ success: true });
});

// Proxy: get server status from Pterodactyl
app.get('/api/servers/:id/status', auth, async (req, res) => {
  const s = readServers().find(s => s.id === req.params.id && s.owner === req.user.username);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await fetch(`${s.panelUrl}/api/client/servers/${s.serverId}/resources`, {
      headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Accept': 'application/json' }
    });
    const data = await r.json();
    res.json(data);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// Proxy: power action
app.post('/api/servers/:id/power', auth, async (req, res) => {
  const s = readServers().find(s => s.id === req.params.id && s.owner === req.user.username);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const { signal } = req.body; // start | stop | restart | kill
  if (!['start','stop','restart','kill'].includes(signal)) return res.status(400).json({ error: 'Invalid signal' });
  try {
    const r = await fetch(`${s.panelUrl}/api/client/servers/${s.serverId}/power`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ signal })
    });
    res.json({ success: r.ok, status: r.status });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// Proxy: send console command
app.post('/api/servers/:id/command', auth, async (req, res) => {
  const s = readServers().find(s => s.id === req.params.id && s.owner === req.user.username);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const r = await fetch(`${s.panelUrl}/api/client/servers/${s.serverId}/command`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    res.json({ success: r.ok, status: r.status });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// Proxy: get server info
app.get('/api/servers/:id/info', auth, async (req, res) => {
  const s = readServers().find(s => s.id === req.params.id && s.owner === req.user.username);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await fetch(`${s.panelUrl}/api/client/servers/${s.serverId}`, {
      headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Accept': 'application/json' }
    });
    const data = await r.json();
    res.json(data);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// WebSocket token for Pterodactyl console (client gets this, then connects directly)
app.get('/api/servers/:id/ws-token', auth, async (req, res) => {
  const s = readServers().find(s => s.id === req.params.id && s.owner === req.user.username);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await fetch(`${s.panelUrl}/api/client/servers/${s.serverId}/websocket`, {
      headers: { 'Authorization': `Bearer ${s.apiKey}`, 'Accept': 'application/json' }
    });
    const data = await r.json();
    res.json(data); // contains { data: { socket, token } }
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ─── Discord webhook routes ────────────────────────────────────────────────────
app.post('/api/bots/:id/webhook-test', auth, async (req, res) => {
  const bot = readBots().find(b => b.id === req.params.id && b.owner === req.user.username);
  if (!bot || !bot.discordWebhook) return res.status(400).json({ error: 'No webhook configured' });
  await sendDiscordWebhook(bot.discordWebhook, {
    embeds: [{ title: '🧪 Webhook Test', description: `Webhook for **${bot.name}** is working!`, color: 0x00e5ff, timestamp: new Date().toISOString() }]
  });
  res.json({ success: true });
});
