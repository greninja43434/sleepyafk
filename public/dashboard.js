// ─── State ────────────────────────────────────────────────────────────────────

let token    = localStorage.getItem('afk_token');
let username = localStorage.getItem('afk_username');
let bots = [];
let selectedBotId    = null;
let editingBotId     = null;
let socket           = null;
let liveConfigDebounce = null;

if (!token) window.location.href = '/';
document.getElementById('topbarUser').textContent = username || '—';

// ─── API Helper ───────────────────────────────────────────────────────────────

async function api(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { logout(); return null; }
    return res.json();
  } catch (err) {
    console.error('API error:', err);
    return null;
  }
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('bot:log', ({ botId, entry }) => {
    const bot = bots.find(b => b.id === botId);
    if (bot) { if (!bot.logs) bot.logs = []; bot.logs.push(entry); }
    if (botId === selectedBotId) appendLog(entry);
  });

  socket.on('bot:statusChange', ({ botId, status }) => {
    const bot = bots.find(b => b.id === botId);
    if (bot) bot.status = status;
    renderBotList();
    if (botId === selectedBotId) updateStatusUI(status);
  });

  socket.on('bot:stats', ({ botId, health, food, ping }) => {
    if (botId !== selectedBotId) return;
    document.getElementById('statHealth').textContent = health + ' ❤';
    document.getElementById('statFood').textContent   = food   + ' 🍗';
    document.getElementById('statPing').textContent   = ping   + 'ms';
  });

  socket.on('disconnect', () => {
    // On reconnect, reload bots to get fresh status
    socket.on('connect', () => loadBots());
  });
}

// ─── Render Bot List ──────────────────────────────────────────────────────────

function renderBotList() {
  const list = document.getElementById('botList');
  if (!bots.length) {
    list.innerHTML = '<div class="empty-state"><p>No bots yet.<br/>Click + to add your first bot.</p></div>';
    return;
  }
  list.innerHTML = bots.map(bot => `
    <div class="bot-item ${bot.id === selectedBotId ? 'active' : ''}" onclick="selectBot('${bot.id}')">
      <div class="bot-item-name">${esc(bot.name)}</div>
      <div class="bot-item-host">${esc(bot.host)}:${bot.port}</div>
      <div class="bot-item-status">
        <div class="status-badge ${bot.status || 'offline'}">${(bot.status || 'offline').toUpperCase()}</div>
        <span style="font-family:'Share Tech Mono',monospace;font-size:10px;color:var(--text-muted)">${esc(bot.username)}</span>
      </div>
    </div>
  `).join('');
}

// ─── Status UI ────────────────────────────────────────────────────────────────

function updateStatusUI(status) {
  const el       = document.getElementById('statStatus');
  const dot      = document.getElementById('pingDot');
  const startBtn = document.getElementById('btnStart');
  const stopBtn  = document.getElementById('btnStop');

  el.textContent = status.toUpperCase();
  el.style.color = {
    online: 'var(--success)', offline: 'var(--text-muted)',
    connecting: 'var(--warn)', error: 'var(--error)'
  }[status] || 'var(--text-muted)';

  dot.className = 'ping-indicator' + (status === 'online' ? ' online' : '');

  if (status === 'online') {
    startBtn.style.display = 'none';
    stopBtn.style.display  = '';
  } else {
    startBtn.style.display = '';
    stopBtn.style.display  = 'none';
    document.getElementById('statHealth').textContent = '—';
    document.getElementById('statFood').textContent   = '—';
    document.getElementById('statPing').textContent   = '—';
  }
}

// ─── Log output ──────────────────────────────────────────────────────────────

function appendLog(entry) {
  const output = document.getElementById('logOutput');
  const div = document.createElement('div');
  div.className = 'log-entry ' + (entry.type || 'info');
  const t  = new Date(entry.time);
  const ts = t.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  div.innerHTML = `<span class="log-time">${ts}</span><span class="log-msg">${esc(entry.message)}</span>`;
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
}

function clearLogs() {
  document.getElementById('logOutput').innerHTML = '';
  const bot = bots.find(b => b.id === selectedBotId);
  if (bot) bot.logs = [];
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Panel Tab ────────────────────────────────────────────────────────────────

function switchPanelTab(name, btn) {
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab' + name.charAt(0).toUpperCase() + name.slice(1)).classList.add('active');
}

// ─── Select Bot ───────────────────────────────────────────────────────────────

function selectBot(id) {
  selectedBotId = id;
  const bot = bots.find(b => b.id === id);
  if (!bot) return;

  renderBotList();
  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('botPanel').className = 'bot-panel active';

  document.getElementById('panelBotName').textContent = bot.name;
  document.getElementById('panelBotHost').textContent = `${bot.host}:${bot.port}`;
  document.getElementById('cfgUsername').value = bot.username;
  document.getElementById('cfgServer').value   = `${bot.host}:${bot.port}`;
  document.getElementById('cfgVersion').value  = bot.version || 'Auto';

  // Connection
  document.getElementById('liveAutoRejoin').checked    = bot.autoRejoin    ?? false;
  document.getElementById('liveAutoLeave').checked     = bot.autoLeave     ?? false;
  document.getElementById('liveOnJoinCommand').value   = bot.onJoinCommand ?? '';

  // Cycle
  document.getElementById('liveCycleEnabled').checked      = bot.cycleEnabled     ?? false;
  document.getElementById('liveCycleLeaveEvery').value     = bot.cycleLeaveEvery  ?? 15;
  document.getElementById('liveCycleRejoinAfter').value    = bot.cycleRejoinAfter ?? 5;
  updateCycleBadge();

  // Anti-AFK
  const a = bot.antiAfk || {};
  document.getElementById('liveJumpEnabled').checked   = a.jumpEnabled ?? true;
  document.getElementById('liveJumpInterval').value    = a.jumpInterval ?? 30;
  document.getElementById('liveWalkEnabled').checked   = a.walkEnabled ?? true;
  document.getElementById('liveWalkInterval').value    = a.walkInterval ?? 45;
  document.getElementById('liveLookEnabled').checked   = a.lookEnabled ?? true;
  document.getElementById('liveLookInterval').value    = a.lookInterval ?? 20;

  updateStatusUI(bot.status || 'offline');

  // Logs
  const output = document.getElementById('logOutput');
  output.innerHTML = '';
  (bot.logs || []).forEach(e => appendLog(e));

  // Timed messages
  renderTimedMessages(bot.timedMessages || []);
}

function updateCycleBadge() {
  const badge   = document.getElementById('cycleBadge');
  const enabled = document.getElementById('liveCycleEnabled')?.checked;
  if (badge) badge.style.display = enabled ? '' : 'none';
}

// ─── Load Bots ────────────────────────────────────────────────────────────────

async function loadBots() {
  const data = await api('GET', '/api/bots');
  if (!data) return;
  bots = data;
  renderBotList();
  // Re-select the current bot if it still exists (handles page reload)
  if (selectedBotId && bots.find(b => b.id === selectedBotId)) {
    selectBot(selectedBotId);
  }
}

// ─── Bot Controls ─────────────────────────────────────────────────────────────

async function controlBot(action) {
  if (!selectedBotId) return;
  await api('POST', `/api/bots/${selectedBotId}/${action}`);
}

async function deleteBot() {
  if (!selectedBotId) return;
  const bot = bots.find(b => b.id === selectedBotId);
  if (!confirm(`Delete bot "${bot?.name}"?`)) return;
  await api('DELETE', `/api/bots/${selectedBotId}`);
  selectedBotId = null;
  document.getElementById('botPanel').className = 'bot-panel';
  document.getElementById('welcomeScreen').style.display = '';
  await loadBots();
}

async function sendChat() {
  const input   = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message || !selectedBotId) return;
  input.value = '';
  await api('POST', `/api/bots/${selectedBotId}/chat`, { message });
}

document.getElementById('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// ─── Live Config Save ─────────────────────────────────────────────────────────

async function saveLiveConfig(immediate = false) {
  if (!selectedBotId) return;
  clearTimeout(liveConfigDebounce);

  const doSave = async () => {
    const bot = bots.find(b => b.id === selectedBotId);
    if (!bot) return;

    const antiAfk = {
      jumpEnabled:  document.getElementById('liveJumpEnabled').checked,
      jumpInterval: parseInt(document.getElementById('liveJumpInterval').value)  || 30,
      walkEnabled:  document.getElementById('liveWalkEnabled').checked,
      walkInterval: parseInt(document.getElementById('liveWalkInterval').value)  || 45,
      lookEnabled:  document.getElementById('liveLookEnabled').checked,
      lookInterval: parseInt(document.getElementById('liveLookInterval').value)  || 20,
    };
    const autoRejoin       = document.getElementById('liveAutoRejoin').checked;
    const autoLeave        = document.getElementById('liveAutoLeave').checked;
    const onJoinCommand    = document.getElementById('liveOnJoinCommand').value.trim();
    const cycleEnabled     = document.getElementById('liveCycleEnabled').checked;
    const cycleLeaveEvery  = parseInt(document.getElementById('liveCycleLeaveEvery').value)  || 15;
    const cycleRejoinAfter = parseInt(document.getElementById('liveCycleRejoinAfter').value) || 5;

    const updated = await api('PUT', `/api/bots/${selectedBotId}`, {
      ...bot, antiAfk,
      autoRejoin, autoLeave, onJoinCommand,
      cycleEnabled, cycleLeaveEvery, cycleRejoinAfter
    });
    if (updated) {
      const idx = bots.findIndex(b => b.id === selectedBotId);
      if (idx !== -1) bots[idx] = { ...bots[idx], ...updated };
    }
  };

  if (immediate) { await doSave(); return; }
  liveConfigDebounce = setTimeout(doSave, 700);
}

// ─── Timed Messages ───────────────────────────────────────────────────────────

function renderTimedMessages(messages) {
  const list = document.getElementById('timedList');
  if (!messages.length) {
    list.innerHTML = '<div style="text-align:center;padding:24px;font-family:\'Share Tech Mono\',monospace;font-size:11px;color:var(--text-muted)">No scheduled messages.<br>Click + Add to create one.</div>';
    return;
  }

  list.innerHTML = messages.map((tm, i) => `
    <div class="timed-item ${tm.enabled ? 'enabled-item' : ''}" id="tmItem_${tm.id}">
      <div class="timed-item-top">
        <span class="timed-num">#${i + 1}</span>
        <input class="timed-msg-input" type="text" placeholder="Message or /command..."
          value="${esc(tm.message)}" maxlength="256"
          oninput="updateTimedField('${tm.id}', 'message', this.value)" />
      </div>
      <div class="timed-item-bottom">
        <span class="timed-time-label">Every</span>
        <input class="timed-time-input" type="number" min="0" max="23" value="${tm.hours || 0}"
          oninput="updateTimedField('${tm.id}', 'hours', this.value)" />
        <span class="timed-time-label">h</span>
        <input class="timed-time-input" type="number" min="0" max="59" value="${tm.minutes || 0}"
          oninput="updateTimedField('${tm.id}', 'minutes', this.value)" />
        <span class="timed-time-label">m</span>
        <input class="timed-time-input" type="number" min="0" max="59" value="${tm.seconds || 0}"
          oninput="updateTimedField('${tm.id}', 'seconds', this.value)" />
        <span class="timed-time-label">s</span>
        <div class="timed-spacer"></div>
        <label class="timed-toggle" title="${tm.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" ${tm.enabled ? 'checked' : ''} onchange="updateTimedField('${tm.id}', 'enabled', this.checked)" />
          <span class="timed-slider"></span>
        </label>
        <button class="timed-del" onclick="removeTimedMessage('${tm.id}')" title="Delete">✕</button>
      </div>
    </div>
  `).join('');
}

function updateTimedField(id, field, value) {
  const bot = bots.find(b => b.id === selectedBotId);
  if (!bot || !bot.timedMessages) return;
  const tm = bot.timedMessages.find(t => t.id === id);
  if (!tm) return;
  if      (field === 'enabled')  tm.enabled  = value;
  else if (field === 'hours')    tm.hours    = parseInt(value) || 0;
  else if (field === 'minutes')  tm.minutes  = parseInt(value) || 0;
  else if (field === 'seconds')  tm.seconds  = parseInt(value) || 0;
  else tm[field] = value;
  const item = document.getElementById('tmItem_' + id);
  if (item) item.className = 'timed-item' + (tm.enabled ? ' enabled-item' : '');
}

function addTimedMessage() {
  const bot = bots.find(b => b.id === selectedBotId);
  if (!bot) return;
  if (!bot.timedMessages) bot.timedMessages = [];
  bot.timedMessages.push({ id: Date.now().toString(), enabled: false, message: '', hours: 0, minutes: 5, seconds: 0 });
  renderTimedMessages(bot.timedMessages);
  const list = document.getElementById('timedList');
  list.scrollTop = list.scrollHeight;
}

function removeTimedMessage(id) {
  const bot = bots.find(b => b.id === selectedBotId);
  if (!bot || !bot.timedMessages) return;
  bot.timedMessages = bot.timedMessages.filter(t => t.id !== id);
  renderTimedMessages(bot.timedMessages);
}

async function saveTimedMessages() {
  if (!selectedBotId) return;
  const bot = bots.find(b => b.id === selectedBotId);
  if (!bot) return;
  const updated = await api('PUT', `/api/bots/${selectedBotId}`, { ...bot, timedMessages: bot.timedMessages });
  if (updated) {
    const idx = bots.findIndex(b => b.id === selectedBotId);
    if (idx !== -1) bots[idx] = { ...bots[idx], ...updated };
  }
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function openAddModal() {
  editingBotId = null;
  document.getElementById('modalTitle').textContent = 'ADD BOT';
  document.getElementById('mName').value           = '';
  document.getElementById('mUsername').value       = '';
  document.getElementById('mHost').value           = '';
  document.getElementById('mPort').value           = '25565';
  document.getElementById('mVersion').value        = '';
  document.getElementById('mAutoRejoin').checked   = false;
  document.getElementById('mAutoLeave').checked    = false;
  document.getElementById('mOnJoinCommand').value  = '';
  document.getElementById('mCycleEnabled').checked     = false;
  document.getElementById('mCycleLeaveEvery').value    = '15';
  document.getElementById('mCycleRejoinAfter').value   = '5';
  document.getElementById('mJumpEnabled').checked  = true;
  document.getElementById('mJumpInterval').value   = '30';
  document.getElementById('mWalkEnabled').checked  = true;
  document.getElementById('mWalkInterval').value   = '45';
  document.getElementById('mLookEnabled').checked  = true;
  document.getElementById('mLookInterval').value   = '20';
  clearModalAlert();
  document.getElementById('botModal').classList.add('open');
}

function openEditModal() {
  const bot = bots.find(b => b.id === selectedBotId);
  if (!bot) return;
  editingBotId = bot.id;
  document.getElementById('modalTitle').textContent = 'EDIT BOT';
  document.getElementById('mName').value           = bot.name;
  document.getElementById('mUsername').value       = bot.username;
  document.getElementById('mHost').value           = bot.host;
  document.getElementById('mPort').value           = bot.port;
  document.getElementById('mVersion').value        = bot.version || '';
  document.getElementById('mAutoRejoin').checked   = bot.autoRejoin    ?? false;
  document.getElementById('mAutoLeave').checked    = bot.autoLeave     ?? false;
  document.getElementById('mOnJoinCommand').value  = bot.onJoinCommand ?? '';
  document.getElementById('mCycleEnabled').checked     = bot.cycleEnabled     ?? false;
  document.getElementById('mCycleLeaveEvery').value    = bot.cycleLeaveEvery  ?? 15;
  document.getElementById('mCycleRejoinAfter').value   = bot.cycleRejoinAfter ?? 5;
  const a = bot.antiAfk || {};
  document.getElementById('mJumpEnabled').checked  = a.jumpEnabled ?? true;
  document.getElementById('mJumpInterval').value   = a.jumpInterval ?? 30;
  document.getElementById('mWalkEnabled').checked  = a.walkEnabled ?? true;
  document.getElementById('mWalkInterval').value   = a.walkInterval ?? 45;
  document.getElementById('mLookEnabled').checked  = a.lookEnabled ?? true;
  document.getElementById('mLookInterval').value   = a.lookInterval ?? 20;
  clearModalAlert();
  document.getElementById('botModal').classList.add('open');
}

function closeModal() {
  document.getElementById('botModal').classList.remove('open');
  editingBotId = null;
}

function clearModalAlert() {
  const el = document.getElementById('modalAlert');
  el.className = 'modal-alert'; el.textContent = '';
}

function showModalAlert(msg, type) {
  const el = document.getElementById('modalAlert');
  el.className = 'modal-alert ' + type; el.textContent = msg;
}

async function saveBot() {
  const name    = document.getElementById('mName').value.trim();
  const username = document.getElementById('mUsername').value.trim();
  const host    = document.getElementById('mHost').value.trim();
  const port    = document.getElementById('mPort').value.trim();
  const version = document.getElementById('mVersion').value;
  if (!name || !username || !host || !port) return showModalAlert('Name, username, host and port are required', 'error');

  const antiAfk = {
    jumpEnabled:  document.getElementById('mJumpEnabled').checked,
    jumpInterval: parseInt(document.getElementById('mJumpInterval').value) || 30,
    walkEnabled:  document.getElementById('mWalkEnabled').checked,
    walkInterval: parseInt(document.getElementById('mWalkInterval').value) || 45,
    lookEnabled:  document.getElementById('mLookEnabled').checked,
    lookInterval: parseInt(document.getElementById('mLookInterval').value) || 20,
  };

  const existingBot = editingBotId ? bots.find(b => b.id === editingBotId) : null;

  const payload = {
    name, username, host, port: parseInt(port), version, antiAfk,
    timedMessages:    existingBot?.timedMessages ?? undefined,
    autoRejoin:       document.getElementById('mAutoRejoin').checked,
    autoLeave:        document.getElementById('mAutoLeave').checked,
    onJoinCommand:    document.getElementById('mOnJoinCommand').value.trim(),
    cycleEnabled:     document.getElementById('mCycleEnabled').checked,
    cycleLeaveEvery:  parseInt(document.getElementById('mCycleLeaveEvery').value)  || 15,
    cycleRejoinAfter: parseInt(document.getElementById('mCycleRejoinAfter').value) || 5,
  };

  let result;
  if (editingBotId) result = await api('PUT',  `/api/bots/${editingBotId}`, payload);
  else              result = await api('POST', '/api/bots', payload);

  if (!result || result.error) return showModalAlert(result?.error || 'Failed to save', 'error');

  showModalAlert(editingBotId ? 'Bot updated!' : 'Bot created!', 'success');
  await loadBots();
  setTimeout(() => { closeModal(); selectBot(editingBotId || result.id); }, 700);
}

document.getElementById('botModal').addEventListener('click', e => {
  if (e.target === document.getElementById('botModal')) closeModal();
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

function logout() {
  localStorage.removeItem('afk_token');
  localStorage.removeItem('afk_username');
  window.location.href = '/';
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  connectSocket();
  await loadBots();

  // Restore last-selected bot from session
  const lastSelected = sessionStorage.getItem('selectedBotId');
  if (lastSelected && bots.find(b => b.id === lastSelected)) {
    selectBot(lastSelected);
  }
})();

// Save selected bot to session so reload restores it
window.addEventListener('beforeunload', () => {
  if (selectedBotId) sessionStorage.setItem('selectedBotId', selectedBotId);
});
