// --- API helpers ---
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `status ${type}`;
}

// --- Connection & Player 1 ---
let loggedUser = null;

async function fetchUser() {
  showStatus('login-status', 'Conectando con CAEP...', 'info');
  const result = await api('POST', '/api/test-login');
  if (result.success) {
    loggedUser = { id: result.userId, name: result.userName };
    document.getElementById('player1-name').value = result.userName;
    document.getElementById('player1-id').value = result.userId;
    showStatus('login-status', `Conectado como ${result.userName}`, 'success');
  } else {
    showStatus('login-status', `Error de conexión: ${result.error}`, 'error');
  }
  return result;
}

// --- Player count toggle ---
// Player 1 is always the logged-in user (fixed). Searchable players start at index 2.
function updatePlayerFields() {
  const cant = parseInt(document.getElementById('cant-jugadores').value);
  const container = document.getElementById('players-container');
  // Count only searchable rows (not the fixed player 1)
  const searchableRows = container.querySelectorAll('.player-row:not(.player-row-fixed)');
  const currentSearchable = searchableRows.length;
  const needed = cant - 1; // player 1 is fixed

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
  'CANCHA 1', 'CANCHA 2', 'CANCHA 3', 'CANCHA 4', 'CANCHA 5',
  'CANCHA 6', 'CANCHA 7', 'CANCHA 8', 'CANCHA 9',
];

function populateSelects() {
  const canchaSelect = document.getElementById('res-cancha');
  for (const c of CANCHAS) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    canchaSelect.appendChild(opt);
  }
}

// --- Schedule auto-detection ---
function getScheduleForHora(hora) {
  if (!hora) return null;
  const h = parseInt(hora.split(':')[0]);
  // Mañana: hora < 14 → bot corre a las 20:00 del día anterior
  // Tarde: hora >= 14 → bot corre a las 08:00 del mismo día
  if (h < 14) {
    return { type: 'morning', time: '19:59', label: 'El bot intentará reservar a las 19:59 del día anterior (10 intentos cada 15s)' };
  } else {
    return { type: 'afternoon', time: '07:59', label: 'El bot intentará reservar a las 07:59 del mismo día (10 intentos cada 15s)' };
  }
}

document.getElementById('res-hora').addEventListener('change', () => {
  const hora = document.getElementById('res-hora').value;
  const info = document.getElementById('schedule-info');
  const sched = getScheduleForHora(hora);
  if (sched) {
    info.textContent = sched.label;
    info.style.display = 'block';
  } else {
    info.style.display = 'none';
  }
});

// --- Save Reservation ---
async function saveReservation() {
  const name = document.getElementById('res-name').value.trim();
  if (!name) return showStatus('save-status', 'Poné un nombre', 'error');

  const cant = parseInt(document.getElementById('cant-jugadores').value);

  // Player 1 = logged user
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

  const fecha = document.getElementById('res-fecha').value;
  if (!fecha) return showStatus('save-status', 'Seleccioná una fecha', 'error');

  const hora = document.getElementById('res-hora').value;
  if (!hora) return showStatus('save-status', 'Seleccioná una hora', 'error');

  const cancha = document.getElementById('res-cancha').value;
  if (!cancha) return showStatus('save-status', 'Seleccioná una cancha', 'error');

  // Convert YYYY-MM-DD to DD/MM/YYYY
  const [y, m, d] = fecha.split('-');
  const fechaFormatted = `${d}/${m}/${y}`;

  const sched = getScheduleForHora(hora);

  const reservation = {
    name,
    players,
    fecha: fechaFormatted,
    hora,
    cancha,
    schedule: {
      enabled: true,
      type: sched.type,
      time: sched.time,
    },
  };

  const result = await api('POST', '/api/reservations', reservation);
  if (result.ok) {
    showStatus('save-status', 'Reserva guardada', 'success');
    loadReservations();
    // Clear form
    document.getElementById('res-name').value = '';
    document.getElementById('res-fecha').value = '';
    document.getElementById('res-hora').value = '';
    document.getElementById('res-cancha').value = '';
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
    const schedLabel = r.schedule?.type === 'morning'
      ? `Bot a las 19:59 del día anterior`
      : `Bot a las 07:59 del mismo día`;

    const statusMap = {
      pending: { text: 'Pendiente', cls: 'status-pending' },
      ok: { text: 'Confirmada', cls: 'status-ok' },
      failed: { text: 'Fallida', cls: 'status-failed' },
    };
    const st = statusMap[r.status] || statusMap.pending;
    const attemptsText = r.attempts ? ` (${r.attempts} intento${r.attempts > 1 ? 's' : ''})` : '';
    const errorText = r.lastError && r.status !== 'ok' ? `<div class="meta"><span class="error-detail">${esc(r.lastError)}</span></div>` : '';

    return `
    <div class="reservation-item">
      <div class="reservation-header">
        <h3>${esc(r.name)}</h3>
        <span class="reservation-status ${st.cls}">${st.text}${attemptsText}</span>
      </div>
      <div class="meta">
        <span>Jugadores: ${r.players.map(p => esc(p.name)).join(', ')}</span>
      </div>
      <div class="meta">
        <span>Fecha: ${esc(r.fecha)} | Hora: ${esc(r.hora)} | ${esc(r.cancha)}</span>
      </div>
      <div class="meta">
        <span>${schedLabel}</span>
      </div>
      ${errorText}
      <div class="reservation-actions">
        ${r.status !== 'ok' ? `<button class="btn-success" onclick="executeNow('${r.id}')">Ejecutar AHORA</button>` : ''}
        <button class="btn-danger" onclick="deleteReservation('${r.id}')">Eliminar</button>
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
  btn.textContent = 'Ejecutar AHORA';
  btn.disabled = false;

  if (result.success) {
    alert('Reserva exitosa!');
  } else {
    alert(`Error: ${result.error}\n\nPasos:\n${result.log?.steps?.join('\n') || ''}`);
  }
  loadLogs();
}

async function deleteReservation(id) {
  if (!confirm('¿Eliminar esta reserva?')) return;
  await api('DELETE', `/api/reservations/${id}`);
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
  // iOS hint: show if standalone is available but not active
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
    // Unsubscribe
    await existing.unsubscribe();
    await api('POST', '/api/push/unsubscribe', { endpoint: existing.endpoint });
    btn.textContent = 'Activar Notificaciones';
    btn.className = 'btn-primary';
    showStatus('push-status', 'Notificaciones desactivadas', 'info');
    return;
  }

  // Subscribe
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

async function testPush() {
  showStatus('push-status', 'Enviando notificación de prueba...', 'info');
  const result = await api('POST', '/api/push/test');
  if (result.ok) {
    showStatus('push-status', 'Notificación enviada', 'success');
  } else {
    showStatus('push-status', 'No hay suscripciones activas o falló el envío', 'error');
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
