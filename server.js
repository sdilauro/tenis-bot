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
  r.status = status;
  r.lastAttempt = new Date().toISOString();
  r.attempts = (r.attempts || 0) + 1;
  if (detail) r.lastError = detail;
  else if (status === 'ok') r.lastError = null;
  saveConfig(config);
}

function setLastExecutedFecha(id, fecha) {
  const config = loadConfig();
  const r = (config.reservations || []).find(r => r.id === id);
  if (!r) return;
  r.lastExecutedFecha = fecha;
  saveConfig(config);
}

function deleteReservationFromConfig(id) {
  const config = loadConfig();
  config.reservations = (config.reservations || []).filter(r => r.id !== id);
  saveConfig(config);
  if (scheduledJobs[id]) {
    scheduledJobs[id].stop();
    delete scheduledJobs[id];
  }
}

// --- Timezone helpers ---

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function getBuenosAiresNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
}

function formatFecha(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// Calculate the reservation date (fecha) based on schedule type when the bot fires
function calculateFecha(scheduleType) {
  const now = getBuenosAiresNow();
  if (scheduleType === 'morning') {
    // Bot runs night before → reservation is for tomorrow
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return formatFecha(tomorrow);
  } else {
    // Bot runs morning of → reservation is for today
    return formatFecha(now);
  }
}

// --- API Routes ---

app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

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

function requirePassword(req, res, next) {
  const pw = req.headers['x-password'] || req.body?.password;
  if (pw !== CREDENTIALS.password) {
    return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
  }
  next();
}

// Save reservation
app.post('/api/reservations', requirePassword, (req, res) => {
  const config = loadConfig();
  const reservation = {
    ...req.body,
    id: Date.now().toString(),
    status: 'pending',
    attempts: 0,
    lastExecutedFecha: null,
  };
  config.reservations = config.reservations || [];
  config.reservations.push(reservation);
  saveConfig(config);

  if (reservation.schedule?.enabled) {
    scheduleReservation(reservation, CREDENTIALS);
  }

  res.json({ ok: true, id: reservation.id });
});

// Delete reservation
app.delete('/api/reservations/:id', requirePassword, (req, res) => {
  const config = loadConfig();
  config.reservations = (config.reservations || []).filter(r => r.id !== req.params.id);
  saveConfig(config);
  if (scheduledJobs[req.params.id]) {
    scheduledJobs[req.params.id].stop();
    delete scheduledJobs[req.params.id];
  }
  res.json({ ok: true });
});

// Execute reservation NOW (manual trigger)
app.post('/api/reservations/:id/execute', async (req, res) => {
  const config = loadConfig();
  const reservation = (config.reservations || []).find(r => r.id === req.params.id);
  if (!reservation) return res.json({ success: false, error: 'Reserva no encontrada' });

  // For manual execution, use the next occurrence date
  const fecha = calculateFechaForReservation(reservation);
  const result = await executeReservation(CREDENTIALS, reservation, fecha);

  // For non-recurring, delete after manual execution too
  if (!reservation.recurring && (result.success || !result.retryable)) {
    deleteReservationFromConfig(reservation.id);
  }

  res.json(result);
});

app.get('/api/logs', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))); }
  catch { res.json([]); }
});

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
  const icon = success ? '🎾' : '😞';
  const diaName = DIAS[reservation.dia] || '';
  const msg = success
    ? `${diaName} - ${detail}`
    : `${diaName} - No se pudo reservar`;

  try {
    await sendPushToAll(`${icon} Tenis Bot`, msg);
  } catch (err) {
    console.log(`Error enviando push: ${err.message}`);
  }
}

// --- Reservation execution ---

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 15000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Calculate fecha for a reservation (for manual execution or startup)
function calculateFechaForReservation(reservation) {
  const now = getBuenosAiresNow();
  const targetDay = reservation.dia;
  const today = now.getDay();
  let daysUntil = targetDay - today;
  if (daysUntil < 0) daysUntil += 7;
  if (daysUntil === 0) {
    // If it's the same day, check if we can still reserve for today
    // Morning slots: if it's before ~20:00 the day before, we'd be too early
    // But for manual execution, use today if it's the target day
    // For scheduled, the cron handles timing
  }
  const targetDate = new Date(now);
  targetDate.setDate(targetDate.getDate() + daysUntil);
  return formatFecha(targetDate);
}

async function executeReservation(credentials, reservation, fecha) {
  const bot = new TenisBot();
  const opciones = reservation.opciones || [];
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
      await notifyResult(reservation, false);
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
        await notifyResult(reservation, false);
        return { success: false, error: `Jugador ${pid}: ${check}`, log };
      }
    }
    log.steps.push('Todos los jugadores habilitados');

    // 3. Get available slots
    const cantPers = playerIds.length >= 4 ? 4 : 2;
    const slots = await bot.getAvailableSlots(cantPers, fecha);
    log.steps.push(`${slots.length} turnos disponibles para ${fecha}`);

    if (!slots.length) {
      log.steps.push('No hay turnos disponibles');
      log.success = false;
      appendLog(log);
      await bot.logout();
      updateReservationStatus(reservation.id, 'pending', 'No hay turnos disponibles aún');
      return { success: false, error: 'No hay turnos disponibles', log, retryable: true };
    }

    log.steps.push(`Slots: ${slots.map(s => `[${s.id}] ${s.text}`).join(' | ')}`);

    // 4. Try each option in order
    for (let i = 0; i < opciones.length; i++) {
      const opcion = opciones[i];
      const canchaNum = (opcion.cancha || '').match(/(\d+)/)?.[1] || '';
      const targetCanchaShort = `ca${canchaNum}`;
      const targetHora = (opcion.hora || '').trim();

      log.steps.push(`Intentando opción ${i + 1}: ${opcion.cancha} a las ${targetHora}`);

      const selectedSlot = slots.find(s => {
        const slotText = s.text.toLowerCase().replace(/\s+/g, '');
        const hasCancha = slotText.includes(targetCanchaShort);
        const hasHora = s.text.includes(targetHora) || s.id?.includes(targetHora);
        return hasCancha && hasHora;
      });

      if (!selectedSlot) {
        log.steps.push(`Opción ${i + 1} no disponible: ${opcion.cancha} ${targetHora}`);
        continue;
      }

      log.steps.push(`Turno encontrado: ${selectedSlot.text}`);

      // Try to make the reservation
      const result = await bot.makeReservation({
        playerIds,
        cantPers,
        fecha,
        horarioId: selectedSlot.id,
      });

      if (result.success) {
        log.steps.push(`RESERVADA: ${opcion.cancha} a las ${targetHora}`);
        log.success = true;
        appendLog(log);
        await bot.logout();
        updateReservationStatus(reservation.id, 'ok', null);
        await notifyResult(reservation, true, `${opcion.cancha} - ${targetHora}`);
        return { success: true, log, cancha: opcion.cancha, hora: targetHora };
      }

      log.steps.push(`Error reservando opción ${i + 1}: ${result.error}`);
    }

    // None of the options worked
    const detail = `No se pudo reservar ninguna opción para ${fecha}`;
    log.steps.push(detail);
    log.success = false;
    appendLog(log);
    await bot.logout();
    updateReservationStatus(reservation.id, 'failed', detail);
    await notifyResult(reservation, false);
    return { success: false, error: detail, log };

  } catch (err) {
    log.steps.push(`Error: ${err.message}`);
    log.success = false;
    appendLog(log);
    try { await bot.logout(); } catch {}
    updateReservationStatus(reservation.id, 'failed', err.message);
    await notifyResult(reservation, false);
    return { success: false, error: err.message, log };
  }
}

// Execute with retries, then handle recurring/non-recurring cleanup
async function executeWithRetries(credentials, reservation) {
  const fecha = calculateFecha(reservation.schedule.type);

  // For recurring: mark the fecha we're executing for
  if (reservation.recurring) {
    setLastExecutedFecha(reservation.id, fecha);
  }

  // Reset status to pending for this execution cycle
  const config = loadConfig();
  const r = (config.reservations || []).find(r => r.id === reservation.id);
  if (r) {
    r.status = 'pending';
    r.attempts = 0;
    r.lastError = null;
    saveConfig(config);
  }

  let lastResult = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[${new Date().toISOString()}] Intento ${attempt}/${MAX_RETRIES}: ${reservation.name} (${fecha})`);

    lastResult = await executeReservation(credentials, reservation, fecha);

    if (lastResult.success) {
      console.log(`[${new Date().toISOString()}] Reserva OK: ${reservation.name}`);
      break;
    }

    // Re-read reservation status
    const current = loadConfig().reservations?.find(r => r.id === reservation.id);
    if (!current) {
      console.log(`[${new Date().toISOString()}] Reserva eliminada, deteniendo: ${reservation.name}`);
      return lastResult;
    }
    if (current.status === 'failed') {
      console.log(`[${new Date().toISOString()}] Reserva marcada como fallida, no se reintenta: ${reservation.name}`);
      break;
    }

    if (attempt < MAX_RETRIES) {
      console.log(`[${new Date().toISOString()}] Reintentando en ${RETRY_DELAY_MS / 1000}s...`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  // If still pending after all retries (shouldn't normally happen, but just in case)
  const final = loadConfig().reservations?.find(r => r.id === reservation.id);
  if (final && final.status === 'pending') {
    updateReservationStatus(reservation.id, 'failed', `Sin éxito después de ${MAX_RETRIES} intentos`);
    await notifyResult(reservation, false);
  }

  // Cleanup for non-recurring reservations
  if (!reservation.recurring) {
    console.log(`[${new Date().toISOString()}] Reserva no recurrente "${reservation.name}" finalizada, eliminando...`);
    deleteReservationFromConfig(reservation.id);
  }

  return lastResult;
}

// --- Scheduler ---

let scheduledJobs = {};

function scheduleReservation(reservation, credentials) {
  const id = reservation.id;
  if (scheduledJobs[id]) {
    scheduledJobs[id].stop();
    delete scheduledJobs[id];
  }

  if (!reservation.schedule?.enabled) return;
  // Don't skip ok/failed for recurring - they execute again next week
  if (!reservation.recurring && (reservation.status === 'ok' || reservation.status === 'failed')) return;

  const targetDay = reservation.dia; // 0=Domingo, 1=Lunes, ..., 6=Sábado
  const schedType = reservation.schedule.type;

  if (reservation.recurring) {
    // Weekly cron
    // Morning: execute at 19:59 on (targetDay - 1)
    // Afternoon: execute at 07:59 on targetDay
    let cronDay;
    if (schedType === 'morning') {
      cronDay = (targetDay - 1 + 7) % 7; // Day before
    } else {
      cronDay = targetDay;
    }
    const cronTime = schedType === 'morning' ? '59 19' : '59 7';
    const cronExpr = `${cronTime} * * ${cronDay}`;

    scheduledJobs[id] = cron.schedule(cronExpr, async () => {
      console.log(`[${new Date().toISOString()}] Cron semanal disparado: ${reservation.name}`);
      // Re-read reservation in case it was deleted
      const config = loadConfig();
      const current = config.reservations?.find(r => r.id === id);
      if (!current) {
        console.log(`Reserva ${id} ya no existe, deteniendo cron`);
        if (scheduledJobs[id]) { scheduledJobs[id].stop(); delete scheduledJobs[id]; }
        return;
      }
      await executeWithRetries(credentials, current);
    }, { timezone: 'America/Argentina/Buenos_Aires' });

    const execDayName = DIAS[cronDay];
    const execTime = schedType === 'morning' ? '19:59' : '07:59';
    console.log(`Reserva recurrente "${reservation.name}" programada: ${execDayName} a las ${execTime} → reservar ${DIAS[targetDay]}`);

  } else {
    // One-time: calculate the next occurrence and schedule for that specific date
    const now = getBuenosAiresNow();
    const today = now.getDay();
    let daysUntil = targetDay - today;
    if (daysUntil <= 0) daysUntil += 7;

    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + daysUntil);

    // Execution date/time
    let execDate;
    if (schedType === 'morning') {
      execDate = new Date(targetDate);
      execDate.setDate(execDate.getDate() - 1);
      execDate.setHours(19, 59, 0, 0);
    } else {
      execDate = new Date(targetDate);
      execDate.setHours(7, 59, 0, 0);
    }

    // If execution window already passed, execute immediately
    if (now >= execDate) {
      console.log(`[${now.toISOString()}] Ventana ya pasó para "${reservation.name}", ejecutando ahora...`);
      executeWithRetries(credentials, reservation);
      return;
    }

    const cronDay = execDate.getDate();
    const cronMonth = execDate.getMonth() + 1;
    const cronMinute = schedType === 'morning' ? 59 : 59;
    const cronHour = schedType === 'morning' ? 19 : 7;
    const cronExpr = `${cronMinute} ${cronHour} ${cronDay} ${cronMonth} *`;

    scheduledJobs[id] = cron.schedule(cronExpr, async () => {
      console.log(`[${new Date().toISOString()}] Cron one-time disparado: ${reservation.name}`);
      const config = loadConfig();
      const current = config.reservations?.find(r => r.id === id);
      if (!current) return;
      await executeWithRetries(credentials, current);
      // Cleanup done inside executeWithRetries for non-recurring
    }, { timezone: 'America/Argentina/Buenos_Aires' });

    const schedLabel = `${cronDay}/${cronMonth} a las ${cronHour}:${String(cronMinute).padStart(2, '0')}`;
    console.log(`Reserva única "${reservation.name}" programada para ${schedLabel} → reservar ${DIAS[targetDay]} ${formatFecha(targetDate)}`);
  }
}

// On startup: re-schedule all active reservations
async function loadSchedules() {
  if (!CREDENTIALS.email) {
    console.log('[STARTUP] CAEP_EMAIL no configurado en .env, no se programan reservas');
    return;
  }

  const config = loadConfig();
  const now = getBuenosAiresNow();

  for (const r of config.reservations || []) {
    if (!r.schedule?.enabled) continue;

    if (r.recurring) {
      // Always re-schedule recurring reservations
      scheduleReservation(r, CREDENTIALS);

      // Check if we missed this week's execution
      const targetDay = r.dia;
      const today = now.getDay();
      const schedType = r.schedule.type;

      // Calculate this week's execution window
      let daysToTarget = targetDay - today;
      // Look at this week's target day (could be in the past)
      const thisWeekTarget = new Date(now);
      thisWeekTarget.setDate(thisWeekTarget.getDate() + daysToTarget);
      const thisWeekFecha = formatFecha(thisWeekTarget);

      let execDate;
      if (schedType === 'morning') {
        execDate = new Date(thisWeekTarget);
        execDate.setDate(execDate.getDate() - 1);
        execDate.setHours(19, 59, 0, 0);
      } else {
        execDate = new Date(thisWeekTarget);
        execDate.setHours(7, 59, 0, 0);
      }

      // If the execution window passed and we haven't executed for this fecha
      if (now >= execDate && r.lastExecutedFecha !== thisWeekFecha) {
        // Also check that the target day hasn't fully passed (we can still reserve today's slots)
        const targetEndOfDay = new Date(thisWeekTarget);
        targetEndOfDay.setHours(23, 59, 59, 999);
        if (now <= targetEndOfDay) {
          console.log(`[STARTUP] Reserva recurrente "${r.name}" - ventana pasó para ${thisWeekFecha}, ejecutando ahora...`);
          executeWithRetries(CREDENTIALS, r);
        }
      }
    } else {
      // Non-recurring: only if still pending
      if (r.status === 'ok' || r.status === 'failed') {
        // Clean up completed non-recurring reservations
        deleteReservationFromConfig(r.id);
        continue;
      }
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
