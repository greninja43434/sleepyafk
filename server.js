'use strict';
const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const mineflayer     = require('mineflayer');
const mongoose       = require('mongoose');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const speakeasy      = require('speakeasy');
const QRCode         = require('qrcode');
const cron           = require('node-cron');
const session        = require('express-session');
const path           = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT                 = process.env.PORT                 || 3000;
const JWT_SECRET           = process.env.JWT_SECRET           || 'sleepyafk-secret-v5';
const SESSION_SECRET       = process.env.SESSION_SECRET       || 'sleepyafk-session-v5';
const MONGODB_URI          = process.env.MONGODB_URI          || 'mongodb+srv://rohithmenikonda1_db_user:sleepy123@sleeper.04ygzxi.mongodb.net/sleepyafk?appName=sleeper';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '665146660532-jta4bbg0l1koed1p97gvqgjc2n1g6rpf.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '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';
const APP_URL              = process.env.APP_URL              || 'http://localhost:3000';

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ─── Mongoose Models ──────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  username:         { type:String, unique:true, sparse:true },
  email:            { type:String, unique:true, sparse:true },
  googleId:         { type:String, unique:true, sparse:true },
  passwordHash:     String,
  role:             { type:String, enum:['admin','viewer'], default:'admin' },
  twoFactorSecret:  String,
  twoFactorEnabled: { type:Boolean, default:false },
  theme:            { type:String, default:'dark' },
  discordWebhook:   { type:String, default:'' },
  createdAt:        { type:Date, default:Date.now }
});
const User = mongoose.model('User', UserSchema);

const BotSchema = new mongoose.Schema({
  owner:String, name:String, host:String, port:Number,
  username:String, version:{type:String,default:''},
  color:{type:String,default:'#00e5ff'}, avatar:{type:String,default:'🤖'},
  antiAfk:{type:Object,default:{jumpEnabled:true,jumpInterval:30,walkEnabled:true,walkInterval:45,lookEnabled:true,lookInterval:20}},
  timedMessages:{type:Array,default:[]},
  autoRejoin:{type:Boolean,default:false}, autoLeave:{type:Boolean,default:false},
  onJoinCommand:{type:String,default:''}, onJoinCommands:{type:Array,default:[]},
  cycleEnabled:{type:Boolean,default:false}, cycleLeaveEvery:{type:Number,default:15}, cycleRejoinAfter:{type:Number,default:5},
  autoRespawn:{type:Boolean,default:false}, discordWebhook:{type:String,default:''},
  schedule:{type:Object,default:{enabled:false,startTime:'08:00',stopTime:'23:00'}},
  createdAt:{type:Date,default:Date.now}
});
const Bot = mongoose.model('Bot', BotSchema);

// MC Server Monitor — stores panel connection info server-side only
const ServerSchema = new mongoose.Schema({
  owner:String, name:String,
  host:String, port:{type:Number,default:25565},
  tags:{type:[String],default:[]},
  // Pterodactyl fields (stored securely, never sent to browser)
  panelUrl:{type:String,default:''},
  panelServerId:{type:String,default:''},
  panelApiKey:{type:String,default:''},
  // Alert settings
  alertWebhook:{type:String,default:''},
  playerJoinAlerts:{type:[String],default:[]},
  uptimeAlertMinutes:{type:Number,default:0},
  offlineSince:{type:Date,default:null},
  alertedOffline:{type:Boolean,default:false},
  createdAt:{type:Date,default:Date.now}
});
const ServerModel = mongoose.model('Server', ServerSchema);

const StatsSchema = new mongoose.Schema({
  botId:{type:String,unique:true},
  totalUptime:{type:Number,default:0}, sessionStart:{type:Number,default:null},
  kicks:{type:Number,default:0}, reconnects:{type:Number,default:0}, messagesOut:{type:Number,default:0},
  uptimeHistory:{type:Array,default:[]}
});
const Stats = mongoose.model('Stats', StatsSchema);

// ─── Stats helpers ────────────────────────────────────────────────────────────
async function recordUptimeTick(botId) {
  const now=Date.now();
  await Stats.updateOne({botId},{$push:{uptimeHistory:{$each:[{t:now,online:1}],$slice:-1440}},$inc:{totalUptime:60}},{upsert:true});
}
async function recordDowntimeTick(botId) {
  const now=Date.now();
  await Stats.updateOne({botId},{$push:{uptimeHistory:{$each:[{t:now,online:0}],$slice:-1440}}},{upsert:true});
}

// ─── Passport / Google OAuth ──────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:GOOGLE_CLIENT_ID, clientSecret:GOOGLE_CLIENT_SECRET,
  callbackURL:`${APP_URL}/auth/google/callback`
}, async(at,rt,profile,done)=>{
  try {
    let user=await User.findOne({googleId:profile.id});
    if(!user){
      const email=profile.emails?.[0]?.value;
      user=await User.findOne({email});
      if(user){user.googleId=profile.id;await user.save();}
      else{
        const base=(profile.displayName||'user').replace(/\s+/g,'').toLowerCase().slice(0,16);
        let uname=base,n=1;
        while(await User.findOne({username:uname}))uname=base+(n++);
        user=await User.create({googleId:profile.id,email,username:uname,role:'admin'});
      }
    }
    return done(null,user);
  }catch(e){return done(e);}
}));
passport.serializeUser((u,done)=>done(null,u._id));
passport.deserializeUser(async(id,done)=>{try{const u=await User.findById(id);done(null,u);}catch(e){done(e);}});

// ─── Active Bot Runtime ───────────────────────────────────────────────────────
const activeBots=new Map();
const uptimeTickers=new Map();
function startUptimeTicker(id){stopUptimeTicker(id);uptimeTickers.set(id,setInterval(()=>recordUptimeTick(id),60000));}
function stopUptimeTicker(id){if(uptimeTickers.has(id)){clearInterval(uptimeTickers.get(id));uptimeTickers.delete(id);}}

function addLog(botId,message,type='info'){
  const rt=activeBots.get(botId);
  const entry={time:new Date().toISOString(),message,type};
  if(rt){rt.logs.push(entry);if(rt.logs.length>500)rt.logs.shift();}
  io.emit('bot:log',{botId,entry});
  io.emit('home:activity',{botId,entry});
}

async function sendWebhook(url,payload){
  if(!url)return;
  try{await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}catch{}
}

function startAntiAfk(botId,bot,cfg){
  const iv=[];
  if(cfg.jumpEnabled&&cfg.jumpInterval>0)iv.push(setInterval(()=>{try{if(bot?.entity){bot.setControlState('jump',true);setTimeout(()=>bot.setControlState('jump',false),300);addLog(botId,'🦘 Anti-AFK: jumped','afk');}}catch{}},cfg.jumpInterval*1000));
  if(cfg.walkEnabled&&cfg.walkInterval>0)iv.push(setInterval(()=>{try{if(bot?.entity){const d=['forward','back','left','right'][Math.floor(Math.random()*4)];bot.setControlState(d,true);setTimeout(()=>bot.setControlState(d,false),800+Math.random()*400);addLog(botId,`🚶 Anti-AFK: walked ${d}`,'afk');}}catch{}},cfg.walkInterval*1000));
  if(cfg.lookEnabled&&cfg.lookInterval>0)iv.push(setInterval(()=>{try{if(bot?.entity){bot.look((Math.random()*Math.PI*2)-Math.PI,(Math.random()*Math.PI/2)-Math.PI/4,false);addLog(botId,'👀 Anti-AFK: looked','afk');}}catch{}},cfg.lookInterval*1000));
  return iv;
}

function startTimedMessages(botId,bot,msgs){
  const iv=[];
  if(!Array.isArray(msgs))return iv;
  msgs.forEach(tm=>{
    if(!tm.enabled||!tm.message?.trim())return;
    const ms=((parseInt(tm.hours)||0)*3600+(parseInt(tm.minutes)||0)*60+(parseInt(tm.seconds)||0))*1000;
    if(ms<5000){addLog(botId,`⚠️ Skipped "${tm.message}" — too short`,'warn');return;}
    iv.push(setInterval(()=>{try{if(bot?.entity){bot.chat(tm.message.trim());addLog(botId,`${tm.message.trim().startsWith('/')?'⚡ Command':'📢 Timed'}: ${tm.message.trim()}`,'timed');Stats.updateOne({botId},{$inc:{messagesOut:1}},{upsert:true}).catch(()=>{});}}catch{}},ms));
  });
  return iv;
}

function stopIvs(arr){if(arr)arr.forEach(id=>clearInterval(id));}

function scheduleCycle(botId,cfg){
  const rt=activeBots.get(botId);
  if(!rt||!cfg.cycleEnabled)return;
  addLog(botId,`🔁 Cycle: leave in ${cfg.cycleLeaveEvery||15}m, rejoin after ${cfg.cycleRejoinAfter||5}s`,'info');
  rt.cycleTimeout=setTimeout(async()=>{
    const r=activeBots.get(botId);if(!r||r.stopping)return;
    addLog(botId,'🔁 Cycle leave','warn');
    stopIvs(r.afkIvs);stopIvs(r.msgIvs);
    if(r.cycleTimeout)clearTimeout(r.cycleTimeout);
    if(r.statsPoller)clearInterval(r.statsPoller);
    if(r.watchdog)clearInterval(r.watchdog);
    try{r.bot.quit('cycle');}catch{}
    activeBots.delete(botId);stopUptimeTicker(botId);
    io.emit('bot:statusChange',{botId,status:'offline'});
    setTimeout(async()=>{
      const fresh=await Bot.findById(botId).catch(()=>null);
      if(fresh&&!activeBots.has(botId)){addLog(botId,'🔁 Cycle rejoin','info');startBot(fresh);}
    },(cfg.cycleRejoinAfter||5)*1000);
  },(cfg.cycleLeaveEvery||15)*60000);
}

function sendOnJoinCommands(botId,bot,cmds,legacy){
  let list=[];
  if(Array.isArray(cmds)&&cmds.length)list=cmds.filter(c=>c.command?.trim());
  else if(typeof legacy==='string'&&legacy.trim())list=[{command:legacy.trim(),delay:1500}];
  list.forEach((c,i)=>setTimeout(()=>{try{if(bot?.entity){bot.chat(c.command.trim());addLog(botId,`⚡ On-join ${i+1}: ${c.command.trim()}`,'sent');}}catch{}},c.delay||1500+(i*200)));
}

function enableAutoRespawn(botId,bot){
  bot.on('death',()=>{addLog(botId,'💀 Bot died — respawning...','warn');setTimeout(()=>{try{bot.respawn();addLog(botId,'✅ Respawned','success');}catch{}},1000);});
}

async function startBot(botDoc){
  const id=botDoc._id.toString();
  if(activeBots.has(id)){addLog(id,'⚠️ Already running','warn');return;}
  const cfg=botDoc.toObject?botDoc.toObject():botDoc;
  const {host,port,username,version,antiAfk,timedMessages,autoRejoin,autoLeave,onJoinCommand,onJoinCommands,cycleEnabled,cycleLeaveEvery,cycleRejoinAfter,autoRespawn,discordWebhook}=cfg;
  addLog(id,`🔌 Connecting to ${host}:${port} as ${username}...`,'info');
  io.emit('bot:statusChange',{botId:id,status:'connecting'});
  let bot;
  try{bot=mineflayer.createBot({host,port:parseInt(port,10),username,version:version||false,auth:'offline',hideErrors:false});}
  catch(err){addLog(id,`❌ Failed: ${err.message}`,'error');io.emit('bot:statusChange',{botId:id,status:'error'});return;}
  const rt={bot,afkIvs:[],msgIvs:[],cycleTimeout:null,statsPoller:null,watchdog:null,logs:activeBots.get(id)?.logs||[],stopping:false};
  activeBots.set(id,rt);
  Stats.findOneAndUpdate({botId:id},{$inc:{reconnects:1},$set:{sessionStart:Date.now()}},{upsert:true,new:true}).catch(()=>{});
  bot.once('spawn',()=>{
    addLog(id,`✅ Spawned on ${host}:${port}`,'success');
    io.emit('bot:statusChange',{botId:id,status:'online'});
    rt.afkIvs=startAntiAfk(id,bot,antiAfk||{});
    rt.msgIvs=startTimedMessages(id,bot,timedMessages||[]);
    sendOnJoinCommands(id,bot,onJoinCommands,onJoinCommand);
    if(autoRespawn)enableAutoRespawn(id,bot);
    scheduleCycle(id,cfg);
    startUptimeTicker(id);
    if(discordWebhook)sendWebhook(discordWebhook,{embeds:[{title:'✅ Bot Online',description:`**${username}** connected to \`${host}:${port}\``,color:0x00ff88,timestamp:new Date().toISOString(),footer:{text:'SleepyAfk'}}]});
    rt.statsPoller=setInterval(()=>{try{if(!activeBots.has(id)){clearInterval(rt.statsPoller);return;}if(bot?.entity&&bot.health!==undefined)io.emit('bot:stats',{botId:id,health:Math.round(bot.health??0),food:Math.round(bot.food??0),ping:bot.player?.ping??0});}catch{}},3000);
    rt.watchdog=setInterval(()=>{try{if(!activeBots.has(id)){clearInterval(rt.watchdog);return;}if(bot?.state==='disconnected'||bot?.state==='errored'||(!bot?.entity&&bot?._client?.socket?.destroyed)){clearInterval(rt.watchdog);const r2=activeBots.get(id);if(r2)handleDisconnect('❌ Connection lost','server unreachable');}}catch{}},8000);
  });
  bot.on('chat',(u,m)=>addLog(id,`💬 <${u}> ${m}`,'chat'));
  bot.on('whisper',(u,m)=>addLog(id,`📩 [Whisper] <${u}> ${m}`,'chat'));
  bot.on('health',()=>{try{io.emit('bot:stats',{botId:id,health:Math.round(bot.health??0),food:Math.round(bot.food??0),ping:bot.player?.ping??0});}catch{}});
  function handleDisconnect(label,reason){
    const r=activeBots.get(id);if(!r)return;
    addLog(id,`${label}: ${reason||'ended'}`,'error');
    stopIvs(r.afkIvs);stopIvs(r.msgIvs);
    if(r.cycleTimeout)clearTimeout(r.cycleTimeout);
    if(r.statsPoller)clearInterval(r.statsPoller);
    if(r.watchdog)clearInterval(r.watchdog);
    activeBots.delete(id);stopUptimeTicker(id);
    recordDowntimeTick(id).catch(()=>{});
    Stats.updateOne({botId:id},{$set:{sessionStart:null}},{upsert:true}).catch(()=>{});
    io.emit('bot:statusChange',{botId:id,status:'offline'});
    if(r.stopping)return;
    if(discordWebhook)sendWebhook(discordWebhook,{embeds:[{title:'🔴 Bot Offline',description:`**${username}** disconnected from \`${host}:${port}\``,color:0xff4757,timestamp:new Date().toISOString(),footer:{text:'SleepyAfk'}}]});
    if(autoRejoin){addLog(id,'🔄 Auto-rejoin in 5s...','warn');setTimeout(async()=>{const f=await Bot.findById(id).catch(()=>null);if(f&&!activeBots.has(id))startBot(f);},5000);}
  }
  bot.on('kicked',reason=>{
    let msg=reason;try{msg=JSON.parse(reason)?.text||JSON.stringify(JSON.parse(reason));}catch{}
    Stats.updateOne({botId:id},{$inc:{kicks:1}},{upsert:true}).catch(()=>{});
    if(discordWebhook)sendWebhook(discordWebhook,{embeds:[{title:'👢 Bot Kicked',description:`**${username}** kicked from \`${host}:${port}\`\n\`${msg}\``,color:0xff6b35,timestamp:new Date().toISOString(),footer:{text:'SleepyAfk'}}]});
    if(autoLeave){const r=activeBots.get(id);if(r){stopIvs(r.afkIvs);stopIvs(r.msgIvs);if(r.cycleTimeout)clearTimeout(r.cycleTimeout);if(r.statsPoller)clearInterval(r.statsPoller);if(r.watchdog)clearInterval(r.watchdog);}activeBots.delete(id);stopUptimeTicker(id);io.emit('bot:statusChange',{botId:id,status:'offline'});return;}
    handleDisconnect('👢 Kicked',msg);
  });
  bot.on('error',err=>handleDisconnect('❌ Error',err.message));
  bot.on('end',reason=>{const r=activeBots.get(id);handleDisconnect(r?.stopping?'🔴 Stopped':'🔴 Disconnected',reason);});
}

function stopBotById(botId){
  const rt=activeBots.get(botId);if(!rt)return;
  rt.stopping=true;
  addLog(botId,'🛑 Stopping...','warn');
  stopIvs(rt.afkIvs);stopIvs(rt.msgIvs);
  if(rt.cycleTimeout)clearTimeout(rt.cycleTimeout);
  if(rt.statsPoller)clearInterval(rt.statsPoller);
  if(rt.watchdog)clearInterval(rt.watchdog);
  try{rt.bot.quit('User stopped');}catch{}
  activeBots.delete(botId);stopUptimeTicker(botId);
  io.emit('bot:statusChange',{botId:botId,status:'offline'});
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
app.use(session({secret:SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{secure:false,maxAge:10*60*1000}}));
app.use(passport.initialize());
app.use(passport.session());

function auth(req,res,next){
  const t=req.headers.authorization?.split(' ')[1];
  if(!t)return res.status(401).json({error:'No token'});
  try{req.user=jwt.verify(t,JWT_SECRET);next();}catch{res.status(401).json({error:'Invalid token'});}
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────
app.get('/auth/google',passport.authenticate('google',{scope:['profile','email']}));
app.get('/auth/google/callback',passport.authenticate('google',{failureRedirect:'/'}),(req,res)=>{
  const token=jwt.sign({id:req.user._id.toString(),username:req.user.username,role:req.user.role},JWT_SECRET,{expiresIn:'7d'});
  res.redirect(`/auth/success.html?token=${token}&username=${encodeURIComponent(req.user.username)}`);
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/register',async(req,res)=>{
  const {username,password}=req.body;
  if(!username||!password)return res.status(400).json({error:'Required'});
  if(username.length<3)return res.status(400).json({error:'Username min 3 chars'});
  if(password.length<6)return res.status(400).json({error:'Password min 6 chars'});
  if(await User.findOne({username}))return res.status(409).json({error:'Username taken'});
  const passwordHash=await bcrypt.hash(password,10);
  const user=await User.create({username,passwordHash,role:'admin'});
  res.json({token:jwt.sign({id:user._id.toString(),username:user.username,role:user.role},JWT_SECRET,{expiresIn:'7d'}),username:user.username});
});

app.post('/api/login',async(req,res)=>{
  const {username,password,twoFactorCode}=req.body;
  const user=await User.findOne({username});
  if(!user||!user.passwordHash)return res.status(401).json({error:'Invalid credentials'});
  if(!await bcrypt.compare(password,user.passwordHash))return res.status(401).json({error:'Invalid credentials'});
  if(user.twoFactorEnabled){
    if(!twoFactorCode)return res.json({twoFactorRequired:true});
    const valid=speakeasy.totp.verify({secret:user.twoFactorSecret,encoding:'base32',token:twoFactorCode,window:2});
    if(!valid)return res.status(401).json({error:'Invalid 2FA code'});
  }
  res.json({token:jwt.sign({id:user._id.toString(),username:user.username,role:user.role},JWT_SECRET,{expiresIn:'7d'}),username:user.username,theme:user.theme||'dark'});
});

// ─── Account Routes ───────────────────────────────────────────────────────────
app.get('/api/account',auth,async(req,res)=>{
  const user=await User.findById(req.user.id).select('-passwordHash -twoFactorSecret');
  if(!user)return res.status(404).json({error:'Not found'});
  res.json(user);
});
app.put('/api/account/password',auth,async(req,res)=>{
  const {currentPassword,newPassword}=req.body;
  if(!newPassword||newPassword.length<6)return res.status(400).json({error:'New password min 6 chars'});
  const user=await User.findById(req.user.id);
  if(user.passwordHash&&(!currentPassword||!await bcrypt.compare(currentPassword,user.passwordHash)))return res.status(401).json({error:'Current password wrong'});
  user.passwordHash=await bcrypt.hash(newPassword,10);await user.save();
  res.json({success:true});
});
app.put('/api/account/theme',auth,async(req,res)=>{
  const {theme}=req.body;
  if(!['dark','dim','light'].includes(theme))return res.status(400).json({error:'Invalid theme'});
  await User.updateOne({_id:req.user.id},{theme});res.json({success:true,theme});
});
app.put('/api/account/webhook',auth,async(req,res)=>{
  const {discordWebhook}=req.body;
  await User.updateOne({_id:req.user.id},{discordWebhook:discordWebhook||''});res.json({success:true});
});
app.post('/api/account/2fa/setup',auth,async(req,res)=>{
  const user=await User.findById(req.user.id);
  const secret=speakeasy.generateSecret({name:`SleepyAfk (${user.username})`});
  user.twoFactorSecret=secret.base32;await user.save();
  const qrUrl=await QRCode.toDataURL(secret.otpauth_url);
  res.json({secret:secret.base32,qrUrl});
});
app.post('/api/account/2fa/enable',auth,async(req,res)=>{
  const {code}=req.body;const user=await User.findById(req.user.id);
  if(!user.twoFactorSecret)return res.status(400).json({error:'Setup 2FA first'});
  const valid=speakeasy.totp.verify({secret:user.twoFactorSecret,encoding:'base32',token:code,window:2});
  if(!valid)return res.status(400).json({error:'Invalid code'});
  user.twoFactorEnabled=true;await user.save();res.json({success:true});
});
app.post('/api/account/2fa/disable',auth,async(req,res)=>{
  const {code}=req.body;const user=await User.findById(req.user.id);
  if(user.twoFactorEnabled){
    const valid=speakeasy.totp.verify({secret:user.twoFactorSecret,encoding:'base32',token:code,window:2});
    if(!valid)return res.status(400).json({error:'Invalid code'});
  }
  user.twoFactorEnabled=false;user.twoFactorSecret='';await user.save();res.json({success:true});
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats',auth,async(req,res)=>{
  const bots=await Bot.find({owner:req.user.username});
  const result={};
  for(const b of bots){
    const id=b._id.toString();
    const st=await Stats.findOne({botId:id})||{totalUptime:0,kicks:0,reconnects:0,messagesOut:0,uptimeHistory:[]};
    const isOnline=activeBots.has(id);
    let currentSession=0;
    if(isOnline&&st.sessionStart)currentSession=Math.floor((Date.now()-st.sessionStart)/1000);
    result[id]={...(st.toObject?.()??st),isOnline,currentSession};
  }
  res.json(result);
});

// ─── Bot Routes ───────────────────────────────────────────────────────────────
function defaultTimedMsgs(){return Array.from({length:3},(_,i)=>({id:(Date.now()+i).toString(),enabled:false,message:'',hours:0,minutes:5,seconds:0}));}

app.get('/api/bots',auth,async(req,res)=>{
  const bots=await Bot.find({owner:req.user.username});
  res.json(bots.map(b=>({...b.toObject(),id:b._id.toString(),status:activeBots.has(b._id.toString())?'online':'offline',logs:activeBots.get(b._id.toString())?.logs||[]})));
});
app.post('/api/bots',auth,async(req,res)=>{
  const {name,host,port,username,version,antiAfk,timedMessages,autoRejoin,autoLeave,onJoinCommand,onJoinCommands,cycleEnabled,cycleLeaveEvery,cycleRejoinAfter,autoRespawn,discordWebhook,color,avatar,schedule}=req.body;
  if(!name||!host||!port||!username)return res.status(400).json({error:'name/host/port/username required'});
  const b=await Bot.create({owner:req.user.username,name,host,port:parseInt(port,10),username,version:version||'',
    antiAfk:antiAfk||{jumpEnabled:true,jumpInterval:30,walkEnabled:true,walkInterval:45,lookEnabled:true,lookInterval:20},
    timedMessages:timedMessages||defaultTimedMsgs(),autoRejoin:!!autoRejoin,autoLeave:!!autoLeave,
    onJoinCommand:onJoinCommand||'',onJoinCommands:onJoinCommands||[],
    cycleEnabled:!!cycleEnabled,cycleLeaveEvery:cycleLeaveEvery||15,cycleRejoinAfter:cycleRejoinAfter||5,
    autoRespawn:!!autoRespawn,discordWebhook:discordWebhook||'',
    color:color||'#00e5ff',avatar:avatar||'🤖',
    schedule:schedule||{enabled:false,startTime:'08:00',stopTime:'23:00'}});
  res.json({...b.toObject(),id:b._id.toString()});
});
app.put('/api/bots/:id',auth,async(req,res)=>{
  const b=await Bot.findOne({_id:req.params.id,owner:req.user.username});
  if(!b)return res.status(404).json({error:'Not found'});
  const {name,host,port,username,version,antiAfk,timedMessages,autoRejoin,autoLeave,onJoinCommand,onJoinCommands,cycleEnabled,cycleLeaveEvery,cycleRejoinAfter,autoRespawn,discordWebhook,color,avatar,schedule}=req.body;
  Object.assign(b,{name,host,port:parseInt(port,10),username,version:version||'',antiAfk,timedMessages,autoRejoin:!!autoRejoin,autoLeave:!!autoLeave,onJoinCommand:onJoinCommand||'',onJoinCommands:onJoinCommands||[],cycleEnabled:!!cycleEnabled,cycleLeaveEvery:cycleLeaveEvery||15,cycleRejoinAfter:cycleRejoinAfter||5,autoRespawn:!!autoRespawn,discordWebhook:discordWebhook||'',color:color||'#00e5ff',avatar:avatar||'🤖',schedule:schedule||b.schedule});
  await b.save();
  const id=b._id.toString();const rt=activeBots.get(id);
  if(rt){stopIvs(rt.afkIvs);stopIvs(rt.msgIvs);if(rt.cycleTimeout)clearTimeout(rt.cycleTimeout);rt.afkIvs=startAntiAfk(id,rt.bot,antiAfk||{});rt.msgIvs=startTimedMessages(id,rt.bot,timedMessages||[]);scheduleCycle(id,b.toObject());addLog(id,'⚙️ Settings applied live','info');}
  res.json({...b.toObject(),id});
});
app.delete('/api/bots/:id',auth,async(req,res)=>{
  const b=await Bot.findOne({_id:req.params.id,owner:req.user.username});
  if(!b)return res.status(404).json({error:'Not found'});
  const id=b._id.toString();if(activeBots.has(id))stopBotById(id);
  await b.deleteOne();res.json({success:true});
});
app.post('/api/bots/:id/start',auth,async(req,res)=>{const b=await Bot.findOne({_id:req.params.id,owner:req.user.username});if(!b)return res.status(404).json({error:'Not found'});startBot(b);res.json({success:true});});
app.post('/api/bots/:id/stop',auth,async(req,res)=>{const b=await Bot.findOne({_id:req.params.id,owner:req.user.username});if(!b)return res.status(404).json({error:'Not found'});stopBotById(b._id.toString());res.json({success:true});});
app.post('/api/bots/:id/chat',auth,async(req,res)=>{
  const {message}=req.body;if(!message)return res.status(400).json({error:'Message required'});
  const b=await Bot.findOne({_id:req.params.id,owner:req.user.username});if(!b)return res.status(404).json({error:'Not found'});
  const id=b._id.toString();const rt=activeBots.get(id);if(!rt)return res.status(400).json({error:'Not running'});
  try{rt.bot.chat(message);addLog(id,`📤 [You] ${message}`,'sent');Stats.updateOne({botId:id},{$inc:{messagesOut:1}},{upsert:true}).catch(()=>{});res.json({success:true});}
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/bots/:id/clone',auth,async(req,res)=>{
  const b=await Bot.findOne({_id:req.params.id,owner:req.user.username});if(!b)return res.status(404).json({error:'Not found'});
  const clone=b.toObject();delete clone._id;delete clone.__v;clone.name=clone.name+' (Copy)';clone.createdAt=new Date();
  const nb=await Bot.create(clone);res.json({...nb.toObject(),id:nb._id.toString()});
});
app.get('/api/bots/:id/export',auth,async(req,res)=>{
  const b=await Bot.findOne({_id:req.params.id,owner:req.user.username});if(!b)return res.status(404).json({error:'Not found'});
  const exp=b.toObject();delete exp._id;delete exp.__v;delete exp.owner;delete exp.discordWebhook;res.json(exp);
});
app.post('/api/bots/import',auth,async(req,res)=>{
  const cfg=req.body;if(!cfg.name||!cfg.host||!cfg.port||!cfg.username)return res.status(400).json({error:'Invalid config'});
  delete cfg._id;delete cfg.__v;delete cfg.id;cfg.owner=req.user.username;cfg.createdAt=new Date();cfg.discordWebhook='';
  const nb=await Bot.create(cfg);res.json({...nb.toObject(),id:nb._id.toString()});
});
app.post('/api/bots/:id/webhook-test',auth,async(req,res)=>{
  const b=await Bot.findOne({_id:req.params.id,owner:req.user.username});
  if(!b||!b.discordWebhook)return res.status(400).json({error:'No webhook configured'});
  await sendWebhook(b.discordWebhook,{embeds:[{title:'🧪 Webhook Test',description:`Webhook for **${b.name}** is working!`,color:0x00e5ff,timestamp:new Date().toISOString(),footer:{text:'SleepyAfk'}}]});
  res.json({success:true});
});

// ─── Server Monitor Routes ────────────────────────────────────────────────────
app.get('/api/servers',auth,async(req,res)=>{
  const servers=await ServerModel.find({owner:req.user.username});
  // Strip API key before sending to browser
  res.json(servers.map(s=>({id:s._id.toString(),name:s.name,host:s.host,port:s.port,tags:s.tags,
    hasPterodactyl:!!(s.panelUrl&&s.panelServerId&&s.panelApiKey),
    alertWebhook:s.alertWebhook,playerJoinAlerts:s.playerJoinAlerts,uptimeAlertMinutes:s.uptimeAlertMinutes,
    createdAt:s.createdAt})));
});
app.post('/api/servers',auth,async(req,res)=>{
  const {name,host,port,tags,panelUrl,panelServerId,panelApiKey,alertWebhook,playerJoinAlerts,uptimeAlertMinutes}=req.body;
  if(!name||!host)return res.status(400).json({error:'name and host required'});
  const s=await ServerModel.create({owner:req.user.username,name,host:host.trim(),port:parseInt(port)||25565,
    tags:tags||[],panelUrl:(panelUrl||'').trim().replace(/\/$/,''),panelServerId:(panelServerId||'').trim(),panelApiKey:(panelApiKey||'').trim(),
    alertWebhook:alertWebhook||'',playerJoinAlerts:playerJoinAlerts||[],uptimeAlertMinutes:parseInt(uptimeAlertMinutes)||0});
  res.json({id:s._id.toString(),name:s.name,host:s.host,port:s.port,tags:s.tags,hasPterodactyl:!!(s.panelUrl&&s.panelServerId&&s.panelApiKey)});
});
app.put('/api/servers/:id',auth,async(req,res)=>{
  const s=await ServerModel.findOne({_id:req.params.id,owner:req.user.username});
  if(!s)return res.status(404).json({error:'Not found'});
  const {name,host,port,tags,panelUrl,panelServerId,panelApiKey,alertWebhook,playerJoinAlerts,uptimeAlertMinutes}=req.body;
  s.name=name||s.name;s.host=(host||s.host).trim();s.port=parseInt(port)||s.port;s.tags=tags||s.tags;
  if(panelUrl!==undefined)s.panelUrl=panelUrl.trim().replace(/\/$/,'');
  if(panelServerId!==undefined)s.panelServerId=panelServerId.trim();
  if(panelApiKey&&panelApiKey.trim())s.panelApiKey=panelApiKey.trim(); // only update if provided
  s.alertWebhook=alertWebhook||'';s.playerJoinAlerts=playerJoinAlerts||[];s.uptimeAlertMinutes=parseInt(uptimeAlertMinutes)||0;
  await s.save();
  res.json({id:s._id.toString(),name:s.name,host:s.host,port:s.port,tags:s.tags,hasPterodactyl:!!(s.panelUrl&&s.panelServerId&&s.panelApiKey)});
});
app.delete('/api/servers/:id',auth,async(req,res)=>{
  const s=await ServerModel.findOne({_id:req.params.id,owner:req.user.username});
  if(!s)return res.status(404).json({error:'Not found'});
  await s.deleteOne();res.json({success:true});
});

// Ping (MC status API) with alert logic
app.get('/api/servers/:id/ping',auth,async(req,res)=>{
  const s=await ServerModel.findOne({_id:req.params.id,owner:req.user.username});
  if(!s)return res.status(404).json({error:'Not found'});
  try{
    const r=await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(s.host)}:${s.port}`,{headers:{'User-Agent':'SleepyAfk/5.0'}});
    const data=await r.json();
    if(!data.online){
      if(!s.offlineSince){s.offlineSince=new Date();s.alertedOffline=false;await s.save();}
      else if(s.uptimeAlertMinutes>0&&!s.alertedOffline){
        const minOff=Math.floor((Date.now()-s.offlineSince)/60000);
        if(minOff>=s.uptimeAlertMinutes&&s.alertWebhook){
          await sendWebhook(s.alertWebhook,{embeds:[{title:'🔴 Server Offline Alert',description:`**${s.name}** has been offline for **${minOff} minutes**`,color:0xff4757,timestamp:new Date().toISOString(),footer:{text:'SleepyAfk'}}]});
          s.alertedOffline=true;await s.save();
        }
      }
    }else{
      if(s.offlineSince){
        if(s.alertWebhook&&s.alertedOffline){const d=Math.floor((Date.now()-s.offlineSince)/60000);await sendWebhook(s.alertWebhook,{embeds:[{title:'✅ Server Back Online',description:`**${s.name}** is back online after **${d}m** of downtime`,color:0x00ff88,timestamp:new Date().toISOString(),footer:{text:'SleepyAfk'}}]});}
        s.offlineSince=null;s.alertedOffline=false;await s.save();
      }
      if(s.playerJoinAlerts?.length&&s.alertWebhook&&data.players?.list){
        const cur=(data.players.list||[]).map(p=>typeof p==='string'?p:(p.name||''));
        const watching=s.playerJoinAlerts.map(n=>n.toLowerCase());
        cur.forEach(async name=>{if(watching.includes(name.toLowerCase()))await sendWebhook(s.alertWebhook,{embeds:[{title:'👤 Player Joined',description:`**${name}** joined **${s.name}**`,color:0xc77dff,timestamp:new Date().toISOString(),footer:{text:'SleepyAfk'}}]});});
      }
    }
    res.json(data);
  }catch(e){res.status(502).json({error:e.message,online:false});}
});

// ─── Pterodactyl Proxy Routes (API key stays server-side) ─────────────────────
async function pterodactylReq(s, method, endpoint, body) {
  const url = `${s.panelUrl}/api/client/servers/${s.panelServerId}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${s.panelApiKey}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return { ok: r.ok, status: r.status, data: r.status === 204 ? null : await r.json().catch(() => null) };
}

// Get server resources (CPU/RAM/Disk/Uptime/State)
app.get('/api/servers/:id/pterodactyl/resources', auth, async (req, res) => {
  const s = await ServerModel.findOne({ _id: req.params.id, owner: req.user.username });
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (!s.panelUrl || !s.panelServerId || !s.panelApiKey) return res.status(400).json({ error: 'No Pterodactyl configured' });
  try {
    const { ok, data } = await pterodactylReq(s, 'GET', '/resources');
    if (!ok) return res.status(502).json({ error: 'Panel returned error', data });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Power action
app.post('/api/servers/:id/pterodactyl/power', auth, async (req, res) => {
  const s = await ServerModel.findOne({ _id: req.params.id, owner: req.user.username });
  if (!s || !s.panelUrl) return res.status(404).json({ error: 'Not found or no panel' });
  const { signal } = req.body;
  if (!['start', 'stop', 'restart', 'kill'].includes(signal)) return res.status(400).json({ error: 'Invalid signal' });
  try {
    const { ok, status } = await pterodactylReq(s, 'POST', '/power', { signal });
    res.json({ success: ok, status });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Send console command
app.post('/api/servers/:id/pterodactyl/command', auth, async (req, res) => {
  const s = await ServerModel.findOne({ _id: req.params.id, owner: req.user.username });
  if (!s || !s.panelUrl) return res.status(404).json({ error: 'Not found or no panel' });
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const { ok, status } = await pterodactylReq(s, 'POST', '/command', { command });
    res.json({ success: ok, status });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Get WebSocket token (browser connects directly to BisectHosting WS)
app.get('/api/servers/:id/pterodactyl/ws', auth, async (req, res) => {
  const s = await ServerModel.findOne({ _id: req.params.id, owner: req.user.username });
  if (!s || !s.panelUrl) return res.status(404).json({ error: 'Not found or no panel' });
  try {
    const { ok, data } = await pterodactylReq(s, 'GET', '/websocket');
    if (!ok || !data?.data) return res.status(502).json({ error: 'Could not get WS token' });
    res.json(data.data); // { socket, token }
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── Public Status Page ───────────────────────────────────────────────────────
app.get('/api/public/:username',async(req,res)=>{
  const user=await User.findOne({username:req.params.username}).select('username');
  if(!user)return res.status(404).json({error:'Not found'});
  const bots=await Bot.find({owner:req.params.username}).select('name host port username color avatar');
  const servers=await ServerModel.find({owner:req.params.username}).select('name host port tags');
  res.json({username:user.username,
    bots:bots.map(b=>({id:b._id.toString(),name:b.name,host:b.host,port:b.port,username:b.username,color:b.color,avatar:b.avatar,online:activeBots.has(b._id.toString())})),
    servers:servers.map(s=>({...s.toObject(),id:s._id.toString()}))});
});

// ─── Socket ───────────────────────────────────────────────────────────────────
io.use((socket,next)=>{
  const t=socket.handshake.auth?.token;
  if(!t)return next(new Error('Unauthorized'));
  try{socket.user=jwt.verify(t,JWT_SECRET);next();}catch{next(new Error('Invalid token'));}
});
io.on('connection',socket=>console.log(`[Socket] ${socket.user.username} connected`));

// ─── Cron: Bot Scheduling ─────────────────────────────────────────────────────
cron.schedule('* * * * *',async()=>{
  try{
    const now=new Date();
    const t=`${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;
    const bots=await Bot.find({'schedule.enabled':true});
    for(const b of bots){
      const id=b._id.toString();
      if(b.schedule.startTime===t&&!activeBots.has(id)){addLog(id,'⏰ Scheduled start','info');startBot(b);}
      if(b.schedule.stopTime===t&&activeBots.has(id)){addLog(id,'⏰ Scheduled stop','info');stopBotById(id);}
    }
  }catch{}
});

// ─── Cron: Daily Summary ──────────────────────────────────────────────────────
cron.schedule('0 0 * * *',async()=>{
  try{
    const users=await User.find({discordWebhook:{$ne:''}});
    for(const user of users){
      const bots=await Bot.find({owner:user.username});
      let totalKicks=0,totalReconnects=0,totalMessages=0,onlineBots=0;
      for(const b of bots){
        const id=b._id.toString();
        const st=await Stats.findOne({botId:id});
        if(st){totalKicks+=st.kicks||0;totalReconnects+=st.reconnects||0;totalMessages+=st.messagesOut||0;}
        if(activeBots.has(id))onlineBots++;
      }
      await sendWebhook(user.discordWebhook,{embeds:[{title:`📊 Daily Summary — ${user.username}`,color:0x00e5ff,fields:[
        {name:'🤖 Bots',value:`${onlineBots}/${bots.length} online`,inline:true},
        {name:'👢 Kicks',value:String(totalKicks),inline:true},
        {name:'🔄 Reconnects',value:String(totalReconnects),inline:true},
        {name:'📢 Messages Sent',value:String(totalMessages),inline:true},
      ],timestamp:new Date().toISOString(),footer:{text:'SleepyAfk Daily Digest'}}]});
    }
  }catch(e){console.error('Daily summary:',e.message);}
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT,async()=>{
  try{await mongoose.connect(MONGODB_URI);console.log('✅ MongoDB connected');}
  catch(e){console.error('❌ MongoDB:',e.message);}
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║     SleepyAfk v5 is running! 🚀      ║`);
  console.log(`║   http://localhost:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});
