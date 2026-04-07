const axios = require('axios');

const BASE_URL = 'https://caeptenis.rand.inm.me';

class TenisBot {
  constructor() {
    this.cookies = '';
    this.loggedIn = false;
    this.userId = null;
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
    // Merge with existing cookies
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
    const body = `Valo_Orig=INGRESAR&Valo_Dest=&txt_email=${encodeURIComponent(email)}&txt_password=${encodeURIComponent(password)}`;

    // First GET to get session cookie
    const initRes = await this._client().get('/index.asp?formato=INGRESAR');
    this._extractCookies(initRes);

    // POST login
    const res = await this._client().post('/salt/EnviarConsulta.asp', body);
    this._extractCookies(res);

    const data = res.data;
    if (typeof data === 'string' && data.startsWith('Redir:')) {
      this.loggedIn = true;

      // Follow redirect
      const redirUrl = data.substring(6);
      const pageRes = await this._client().get(redirUrl);
      this._extractCookies(pageRes);

      // Get user name from PERFIL page
      const perfilRes = await this._client().get('/index.asp?formato=PERFIL');
      this._extractCookies(perfilRes);
      const perfilHtml = perfilRes.data;

      // Try multiple patterns - attribute order varies
      const namePatterns = [
        /name="txt_nombre"[^>]*value="([^"]+)"/i,
        /value="([^"]+)"[^>]*name="txt_nombre"/i,
        /name='txt_nombre'[^>]*value='([^']+)'/i,
        /id="txt_nombre"[^>]*value="([^"]+)"/i,
        /txt_nombre[^>]*value="([^"]+)"/i,
      ];
      for (const pat of namePatterns) {
        const m = perfilHtml.match(pat);
        if (m) {
          this.userName = m[1].trim();
          break;
        }
      }

      if (!this.userName) {
        // Log a snippet around txt_nombre for debugging
        const idx = perfilHtml.indexOf('txt_nombre');
        if (idx !== -1) {
          console.log('[DEBUG] txt_nombre context:', perfilHtml.substring(Math.max(0, idx - 80), idx + 120));
        } else {
          console.log('[DEBUG] txt_nombre NOT found in PERFIL page. Page length:', perfilHtml.length);
          // Try to find any name-like field
          const anyName = perfilHtml.match(/nombre[^>]*value="([^"]+)"/i);
          if (anyName) {
            console.log('[DEBUG] Found alternative nombre field:', anyName[0]);
            this.userName = anyName[1].trim();
          }
        }
      }

      // Get user ID by searching for own name in players list
      if (this.userName) {
        const surname = this.userName.split(' ').pop(); // last word as surname
        const searchRes = await this._client().get('/salt/conectorJSONSalt.asp', {
          params: { idCombo: 'CLIENTE-FILTRO-CATE', term: surname },
        });
        const results = typeof searchRes.data === 'string' ? JSON.parse(searchRes.data) : searchRes.data;
        if (Array.isArray(results)) {
          // Match by checking if the search result contains parts of the user's name
          const nameParts = this.userName.toUpperCase().split(' ').filter(p => p.length > 2);
          const match = results.find(r =>
            nameParts.every(part => r.text.toUpperCase().includes(part))
          );
          if (match) this.userId = match.id;
        }
      }

      return { success: true, userId: this.userId, userName: this.userName };
    } else if (typeof data === 'string' && data.startsWith('Messg:')) {
      return { success: false, error: data.substring(6) };
    }
    return { success: false, error: 'Respuesta inesperada del servidor' };
  }

  async searchPlayers(term) {
    if (!this.loggedIn) throw new Error('No logueado');
    const res = await this._client().get('/salt/conectorJSONSalt.asp', {
      params: { idCombo: 'CLIENTE-FILTRO-CATE', term },
    });
    return res.data; // [{id, text}, ...]
  }

  async checkPlayerCanReserve(playerId) {
    if (!this.loggedIn) throw new Error('No logueado');
    const res = await this._client().get('/salt/enviarconsulta.asp', {
      params: {
        valo_orig: 'GETDBVALUE',
        valo_func: 'DEV_ENTI_PUEDE_RESERVAR',
        valo_id: `C,${playerId}`,
      },
    });
    return res.data; // "OK" or error reason
  }

  async getAvailableSlots(cantPers, fecha) {
    if (!this.loggedIn) throw new Error('No logueado');
    // cantPers: 2 or 4, fecha: "DD/MM/YYYY"
    const res = await this._client().get('/salt/enviarconsulta.asp', {
      params: {
        valo_orig: 'GETDBVALUE',
        valo_func: 'DEV_ITEMS_PEDIDO_PERIODOS',
        valo_id: `${cantPers},${fecha},1`,
      },
    });
    // Response is JSON array [{id, text}, ...]
    // text format like "CANCHA 1 - 09:00 a 10:00"
    // id format like "12249|09:00"
    const data = res.data;
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return []; }
    }
    return data || [];
  }

  async makeReservation({ playerIds, cantPers, fecha, horarioId }) {
    if (!this.loggedIn) throw new Error('No logueado');

    const body = [
      'Valo_Orig=FRM-PEDIDO',
      'Valo_Func=ALTA-RESERVA',
      `Valo_Jugadores=${playerIds.join(',')}`,
      `Valo_CantPers=${cantPers}`,
      `cbFecha=${encodeURIComponent(fecha)}`,
      `cbHorario=${encodeURIComponent(horarioId)}`,
    ].join('&');

    const res = await this._client().post('/salt/EnviarConsulta.asp', body);
    const data = res.data;

    if (typeof data === 'string') {
      if (data.startsWith('Redir:')) return { success: true, redirect: data.substring(6) };
      if (data.startsWith('Messg:')) return { success: false, error: data.substring(6) };
      if (data.startsWith('Eval:')) return { success: true, eval: data.substring(5) };
      // HTML response — likely success
      return { success: true, html: data.substring(0, 200) };
    }
    return { success: false, error: 'Respuesta inesperada' };
  }

  async logout() {
    try {
      await this._client().get('/index.asp?formato=SALIR');
    } catch {}
    this.loggedIn = false;
    this.cookies = '';
  }
}

module.exports = TenisBot;
