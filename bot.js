const axios = require('axios');

const BASE_URL = 'https://caeptenis.rand.inm.me';

// El sitio de CAEP (sistema "salt" de Rand Online) migró de ASP clásico (.asp)
// a ASP.NET (.aspx/.ashx) en sept-2026. Endpoints actuales:
//   POST /Login.aspx                          -> login, responde JSON {ok, redirect}
//   GET  /ConectorCombo.ashx                  -> combos (búsqueda de jugadores)
//   GET  /ConectorValor.ashx?valo_orig=GETDBVALUE  -> funciones DEV_* (check jugador, turnos)
//   POST /Reservas.aspx                        -> alta de reserva (2 pasos: VALIDAR luego ALTA)
// Las respuestas de submit son JSON: éxito {ok:true, redirect|message|html|eval},
// error {ok:false, error|message}.

function parseJson(data) {
  if (data == null) return null;
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
}

class TenisBot {
  constructor() {
    this.cookies = '';
    this.loggedIn = false;
    this.userId = null;   // ID de socio del titular (va fijo como jugador 1)
    this.userName = null;
  }

  _client() {
    return axios.create({
      baseURL: BASE_URL,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': this.cookies,
      },
      maxRedirects: 0,
      validateStatus: s => s < 400,
    });
  }

  _extractCookies(res) {
    const setCookies = res.headers['set-cookie'];
    if (!setCookies) return;
    const parsed = setCookies.map(c => c.split(';')[0]);
    const existing = Object.fromEntries(
      this.cookies.split('; ').filter(Boolean).map(c => c.split('='))
    );
    for (const c of parsed) {
      const [k, ...v] = c.split('=');
      existing[k] = v.join('=');
    }
    this.cookies = Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async login(email, password) {
    // 1. GET a la página de ingreso para obtener la cookie de sesión (ASP.NET_SessionId)
    const initRes = await this._client().get('/Default.aspx?formato=INGRESAR');
    this._extractCookies(initRes);

    // 2. POST de credenciales -> JSON {ok, redirect} | {ok:false, error/message}
    const body = `Valo_Orig=INGRESAR&Valo_Dest=&txt_email=${encodeURIComponent(email)}&txt_password=${encodeURIComponent(password)}`;
    const res = await this._client().post('/Login.aspx', body);
    this._extractCookies(res);

    const data = parseJson(res.data);
    if (!data || data.ok !== true) {
      const err = (data && (data.error || data.message)) || 'Credenciales inválidas';
      return { success: false, error: err };
    }
    this.loggedIn = true;

    // 3. Cargar el form de alta: registra los combos en la sesión (necesario para
    //    ConectorCombo.ashx) y expone el ID/nombre del titular (cbCliente1, precargado).
    try {
      const altaRes = await this._client().get('/Default.aspx?formato=FRM-RESERVA&subformato=ALTA-RESERVA');
      this._extractCookies(altaRes);
      const html = typeof altaRes.data === 'string' ? altaRes.data : '';
      const m = html.match(/CargarComboS2\(\s*['"]cbCliente1['"][\s\S]*?id:\s*['"](\d+)['"][\s\S]*?text:\s*['"]([^'"]*)['"]/);
      if (m) {
        this.userId = m[1];
        this.userName = m[2].trim();
      }
    } catch { /* no bloquea el login */ }

    return { success: true, userId: this.userId, userName: this.userName };
  }

  async searchPlayers(term) {
    if (!this.loggedIn) throw new Error('No logueado');
    const res = await this._client().get('/ConectorCombo.ashx', {
      params: { idCombo: 'CLIENTE-FILTRO-CATE', term },
    });
    return parseJson(res.data) || []; // [{id, text}, ...]
  }

  async checkPlayerCanReserve(playerId) {
    if (!this.loggedIn) throw new Error('No logueado');
    const res = await this._client().get('/ConectorValor.ashx', {
      params: {
        valo_orig: 'GETDBVALUE',
        valo_func: 'DEV_ENTI_PUEDE_RESERVAR',
        valo_id: `C,${playerId}`,
      },
    });
    // "OK" o un código de motivo: DEUDASALDO, DEUDAABONO, RESERVAPENDIENTE, ...
    return res.data;
  }

  async getAvailableSlots(cantPers, fecha) {
    if (!this.loggedIn) throw new Error('No logueado');
    // cantPers: 2 o 4, fecha: "DD/MM/YYYY"
    const res = await this._client().get('/ConectorValor.ashx', {
      params: {
        valo_orig: 'GETDBVALUE',
        valo_func: 'DEV_ITEMS_PEDIDO_PERIODOS',
        valo_id: `${cantPers},${fecha},1`,
      },
    });
    // JSON array [{id, text}]. Formato nuevo:
    //   id:   "269860|1"       (idReserva|especialidad)
    //   text: "17:45 - CA3"    (hora - CAncha)
    // Cuando las inscripciones NO están abiertas, el sitio devuelve un placeholder
    // [{id:"0|0", text:"Sin disponibilidad"}]. Lo filtramos: array vacío = "aún
    // cerrado / sin cupo" → el que llama sigue reintentando con el horario pedido.
    const data = parseJson(res.data);
    if (!Array.isArray(data)) return [];
    return data.filter(s =>
      s && s.id && s.id !== '0|0' && !/sin disponibilidad/i.test(s.text || ''));
  }

  async makeReservation({ playerIds, cantPers, fecha, horarioId }) {
    if (!this.loggedIn) throw new Error('No logueado');

    // El titular (this.userId) va SIEMPRE como jugador 1 (cbCliente1, fijo en la web).
    const owner = this.userId ? String(this.userId) : null;
    const others = (playerIds || []).map(String).filter(id => id && id !== owner);
    const finalPlayers = (owner ? [owner, ...others] : others).slice(0, 4);
    const cant = cantPers || (finalPlayers.length >= 4 ? 4 : 2);

    const buildBody = (valoFunc) => {
      const p = new URLSearchParams();
      p.set('Valo_Orig', 'FRM-RESERVA');
      p.set('Valo_Func', valoFunc);
      p.set('Valo_Id', '');
      p.set('Valo_Jugadores', finalPlayers.join(','));
      p.set('Valo_CantPers', String(cant));
      for (let i = 1; i <= 4; i++) p.set('cbCliente' + i, finalPlayers[i - 1] || '');
      p.set('cbFecha', fecha);
      p.set('cbHorario', horarioId);
      return p.toString();
    };

    // Paso 1: validar restricciones. Si falla (ok:false) devolvemos el motivo.
    const valRes = await this._client().post('/Reservas.aspx', buildBody('VALIDAR-RESTRICCION-RESERVA'));
    const val = parseJson(valRes.data);
    if (val && val.ok === false) {
      return { success: false, error: val.error || val.message || 'Restricción de reserva' };
    }

    // Paso 2: alta efectiva.
    const altaRes = await this._client().post('/Reservas.aspx', buildBody('ALTA-RESERVA'));
    const alta = parseJson(altaRes.data);
    if (alta && alta.ok === true) {
      return { success: true, message: alta.message || alta.redirect || 'Reserva realizada' };
    }
    return { success: false, error: (alta && (alta.error || alta.message)) || 'No se pudo reservar' };
  }

  async logout() {
    try {
      await this._client().get('/Default.aspx?formato=SALIR');
    } catch {}
    this.loggedIn = false;
    this.cookies = '';
  }
}

module.exports = TenisBot;
