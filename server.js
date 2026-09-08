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

// --- Slot matching (con fallback a la hora más cercana) ---

// Ventana máxima de diferencia respecto al horario pedido. Si el horario exacto
// no está, se reserva el turno disponible más cercano dentro de ±TIME_TOLERANCE_MIN.
const TIME_TOLERANCE_MIN = 60; // ±1 hora

function _toMinutes(hhmm) {
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// Slot nuevo: text "17:45 - CA3" → { minutes: 1065, court: 3 }
function _parseSlot(s) {
  const tm = String(s.text || '').match(/(\d{1,2}):(\d{2})/);
  const cm = String(s.text || '').match(/CA0*(\d+)/i);
  return {
    slot: s,
    minutes: tm ? parseInt(tm[1], 10) * 60 + parseInt(tm[2], 10) : null,
    court: cm ? parseInt(cm[1], 10) : null,
  };
}

// Ordena los slots disponibles por prioridad de reserva (opciones en su orden):
//   0) las opciones EXACTAS (misma cancha + hora exacta);
//   1) misma cancha, la hora más cercana a la opción (±tolerancia);
//   2) fallback: cualquier cancha, la hora más cercana.
// Es decir: primero las opciones exactas, y solo si ninguna está, lo más cercano.
// Devuelve candidatos { slot, cancha, hora } (cancha/hora reales del turno), sin
// duplicados, el mejor primero.
function rankSlots(slots, opciones, toleranceMin = TIME_TOLERANCE_MIN) {
  const parsed = (slots || []).map(_parseSlot).filter(p => p.minutes != null);
  const ranked = [];
  const seen = new Set();

  const pushCands = (opcion, { requireCourt, exactOnly }) => {
    const canchaNum = parseInt((opcion.cancha || '').match(/(\d+)/)?.[1], 10);
    const targetMin = _toMinutes(opcion.hora);
    if (targetMin == null) return;
    parsed
      .filter(p => exactOnly ? p.minutes === targetMin : Math.abs(p.minutes - targetMin) <= toleranceMin)
      .filter(p => !requireCourt || p.court === canchaNum)
      .sort((a, b) =>
        Math.abs(a.minutes - targetMin) - Math.abs(b.minutes - targetMin) ||
        a.minutes - b.minutes)
      .forEach(p => {
        if (seen.has(p.slot.id)) return;
        seen.add(p.slot.id);
        const hh = String(Math.floor(p.minutes / 60)).padStart(2, '0');
        const mm = String(p.minutes % 60).padStart(2, '0');
        ranked.push({
          slot: p.slot,
          cancha: p.court != null ? `Cancha ${p.court}` : (opcion.cancha || ''),
          hora: `${hh}:${mm}`,
        });
      });
  };

  const ops = opciones || [];
  // Pase 0: las opciones EXACTAS (misma cancha + hora exacta), en orden de prioridad.
  for (const opcion of ops) pushCands(opcion, { requireCourt: true, exactOnly: true });
  // Pase 1: misma cancha, la hora más cercana a cada opción (±tolerancia).
  for (const opcion of ops) pushCands(opcion, { requireCourt: true });
  // Pase 2: cualquier cancha, la hora más cercana a cada opción (fallback final).
  for (const opcion of ops) pushCands(opcion, { requireCourt: false });
  return ranked;
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

  // No hace falta programar nada: los disparos globales (12:00 y 20:00) intentan
  // todas las reservas activas. Se puede ejecutar manualmente con "Ejecutar".

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

// Single-shot execution (for manual trigger)
async function executeSingleAttempt(credentials, reservation, fecha) {
  const bot = new TenisBot();
  const opciones = reservation.opciones || [];
  const log = { reservation: reservation.name || reservation.id, steps: [] };

  try {
    log.steps.push('Iniciando login...');
    const loginResult = await bot.login(credentials.email, credentials.password);
    if (!loginResult.success) {
      log.steps.push(`Error login: ${loginResult.error}`);
      log.success = false;
      appendLog(log);
      return { success: false, error: loginResult.error, log };
    }
    log.steps.push(`Login OK: ${loginResult.userName}`);

    // El titular (this.userId, jugador 1 fijo en la web nueva) va siempre primero.
    const ownerId = loginResult.userId ? String(loginResult.userId) : null;
    const playerIds = ownerId
      ? [ownerId, ...reservation.players.map(p => String(p.id)).filter(id => id !== ownerId)].slice(0, 4)
      : reservation.players.map(p => String(p.id)).slice(0, 4);
    for (const pid of playerIds) {
      const check = await bot.checkPlayerCanReserve(pid);
      const checkTrimmed = (typeof check === 'string' ? check.trim() : '');
      if (checkTrimmed !== 'OK') {
        log.steps.push(`Jugador ${pid} no puede reservar (respuesta: "${checkTrimmed}")`);
        log.success = false;
        appendLog(log);
        await bot.logout();
        return { success: false, error: `Jugador ${pid}: ${checkTrimmed || '(respuesta vacía)'}`, log };
      }
    }
    log.steps.push('Todos los jugadores habilitados');

    const cantPers = playerIds.length >= 4 ? 4 : 2;
    const slots = await bot.getAvailableSlots(cantPers, fecha);
    log.steps.push(`${slots.length} turnos reales para ${fecha}`);

    if (!slots.length) {
      // getAvailableSlots filtra el placeholder "0|0": vacío = inscripciones aún
      // cerradas (o sin cupo). En el disparo automático se sigue reintentando.
      const msg = 'Inscripciones aún cerradas o sin cupo (no hay turnos reales todavía)';
      log.steps.push(msg);
      log.success = false;
      appendLog(log);
      return { success: false, error: msg, log };
    }

    log.steps.push(`Slots: ${slots.map(s => `[${s.id}] ${s.text}`).join(' | ')}`);

    const ranked = rankSlots(slots, opciones);
    for (const cand of ranked) {
      log.steps.push(`Intentando: ${cand.cancha} a las ${cand.hora} (${cand.slot.text})`);
      const result = await bot.makeReservation({ playerIds, cantPers, fecha, horarioId: cand.slot.id });

      if (result.success) {
        log.steps.push(`RESERVADA: ${cand.cancha} a las ${cand.hora}`);
        log.success = true;
        appendLog(log);
        await bot.logout();
        updateReservationStatus(reservation.id, 'ok', null);
        return { success: true, log };
      }
      log.steps.push(`Error reservando: ${result.error}`);
    }

    log.steps.push('No se pudo reservar ninguna opción');
    log.success = false;
    appendLog(log);
    await bot.logout();
    return { success: false, error: 'No se pudo reservar ninguna opción', log };

  } catch (err) {
    log.steps.push(`Error: ${err.message}`);
    log.success = false;
    appendLog(log);
    try { await bot.logout(); } catch {}
    return { success: false, error: err.message, log };
  }
}

// Execute reservation NOW (manual trigger)
app.post('/api/reservations/:id/execute', async (req, res) => {
  const config = loadConfig();
  const reservation = (config.reservations || []).find(r => r.id === req.params.id);
  if (!reservation) return res.json({ success: false, error: 'Reserva no encontrada' });

  const fecha = calculateFechaForReservation(reservation);
  const result = await executeSingleAttempt(CREDENTIALS, reservation, fecha);

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

// Parámetros de la "carrera" (primerear la apertura de 12:00 / 20:00):
// pre-login ~1 min antes, y en T0 polling rápido de turnos + reserva inmediata.
const RACE_POLL_MS = 400;         // frecuencia de polling durante la carrera
const RACE_DURATION_MS = 30000;   // cuánto insistir tras la apertura antes de rendirse

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Calculate fecha for a reservation (for manual execution or startup)
function calculateFechaForReservation(reservation) {
  const now = getBuenosAiresNow();
  const targetDay = reservation.dia;
  const today = now.getDay();
  let daysUntil = targetDay - today;
  if (daysUntil < 0) daysUntil += 7;
  if (daysUntil === 0) {
    // If it's the same day, use today for manual execution
  }
  const targetDate = new Date(now);
  targetDate.setDate(targetDate.getDate() + daysUntil);
  return formatFecha(targetDate);
}

// Ejecución con "carrera": pre-login, esperar la apertura (openHour:00) y ahí
// polling rápido de turnos + reserva inmediata. openHour = 12 o 20 (o null = ya).
async function executeWithRetries(credentials, reservation, openHour) {
  const fecha = calculateFechaForReservation(reservation);

  // Anti doble-reserva: si ya se reservó para esta fecha (recurrente), no repetir.
  if (reservation.recurring && reservation.lastExecutedFecha === fecha) {
    return { success: false, error: 'ya-reservado', silent: true };
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

  const bot = new TenisBot();
  const opciones = reservation.opciones || [];
  const log = { reservation: reservation.name || reservation.id, steps: [] };

  try {
    // 1. Login once
    log.steps.push('Iniciando login...');
    const loginResult = await bot.login(credentials.email, credentials.password);
    if (!loginResult.success) {
      log.steps.push(`Error login: ${loginResult.error}`);
      log.success = false;
      appendLog(log);
      updateReservationStatus(reservation.id, 'failed', loginResult.error);
      await notifyResult(reservation, false);
      if (!reservation.recurring) deleteReservationFromConfig(reservation.id);
      return { success: false, error: loginResult.error, log };
    }
    log.steps.push(`Login OK: ${loginResult.userName}`);

    // 2. Check players once
    // El titular (this.userId, jugador 1 fijo en la web nueva) va siempre primero.
    const ownerId = loginResult.userId ? String(loginResult.userId) : null;
    const playerIds = ownerId
      ? [ownerId, ...reservation.players.map(p => String(p.id)).filter(id => id !== ownerId)].slice(0, 4)
      : reservation.players.map(p => String(p.id)).slice(0, 4);
    for (const pid of playerIds) {
      const check = await bot.checkPlayerCanReserve(pid);
      const checkTrimmed = (typeof check === 'string' ? check.trim() : '');
      if (checkTrimmed !== 'OK') {
        log.steps.push(`Jugador ${pid} no puede reservar (respuesta: "${checkTrimmed}")`);
        log.success = false;
        appendLog(log);
        await bot.logout();
        updateReservationStatus(reservation.id, 'failed', `Jugador ${pid}: ${checkTrimmed || '(respuesta vacía)'}`);
        await notifyResult(reservation, false);
        if (!reservation.recurring) deleteReservationFromConfig(reservation.id);
        return { success: false, error: `Jugador ${pid}: ${checkTrimmed || '(respuesta vacía)'}`, log };
      }
    }
    log.steps.push('Todos los jugadores habilitados');

    const cantPers = playerIds.length >= 4 ? 4 : 2;

    // 3. Pre-warm listo (login + jugadores validados). Esperar hasta la apertura
    //    exacta (openHour:00:00). El cron dispara ~1 min antes para llegar caliente.
    if (openHour != null) {
      const now = getBuenosAiresNow();
      const msUntilOpen = ((openHour - now.getHours()) * 3600 - now.getMinutes() * 60 - now.getSeconds()) * 1000 - now.getMilliseconds();
      if (msUntilOpen > 0 && msUntilOpen < 5 * 60 * 1000) {
        log.steps.push(`Pre-login listo. Esperando ${Math.round(msUntilOpen / 1000)}s hasta la apertura (${openHour}:00)...`);
        await sleep(Math.max(0, msUntilOpen - 300)); // despertar ~300ms antes de T0
      }
    }

    // 4. Carrera: polling rápido de turnos desde T0 y reserva inmediata.
    console.log(`[${new Date().toISOString()}] Carrera iniciada: ${reservation.name} (${fecha})`);
    const raceDeadline = Date.now() + RACE_DURATION_MS;
    let sawSlots = false;

    while (Date.now() <= raceDeadline) {
      // ¿La reserva fue eliminada mientras corría la carrera?
      const current = loadConfig().reservations?.find(r => r.id === reservation.id);
      if (!current) {
        await bot.logout();
        return { success: false, error: 'Reserva eliminada', log };
      }

      const slots = await bot.getAvailableSlots(cantPers, fecha);

      if (slots.length) {
        if (!sawSlots) {
          sawSlots = true;
          log.steps.push(`Apertura detectada: ${slots.length} turnos. ${slots.map(s => `[${s.id}] ${s.text}`).join(' | ')}`);
        }
        // Misma cancha + hora más cercana, luego cualquier cancha (±tolerancia).
        const ranked = rankSlots(slots, opciones);
        for (const cand of ranked) {
          log.steps.push(`Intentando: ${cand.cancha} a las ${cand.hora} (${cand.slot.text})`);
          const result = await bot.makeReservation({ playerIds, cantPers, fecha, horarioId: cand.slot.id });
          if (result.success) {
            log.steps.push(`RESERVADA: ${cand.cancha} a las ${cand.hora}`);
            log.success = true;
            appendLog(log);
            await bot.logout();
            updateReservationStatus(reservation.id, 'ok', null);
            setLastExecutedFecha(reservation.id, fecha);
            await notifyResult(reservation, true, `${cand.cancha} - ${cand.hora}`);
            if (!reservation.recurring) deleteReservationFromConfig(reservation.id);
            return { success: true, log, cancha: cand.cancha, hora: cand.hora };
          }
          log.steps.push(`Error reservando: ${result.error}`);
        }
        // Había turnos pero no pudimos reservar (nos ganaron / sin opción válida):
        // seguimos la carrera por si se libera otro.
      }

      await sleep(RACE_POLL_MS);
    }

    await bot.logout();

    if (!sawSlots) {
      // La ventana no abrió para esta fecha en este ciclo. No es un error real
      // (brute-force 12/20 diario): reintenta en el próximo horario. Sin push.
      log.steps.push(`Sin apertura para ${fecha} en este ciclo (${openHour ?? '?'}:00). Reintenta en el próximo horario.`);
      log.success = false;
      appendLog(log);
      updateReservationStatus(reservation.id, 'pending', null);
      return { success: false, error: 'ventana-no-abierta', silent: true, log };
    }

    // Vimos turnos pero no logramos reservar: fallo real (perdimos la carrera).
    const detail = `Turnos abiertos pero no se pudo reservar para ${fecha}`;
    log.steps.push(detail);
    log.success = false;
    appendLog(log);
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
    if (!reservation.recurring) deleteReservationFromConfig(reservation.id);
    return { success: false, error: err.message, log };
  }
}

// --- Scheduler ---

let scheduledJobs = {};

// Las reservas ya no se programan una por una. Hay dos disparos GLOBALES diarios
// —12:00 y 20:00 (apertura de inscripciones)— que intentan TODAS las reservas
// activas. El cron dispara 1 min antes (11:59 / 19:59) para pre-loguear.
// A futuro se puede afinar por reserva (ej: sábado a la mañana → viernes 20:00).

// Dispara todas las reservas activas para una apertura (openHour = 12 o 20).
function runAllReservations(openHour) {
  if (!CREDENTIALS.email) return;
  const config = loadConfig();
  const activos = (config.reservations || []).filter(r =>
    r.schedule?.enabled && !(!r.recurring && r.status === 'ok')
  );
  console.log(`[${new Date().toISOString()}] Disparo ${openHour}:00 — ${activos.length} reserva(s) activa(s)`);
  // En paralelo: cada reserva es una sesión independiente y compiten a la vez.
  for (const r of activos) {
    executeWithRetries(CREDENTIALS, r, openHour).catch(err =>
      console.error(`Error en reserva "${r.name}":`, err.message));
  }
}

function installDailyTriggers() {
  for (const key of ['__open12', '__open20']) {
    if (scheduledJobs[key]) { scheduledJobs[key].stop(); delete scheduledJobs[key]; }
  }
  const tz = { timezone: 'America/Argentina/Buenos_Aires' };
  // Disparo 1 min antes para pre-login; executeWithRetries espera hasta T0 exacto.
  scheduledJobs['__open12'] = cron.schedule('59 11 * * *', () => runAllReservations(12), tz);
  scheduledJobs['__open20'] = cron.schedule('59 19 * * *', () => runAllReservations(20), tz);
  console.log('Disparos diarios instalados: 12:00 y 20:00 (Buenos Aires)');
}

// On startup: instalar los disparos diarios.
async function loadSchedules() {
  if (!CREDENTIALS.email) {
    console.log('[STARTUP] CAEP_EMAIL no configurado en .env, no se programan reservas');
    return;
  }
  installDailyTriggers();
}

// --- Start ---

const VERSION = '2.1.0';
const PORT = process.env.PORT || 3000;

app.get('/api/version', (req, res) => res.json({ version: VERSION }));

app.listen(PORT, () => {
  console.log(`Tenis Bot v${VERSION} corriendo en http://localhost:${PORT}`);
  loadSchedules();
});
