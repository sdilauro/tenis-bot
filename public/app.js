// --- API helpers ---
async function api(method, url, body, extraHeaders) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...extraHeaders } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `status ${type}`;
}

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// --- Connection & Player 1 ---
let loggedUser = null;

async function fetchUser() {
  showStatus('login-status', 'Conectando con CAEP...', 'info');
  const result = await api('POST', '/api/test-login');
  if (result.success) {
    loggedUser = { id: result.userId, name: result.userName };
    document.getElementById('player1-name').value = result.userName;
    document.getElementById('player1-id').value = result.userId;
    document.getElementById('login-status').style.display = 'none';
  } else {
    showStatus('login-status', `Error de conexión: ${result.error}`, 'error');
  }
  return result;
}

// --- Player count toggle ---
function updatePlayerFields() {
  const cant = parseInt(document.getElementById('cant-jugadores').value);
  const container = document.getElementById('players-container');
  const searchableRows = container.querySelectorAll('.player-row:not(.player-row-fixed)');
  const currentSearchable = searchableRows.length;
  const needed = cant - 1;

  if (needed > currentSearchable) {
    for (let i = currentSearchable + 2; i <= cant; i++) {
      const row = document.createElement('div');
      row.className = 'player-row';
      row.innerHTML = `
        <input type="text" class="player-search" placeholder="Buscar jugador..." data-index="${i}">
        <select class="player-select" data-index="${i}"><option value="">-- Buscar primero --</option></select>
      `;
      container.appendChild(row);
    }
  } else if (needed < currentSearchable) {
    for (let i = currentSearchable - 1; i >= needed; i--) {
      searchableRows[i].remove();
    }
  }
}

// --- Player Search ---
let searchTimeouts = {};

document.addEventListener('input', async (e) => {
  if (!e.target.classList.contains('player-search')) return;
  const term = e.target.value.trim();
  const idx = e.target.dataset.index;

  if (searchTimeouts[idx]) clearTimeout(searchTimeouts[idx]);
  if (term.length < 3) return;

  searchTimeouts[idx] = setTimeout(async () => {
    const select = document.querySelector(`.player-select[data-index="${idx}"]`);
    select.innerHTML = '<option value="">Buscando...</option>';

    const results = await api('GET', `/api/players/search?term=${encodeURIComponent(term)}`);
    if (results.error) {
      select.innerHTML = `<option value="">Error: ${results.error}</option>`;
      return;
    }

    select.innerHTML = '<option value="">-- Seleccionar --</option>';
    for (const p of results) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.text;
      select.appendChild(opt);
    }
  }, 500);
});

// --- Cancha options ---
const CANCHAS = [
  'Cancha 1', 'Cancha 2', 'Cancha 3', 'Cancha 4', 'Cancha 5',
  'Cancha 6', 'Cancha 7', 'Cancha 8', 'Cancha 9',
];

function populateSelects() {
  for (const selectId of ['res-cancha1', 'res-cancha2']) {
    const canchaSelect = document.getElementById(selectId);
    for (const c of CANCHAS) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      canchaSelect.appendChild(opt);
    }
  }
}

// --- Schedule auto-detection ---
function getScheduleForHora(hora) {
  if (!hora) return null;
  const h = parseInt(hora.split(':')[0]);
  if (h < 14) {
    return { type: 'morning', time: '19:59', label: 'El bot intentará reservar a las 19:59 del día anterior (10 intentos cada 15s)' };
  } else {
    return { type: 'afternoon', time: '07:59', label: 'El bot intentará reservar a las 07:59 del mismo día (10 intentos cada 15s)' };
  }
}

function updateScheduleInfo() {
  const hora1 = document.getElementById('res-hora1').value;
  const info = document.getElementById('schedule-info');
  const sched = getScheduleForHora(hora1);
  if (sched) {
    info.textContent = sched.label;
    info.style.display = 'block';
  } else {
    info.style.display = 'none';
  }
}

document.getElementById('res-hora1').addEventListener('change', updateScheduleInfo);

// --- Save Reservation ---
async function saveReservation() {
  const name = document.getElementById('res-name').value.trim();
  if (!name) return showStatus('save-status', 'Poné un nombre', 'error');

  const cant = parseInt(document.getElementById('cant-jugadores').value);

  const p1Id = document.getElementById('player1-id').value;
  const p1Name = document.getElementById('player1-name').value;
  if (!p1Id) return showStatus('save-status', 'Esperá a que cargue el jugador 1 (tu usuario)', 'error');

  const players = [{ id: p1Id, name: p1Name }];
  for (let i = 2; i <= cant; i++) {
    const sel = document.querySelector(`.player-select[data-index="${i}"]`);
    if (sel && sel.value) {
      players.push({ id: sel.value, name: sel.options[sel.selectedIndex].text });
    }
  }
  if (players.length < cant) return showStatus('save-status', `Seleccioná ${cant} jugadores`, 'error');

  const dia = document.getElementById('res-dia').value;
  if (dia === '') return showStatus('save-status', 'Seleccioná un día', 'error');

  const recurring = document.getElementById('res-recurring').value === '1';

  const cancha1 = document.getElementById('res-cancha1').value;
  const hora1 = document.getElementById('res-hora1').value;
  if (!cancha1 || !hora1) return showStatus('save-status', 'Completá la opción 1 (cancha y hora)', 'error');

  const cancha2 = document.getElementById('res-cancha2').value;
  const hora2 = document.getElementById('res-hora2').value;
  if (!cancha2 || !hora2) return showStatus('save-status', 'Completá la opción 2 (cancha y hora)', 'error');

  const sched = getScheduleForHora(hora1);

  const reservation = {
    name,
    players,
    dia: parseInt(dia),
    recurring,
    opciones: [
      { cancha: cancha1, hora: hora1 },
      { cancha: cancha2, hora: hora2 },
    ],
    schedule: {
      enabled: true,
      type: sched.type,
      time: sched.time,
    },
  };

  const pw = prompt('Contraseña:');
  if (!pw) return;

  const result = await api('POST', '/api/reservations', reservation, { 'X-Password': pw });
  if (result.error) return showStatus('save-status', result.error, 'error');
  if (result.ok) {
    showStatus('save-status', 'Reserva guardada', 'success');
    loadReservations();
    // Clear form
    document.getElementById('res-name').value = '';
    document.getElementById('res-dia').value = '';
    document.getElementById('res-recurring').value = '1';
    document.getElementById('res-cancha1').value = '';
    document.getElementById('res-hora1').value = '';
    document.getElementById('res-cancha2').value = '';
    document.getElementById('res-hora2').value = '';
    document.getElementById('schedule-info').style.display = 'none';
    document.querySelectorAll('.player-select').forEach(s => s.selectedIndex = 0);
    document.querySelectorAll('.player-search').forEach(s => s.value = '');
  }
}

// --- Load Reservations ---
async function loadReservations() {
  const config = await api('GET', '/api/config');
  const container = document.getElementById('reservations-list');
  const reservations = config.reservations || [];

  if (!reservations.length) {
    container.innerHTML = '<p style="color:#64748b">No hay reservas guardadas</p>';
    return;
  }

  container.innerHTML = reservations.map(r => {
    const diaName = DIAS[r.dia] || '?';
    const recurLabel = r.recurring ? 'Semanal' : 'Única';

    const schedLabel = r.schedule?.type === 'morning'
      ? `Bot a las 19:59 del día anterior`
      : `Bot a las 07:59 del mismo día`;

    const opcLabel = (r.opciones || []).map((o, i) =>
      `Opción ${i + 1}: ${esc(o.cancha)} a las ${esc(o.hora)}`
    ).join('<br>');

    const statusMap = {
      pending: { text: 'Pendiente', cls: 'status-pending' },
      ok: { text: 'Confirmada', cls: 'status-ok' },
      failed: { text: 'Fallida', cls: 'status-failed' },
    };
    const st = statusMap[r.status] || statusMap.pending;
    const attemptsText = r.attempts ? ` (${r.attempts} intento${r.attempts > 1 ? 's' : ''})` : '';
    const errorText = r.lastError && r.status !== 'ok' ? `<div class="meta"><span class="error-detail">${esc(r.lastError)}</span></div>` : '';
    const lastExecText = r.lastExecutedFecha ? `<div class="meta"><span>Última ejecución: ${esc(r.lastExecutedFecha)}</span></div>` : '';

    return `
    <div class="reservation-item">
      <div class="reservation-header">
        <h3>${esc(r.name)}</h3>
        <span class="reservation-status ${st.cls}">${st.text}${attemptsText}</span>
      </div>
      <div class="meta">
        <span>${esc(diaName)} — ${esc(recurLabel)}</span>
      </div>
      <div class="meta">
        <span>${opcLabel}</span>
      </div>
      <div class="meta">
        <span>${r.players.map(p => esc(p.name).toUpperCase()).join('<br>')}</span>
      </div>
      <div class="meta">
        <span>${schedLabel}</span>
      </div>
      ${lastExecText}
      ${errorText}
      <div class="reservation-actions">
        <button class="btn-secondary" onclick='copyReservation(${JSON.stringify(JSON.stringify(r))})'>Copiar</button>
        ${r.status !== 'ok' ? `<button class="btn-success" onclick="executeNow('${r.id}')">Ejecutar</button>` : ''}
        <button class="btn-danger btn-sm" onclick="deleteReservation('${r.id}')">Eliminar</button>
      </div>
    </div>
  `}).join('');
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function executeNow(id) {
  if (!confirm('¿Ejecutar la reserva ahora?')) return;
  const btn = event.target;
  btn.textContent = 'Ejecutando...';
  btn.disabled = true;

  const result = await api('POST', `/api/reservations/${id}/execute`);
  btn.textContent = 'Ejecutar';
  btn.disabled = false;

  if (result.success) {
    alert(`Reserva exitosa! ${result.cancha || ''} ${result.hora || ''}`);
  } else {
    alert(`Error: ${result.error}\n\nPasos:\n${result.log?.steps?.join('\n') || ''}`);
  }
  loadReservations();
  loadLogs();
}

function copyReservation(jsonStr) {
  const r = JSON.parse(jsonStr);
  document.getElementById('res-name').value = r.name || '';
  document.getElementById('res-dia').value = r.dia != null ? r.dia : '';
  document.getElementById('res-recurring').value = r.recurring ? '1' : '0';

  const opc = r.opciones || [];
  document.getElementById('res-cancha1').value = opc[0]?.cancha || '';
  document.getElementById('res-hora1').value = opc[0]?.hora || '';
  document.getElementById('res-cancha2').value = opc[1]?.cancha || '';
  document.getElementById('res-hora2').value = opc[1]?.hora || '';

  // Restore player count
  const cant = (r.players || []).length >= 4 ? 4 : 2;
  document.getElementById('cant-jugadores').value = cant;
  updatePlayerFields();

  // Restore player selections (player 1 is fixed, restore 2+)
  const players = r.players || [];
  for (let i = 2; i <= cant; i++) {
    const p = players[i - 1];
    if (!p) continue;
    const sel = document.querySelector(`.player-select[data-index="${i}"]`);
    if (sel) {
      sel.innerHTML = `<option value="${esc(p.id)}" selected>${esc(p.name)}</option>`;
    }
  }

  updateScheduleInfo();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteReservation(id) {
  const pw = prompt('Contraseña:');
  if (!pw) return;
  const result = await api('DELETE', `/api/reservations/${id}`, null, { 'X-Password': pw });
  if (result.error) return alert(result.error);
  loadReservations();
}

// --- Logs ---
async function loadLogs() {
  const logs = await api('GET', '/api/logs');
  const container = document.getElementById('logs-list');

  if (!logs.length) {
    container.innerHTML = '<p style="color:#64748b">Sin logs</p>';
    return;
  }

  container.innerHTML = logs.map(l => `
    <div class="log-item ${l.success ? 'log-success' : 'log-fail'}">
      <div class="log-time">${new Date(l.timestamp).toLocaleString('es-AR')}</div>
      <div class="log-name">${esc(l.reservation || '')} — ${l.success ? 'OK' : 'FALLO'}</div>
      <div class="log-steps">
        ${(l.steps || []).map(s => `<div>• ${esc(s)}</div>`).join('')}
      </div>
    </div>
  `).join('');
}

async function clearLogs() {
  if (!confirm('¿Borrar todos los logs?')) return;
  await api('DELETE', '/api/logs');
  loadLogs();
}

// --- Push Notifications ---

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

async function checkPushSubscription() {
  const btn = document.getElementById('push-btn');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.textContent = 'No soportado en este navegador';
    btn.disabled = true;
    return;
  }
  if (navigator.standalone === false || (window.matchMedia && window.matchMedia('(display-mode: browser)').matches && /iPhone|iPad/.test(navigator.userAgent))) {
    document.getElementById('push-ios-hint').style.display = 'block';
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    btn.textContent = 'Desactivar Notificaciones';
    btn.className = 'btn-danger';
  }
}

async function togglePush() {
  const btn = document.getElementById('push-btn');
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();

  if (existing) {
    await existing.unsubscribe();
    await api('POST', '/api/push/unsubscribe', { endpoint: existing.endpoint });
    btn.textContent = 'Activar Notificaciones';
    btn.className = 'btn-secondary';
    showStatus('push-status', 'Notificaciones desactivadas', 'info');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    showStatus('push-status', 'Permiso denegado. Revisá los permisos del navegador.', 'error');
    return;
  }

  try {
    const { publicKey } = await api('GET', '/api/push/vapid-public-key');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api('POST', '/api/push/subscribe', sub.toJSON());
    btn.textContent = 'Desactivar Notificaciones';
    btn.className = 'btn-danger';
    showStatus('push-status', 'Notificaciones activadas', 'success');
  } catch (err) {
    showStatus('push-status', `Error: ${err.message}`, 'error');
  }
}


function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// --- Init ---
populateSelects();
fetchUser();
loadReservations();
loadLogs();
checkPushSubscription();
