require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const TenisBot = require('./bot');

const CREDENTIALS = {
  email: process.env.CAEP_EMAIL,
  password: process.env.CAEP_PASSWORD,
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Data directory
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LOG_PATH = path.join(DATA_DIR, 'logs.json');
const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// VAPID keys for push notifications
function loadOrGenerateVapidKeys() {
  try {
    return JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(keys, null, 2));
    return keys;
  }
}

const vapidKeys = loadOrGenerateVapidKeys();
webpush.setVapidDetails(
  'mailto:tenisbot@botenis.sdl.ar',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { reservations: [] }; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function appendLog(entry) {
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch {}
  logs.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (logs.length > 100) logs = logs.slice(0, 100);
  fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2));
}

function updateReservationStatus(id, status, detail) {
  const config = loadConfig();
  const r = (config.reservations || []).find(r => r.id === id);
  if (!r) return;
  r.status = status; // 'pending' | 'ok' | 'failed'
  r.lastAttempt = new Date().toISOString();
  r.attempts = (r.attempts || 0) + 1;
  if (detail) r.lastError = detail;
  saveConfig(config);
}

// --- API Routes ---

// Get config
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

// Test login
app.post('/api/test-login', async (req, res) => {
  if (!CREDENTIALS.email || !CREDENTIALS.password) {
    return res.json({ success: false, error: 'Credenciales no configuradas en .env' });
  }
  const bot = new TenisBot();
  try {
    const result = await bot.login(CREDENTIALS.email, CREDENTIALS.password);
    await bot.logout();
    res.json(result);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Debug: view profile HTML (temporary)
app.get('/api/debug/perfil', async (req, res) => {
  const bot = new TenisBot();
  try {
    await bot.login(CREDENTIALS.email, CREDENTIALS.password);
    const perfilRes = await bot._client().get('/index.asp?formato=PERFIL');
    await bot.logout();
    res.type('html').send(perfilRes.data);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Search players (requires login)
app.get('/api/players/search', async (req, res) => {
  const bot = new TenisBot();
  try {
    await bot.login(CREDENTIALS.email, CREDENTIALS.password);
    const results = await bot.searchPlayers(req.query.term);
    await bot.logout();
    res.json(results);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Get available slots
app.get('/api/slots', async (req, res) => {
  const { cantPers, fecha } = req.query;
  const bot = new TenisBot();
  try {
    await bot.login(CREDENTIALS.email, CREDENTIALS.password);
    const slots = await bot.getAvailableSlots(cantPers || 2, fecha);
    await bot.logout();
    res.json(slots);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Save reservation (always starts as pending)
app.post('/api/reservations', (req, res) => {
  const config = loadConfig();
  const reservation = {
    ...req.body,
    id: Date.now().toString(),
    status: 'pending',
    attempts: 0,
  };
  config.reservations = config.reservations || [];
  config.reservations.push(reservation);
  saveConfig(config);

  // Schedule if enabled
  if (reservation.schedule?.enabled) {
    scheduleReservation(reservation, CREDENTIALS);
  }

  res.json({ ok: true, id: reservation.id });
});

// Delete reservation
app.delete('/api/reservations/:id', (req, res) => {
  const config = loadConfig();
  config.reservations = (config.reservations || []).filter(r => r.id !== req.params.id);
  saveConfig(config);
  // Stop scheduled job if any
  if (scheduledJobs[req.params.id]) {
    scheduledJobs[req.params.id].stop();
    delete scheduledJobs[req.params.id];
  }
  res.json({ ok: true });
});

// Execute reservation NOW
app.post('/api/reservations/:id/execute', async (req, res) => {
  const config = loadConfig();
  const reservation = (config.reservations || []).find(r => r.id === req.params.id);
  if (!reservation) return res.json({ success: false, error: 'Reserva no encontrada' });

  const result = await executeReservation(CREDENTIALS, reservation);
  res.json(result);
});


// Get logs
app.get('/api/logs', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))); }
  catch { res.json([]); }
});

// Delete logs
app.delete('/api/logs', (req, res) => {
  fs.writeFileSync(LOG_PATH, '[]');
  res.json({ ok: true });
});

// --- Push notification endpoints ---

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', (req, res) => {
  const config = loadConfig();
  config.pushSubscriptions = config.pushSubscriptions || [];
  const exists = config.pushSubscriptions.some(s => s.endpoint === req.body.endpoint);
  if (!exists) {
    config.pushSubscriptions.push(req.body);
    saveConfig(config);
  }
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const config = loadConfig();
  config.pushSubscriptions = (config.pushSubscriptions || []).filter(
    s => s.endpoint !== req.body.endpoint
  );
  saveConfig(config);
  res.json({ ok: true });
});

app.post('/api/push/test', async (req, res) => {
  const result = await sendPushToAll('Tenis Bot', 'Notificación de prueba OK');
  res.json({ ok: result.sent > 0, sent: result.sent, failed: result.failed });
});

// --- Push notification sending ---

async function sendPushToAll(title, body) {
  const config = loadConfig();
  const subs = config.pushSubscriptions || [];
  let sent = 0, failed = 0;
  const expired = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title, body, url: '/' }));
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) {
        expired.push(sub.endpoint);
      }
      console.log(`Push error: ${err.statusCode || err.message}`);
    }
  }

  if (expired.length) {
    const cfg = loadConfig();
    cfg.pushSubscriptions = (cfg.pushSubscriptions || []).filter(
      s => !expired.includes(s.endpoint)
    );
    saveConfig(cfg);
  }

  return { sent, failed };
}

// --- Notification ---

async function notifyResult(reservation, success, detail) {
  const status = success ? 'OK' : 'FALLO';
  const msg = `${reservation.name} - ${reservation.fecha} ${reservation.hora} ${reservation.cancha}${detail ? ' - ' + detail : ''}`;

  try {
    await sendPushToAll(`Tenis Bot [${status}]`, msg);
  } catch (err) {
    console.log(`Error enviando push: ${err.message}`);
  }
}

// --- Reservation execution ---

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 15000; // 15 seconds between retries

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function executeReservation(credentials, reservation) {
  const bot = new TenisBot();
  const log = { reservation: reservation.name || reservation.id, steps: [] };

  try {
    // 1. Login
    log.steps.push('Iniciando login...');
    const loginResult = await bot.login(credentials.email, credentials.password);
    if (!loginResult.success) {
      log.steps.push(`Error login: ${loginResult.error}`);
      log.success = false;
      appendLog(log);
      updateReservationStatus(reservation.id, 'failed', loginResult.error);
      await notifyResult(reservation, false, loginResult.error);
      return { success: false, error: loginResult.error, log };
    }
    log.steps.push(`Login OK: ${loginResult.userName}`);

    // 2. Check players can reserve
    const playerIds = reservation.players.map(p => p.id);
    for (const pid of playerIds) {
      const check = await bot.checkPlayerCanReserve(pid);
      if (check !== 'OK') {
        log.steps.push(`Jugador ${pid} no puede reservar: ${check}`);
        log.success = false;
        appendLog(log);
        await bot.logout();
        updateReservationStatus(reservation.id, 'failed', `Jugador ${pid}: ${check}`);
        await notifyResult(reservation, false, `Jugador ${pid}: ${check}`);
        return { success: false, error: `Jugador ${pid}: ${check}`, log };
      }
    }
    log.steps.push('Todos los jugadores habilitados');

    // 3. Get available slots and find the matching one
    const cantPers = playerIds.length >= 4 ? 4 : 2;
    const fecha = reservation.fecha;
    const slots = await bot.getAvailableSlots(cantPers, fecha);
    log.steps.push(`${slots.length} turnos disponibles`);

    if (!slots.length) {
      log.steps.push('No hay turnos disponibles');
      log.success = false;
      appendLog(log);
      await bot.logout();
      // No marcar failed ni notificar, queda pending para reintentar (puede que aún no se habilitaron)
      updateReservationStatus(reservation.id, 'pending', 'No hay turnos disponibles aún');
      return { success: false, error: 'No hay turnos disponibles', log, retryable: true };
    }

    // 4. Find the specific slot matching cancha + hora
    // Reserva guarda "CANCHA 1", pero los slots usan "CA1", "CA2", etc.
    const canchaNum = (reservation.cancha || '').match(/(\d+)/)?.[1] || '';
    const targetCanchaShort = `ca${canchaNum}`;
    const targetHora = (reservation.hora || '').trim();
    log.steps.push(`Buscando: cancha="${reservation.cancha}" (CA${canchaNum}) hora="${targetHora}"`);
    log.steps.push(`Slots disponibles: ${slots.map(s => `[${s.id}] ${s.text}`).join(' | ')}`);

    let selectedSlot = slots.find(s => {
      const slotText = s.text.toLowerCase().replace(/\s+/g, '');
      const hasCancha = slotText.includes(targetCanchaShort);
      const hasHora = s.text.includes(targetHora) || s.id?.includes(targetHora);
      return hasCancha && hasHora;
    });

    if (!selectedSlot) {
      log.steps.push(`No se encontró turno para ${reservation.cancha} a las ${reservation.hora}`);
      log.success = false;
      appendLog(log);
      await bot.logout();
      updateReservationStatus(reservation.id, 'failed', `Turno no disponible: ${reservation.cancha} ${reservation.hora}`);
      await notifyResult(reservation, false, `Turno no disponible: ${reservation.cancha} ${reservation.hora}`);
      return { success: false, error: `Turno no disponible: ${reservation.cancha} ${reservation.hora}`, log };
    }

    log.steps.push(`Turno seleccionado: ${selectedSlot.text}`);

    // 5. Make reservation
    const result = await bot.makeReservation({
      playerIds,
      cantPers,
      fecha,
      horarioId: selectedSlot.id,
    });

    log.steps.push(`Resultado: ${JSON.stringify(result)}`);
    log.success = result.success;
    appendLog(log);
    await bot.logout();

    if (result.success) {
      updateReservationStatus(reservation.id, 'ok', null);
      await notifyResult(reservation, true, 'RESERVADA');
    } else {
      updateReservationStatus(reservation.id, 'failed', result.error);
      await notifyResult(reservation, false, result.error);
    }

    return { ...result, log };
  } catch (err) {
    log.steps.push(`Error: ${err.message}`);
    log.success = false;
    appendLog(log);
    try { await bot.logout(); } catch {}
    updateReservationStatus(reservation.id, 'failed', err.message);
    await notifyResult(reservation, false, err.message);
    return { success: false, error: err.message, log };
  }
}

// Execute with retries
async function executeWithRetries(credentials, reservation) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[${new Date().toISOString()}] Intento ${attempt}/${MAX_RETRIES}: ${reservation.name}`);

    const result = await executeReservation(credentials, reservation);

    if (result.success) {
      console.log(`[${new Date().toISOString()}] Reserva OK: ${reservation.name}`);
      return result;
    }

    // Re-read reservation status (executeReservation may have set it to 'failed')
    const config = loadConfig();
    const current = (config.reservations || []).find(r => r.id === reservation.id);
    if (current?.status === 'failed') {
      console.log(`[${new Date().toISOString()}] Reserva marcada como fallida, no se reintenta: ${reservation.name}`);
      return result;
    }

    if (attempt < MAX_RETRIES) {
      console.log(`[${new Date().toISOString()}] Reintentando en ${RETRY_DELAY_MS / 1000}s...`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  // All retries exhausted
  updateReservationStatus(reservation.id, 'failed', `Sin éxito después de ${MAX_RETRIES} intentos`);
  await notifyResult(reservation, false, `Sin éxito después de ${MAX_RETRIES} intentos`);
}

// --- Scheduler ---

let scheduledJobs = {};

function getExecutionWindow(reservation) {
  // Parse reservation date (DD/MM/YYYY)
  const [dd, mm, yyyy] = reservation.fecha.split('/').map(Number);
  const reservationDate = new Date(yyyy, mm - 1, dd);

  if (reservation.schedule.type === 'morning') {
    // Turno mañana → bot corre a las 19:59 del día anterior
    const execDate = new Date(reservationDate);
    execDate.setDate(execDate.getDate() - 1);
    execDate.setHours(19, 59, 0, 0);
    return execDate;
  } else {
    // Turno tarde → bot corre a las 07:59 del mismo día
    const execDate = new Date(reservationDate);
    execDate.setHours(7, 59, 0, 0);
    return execDate;
  }
}

function scheduleReservation(reservation, credentials) {
  const id = reservation.id;
  if (scheduledJobs[id]) {
    scheduledJobs[id].stop();
    delete scheduledJobs[id];
  }

  if (!reservation.schedule?.enabled || !reservation.fecha) return;
  if (reservation.status === 'ok' || reservation.status === 'failed') return;

  const execWindow = getExecutionWindow(reservation);
  const now = new Date();

  // If the execution window already passed, execute immediately
  if (now >= execWindow) {
    console.log(`[${now.toISOString()}] Ventana ya pasó para "${reservation.name}", ejecutando ahora...`);
    executeWithRetries(credentials, reservation);
    return;
  }

  const [hour, minute] = reservation.schedule.time.split(':');
  const cronDay = execWindow.getDate();
  const cronMonth = execWindow.getMonth() + 1;

  // Schedule for specific date+time
  const cronExpr = `${minute} ${hour} ${cronDay} ${cronMonth} *`;

  scheduledJobs[id] = cron.schedule(cronExpr, async () => {
    console.log(`[${new Date().toISOString()}] Ejecutando reserva programada: ${reservation.name}`);
    await executeWithRetries(credentials, reservation);
    // Cleanup job
    if (scheduledJobs[id]) {
      scheduledJobs[id].stop();
      delete scheduledJobs[id];
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  const schedLabel = reservation.schedule.type === 'morning'
    ? `${cronDay}/${cronMonth} a las 19:59`
    : `${cronDay}/${cronMonth} a las 07:59`;
  console.log(`Reserva "${reservation.name}" programada para ${schedLabel} -> reservar ${reservation.fecha} ${reservation.hora} ${reservation.cancha}`);
}

// On startup: re-schedule pending reservations, and execute any whose window already passed
async function loadSchedules() {
  if (!CREDENTIALS.email) {
    console.log('[STARTUP] CAEP_EMAIL no configurado en .env, no se programan reservas');
    return;
  }

  const config = loadConfig();
  const now = new Date();

  for (const r of config.reservations || []) {
    // Skip completed or permanently failed
    if (r.status === 'ok' || r.status === 'failed') continue;
    if (!r.schedule?.enabled || !r.fecha) continue;

    const execWindow = getExecutionWindow(r);

    if (now >= execWindow) {
      // Window already passed and reservation is still pending → execute now
      console.log(`[STARTUP] Reserva pendiente "${r.name}" - ventana ya pasó (${execWindow.toISOString()}), ejecutando ahora...`);
      executeWithRetries(CREDENTIALS, r);
    } else {
      // Window hasn't arrived yet → schedule normally
      scheduleReservation(r, CREDENTIALS);
    }
  }
}

// --- Start ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tenis Bot corriendo en http://localhost:${PORT}`);
  loadSchedules();
});
