// Los agentes vivos salen de ~/.claude/sessions/<pid>.json, que Claude Code escribe por cada proceso
// abierto con su estado (busy / idle / waiting). El título, la rama, la herramienta en uso y el límite
// de uso salen de su transcripción (~/.claude/projects/*/<sessionId>.jsonl). No depende de vscode.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SESSIONS = path.join(os.homedir(), '.claude', 'sessions');
const TAIL_BYTES = 384 * 1024;
const HEAD_BYTES = 64 * 1024;

// Un agente libre se muestra como "terminó" hasta este tiempo después de su último turno; después, en pausa.
const TERMINO_MAX_MS = 20 * 60 * 1000;
// Herramientas que esperan una respuesta de la persona.
const PREGUNTAN = new Set(['AskUserQuestion', 'ExitPlanMode']);

const TOOL_DETALLE = {
  Bash: 'corriendo un comando', Edit: 'editando', Write: 'escribiendo', Read: 'leyendo', Grep: 'buscando',
  Glob: 'buscando', WebFetch: 'leyendo la web', WebSearch: 'buscando en la web', Agent: 'con subagentes',
  Workflow: 'con subagentes', TodoWrite: 'planeando', AskUserQuestion: 'te hizo una pregunta',
  ExitPlanMode: 'espera que apruebes el plan', Artifact: 'publicando',
};

const cache = new Map(); // ruta -> { size, mtimeMs, info }

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function lines(text, dropFirst) {
  const ls = text.split('\n');
  if (dropFirst) ls.shift();
  const out = [];
  for (const l of ls) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* línea cortada */ }
  }
  return out;
}

function textoDe(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text').map(b => b.text).join(' ');
}

function limpiarPrompt(t) {
  return t.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Del principio del archivo: la carpeta donde se abrió la sesión (después Claude puede hacer `cd`
// a subcarpetas, pero la sesión sigue perteneciendo a esta) y el primer pedido, por si no hay título.
function inicio(file, size) {
  let carpeta = '', prompt = '';
  for (const d of lines(readSlice(file, 0, Math.min(size, HEAD_BYTES)), false)) {
    if (!carpeta && d.cwd) carpeta = d.cwd;
    if (!prompt && d.type === 'user' && !d.isMeta && !d.isSidechain) {
      prompt = limpiarPrompt(textoDe(d.message && d.message.content));
    }
    if (carpeta && prompt) break;
  }
  return { carpeta, prompt };
}

// Modelos con ventana de contexto de 1 millón de tokens (los demás, 200 mil, salvo que se vea que la
// sesión ya pasó ese número).
const MODELOS_1M = new Set(['claude-opus-5-5', 'claude-fable-5-1']);
const CHUNK = 1024 * 1024;

// El costo de la sesión (`cost-state`) lo anota Claude Code de a ratos y puede no estar en el final del
// archivo: la primera vez se busca hacia atrás; después, solo en lo que se agregó desde la lectura anterior.
function costoDe(text) {
  let costo = null;
  for (const l of text.split('\n')) {
    if (!l.includes('"cost-state"')) continue;
    try { const d = JSON.parse(l); if (typeof d.totalCostUSD === 'number') costo = d.totalCostUSD; } catch { /* cortada */ }
  }
  return costo;
}

function ultimoCosto(file, size, previo) {
  if (previo && previo.size <= size) {
    const nuevo = costoDe(readSlice(file, previo.size, Math.min(size - previo.size, 8 * CHUNK)));
    return nuevo !== null ? nuevo : previo.costo;
  }
  for (let fin = size; fin > 0; fin -= CHUNK) {
    const ini = Math.max(0, fin - CHUNK - 64 * 1024); // con solapamiento, para no cortar una línea
    const c = costoDe(readSlice(file, ini, fin - ini));
    if (c !== null) return c;
  }
  return null;
}

// Cada compactación del contexto deja en la transcripción una línea `"subtype":"compact_boundary"`. Se
// cuentan sobre el texto crudo: la primera vez en todo el archivo; después, solo en lo agregado.
const MARCA_COMPACTACION = Buffer.from('"subtype":"compact_boundary"');

function contarCompactaciones(file, size, previo) {
  const solape = MARCA_COMPACTACION.length - 1; // para no perder una marca partida entre dos lecturas
  let desde = 0, n = 0;
  if (previo && previo.size <= size) { desde = Math.max(0, previo.size - solape); n = previo.compactaciones || 0; }
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK + solape);
    for (let ini = desde; ini < size; ini += CHUNK) {
      const leidos = fs.readSync(fd, buf, 0, Math.min(buf.length, size - ini), ini);
      const trozo = buf.subarray(0, leidos);
      // Una marca que empieza en el solape se cuenta en la lectura siguiente.
      for (let i = trozo.indexOf(MARCA_COMPACTACION); i !== -1 && i < CHUNK; i = trozo.indexOf(MARCA_COMPACTACION, i + 1)) n++;
    }
  } finally {
    fs.closeSync(fd);
  }
  return n;
}

function analizar(file, size, previo) {
  const truncado = size > TAIL_BYTES;
  const entries = lines(readSlice(file, Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)), truncado);
  const info = {
    titulo: '', branch: '', cwd: '', entrypoint: '',
    ultimo: null, // 'prompt' | 'tool_result' | 'tool_use' | 'end_turn' | 'interrumpido' | 'error'
    pendientes: new Map(), // tool_use id -> nombre
    ultimaTool: '', limitado: false, hayAssistant: false,
    costo: null, contexto: null, modelo: '',
  };
  let customTitle = '', aiTitle = '', agentName = '';
  for (const d of entries) {
    if (d.type === 'cost-state' && typeof d.totalCostUSD === 'number') info.costo = d.totalCostUSD;
    if (d.customTitle) customTitle = d.customTitle;
    if (d.aiTitle) aiTitle = d.aiTitle;
    if (d.agentName) agentName = d.agentName;
    if (d.gitBranch) info.branch = d.gitBranch;
    if (d.cwd) info.cwd = d.cwd;
    if (d.entrypoint) info.entrypoint = d.entrypoint;
    if (d.isSidechain) continue;
    const m = d.message || {};
    if (d.type === 'assistant') {
      info.hayAssistant = true;
      const content = Array.isArray(m.content) ? m.content : [];
      for (const b of content) {
        if (b.type === 'tool_use') { info.pendientes.set(b.id, b.name); info.ultimaTool = b.name; }
      }
      // Contexto usado = lo que el modelo tenía cargado en esta respuesta (nuevo + guardado de antes).
      const u = m.usage;
      if (u && m.model && m.model !== '<synthetic>') {
        info.contexto = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        info.modelo = m.model;
      }
      // El aviso de límite lo escribe Claude Code con el tipo de error marcado; el texto no se mira (un
      // agente que habla de límites no cuenta, y la frase puede cambiar). Ejemplos en pruebas/limite/.
      info.limitado = d.isApiErrorMessage === true && d.error === 'rate_limit';
      if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') info.ultimo = 'end_turn';
      else if (content.some(b => b.type === 'tool_use')) info.ultimo = 'tool_use';
    } else if (d.type === 'user' && !d.isMeta) {
      const c = m.content;
      if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) {
        for (const b of c) if (b.type === 'tool_result') info.pendientes.delete(b.tool_use_id);
        info.ultimo = 'tool_result';
      } else {
        const t = textoDe(c);
        if (/\[Request interrupted by user/.test(t)) { info.ultimo = 'interrumpido'; info.pendientes.clear(); }
        else if (t.trim()) { info.ultimo = 'prompt'; info.limitado = false; }
      }
    } else if (d.type === 'system' && d.subtype === 'api_error') {
      // Es un reintento en curso: si se agotan, Claude Code escribe el aviso de arriba.
      info.ultimo = 'error';
    }
  }
  const ini = inicio(file, size);
  info.carpeta = ini.carpeta || info.cwd;
  info.titulo = customTitle || agentName || aiTitle || ini.prompt;
  if (info.costo === null) info.costo = ultimoCosto(file, size, previo && { size: previo.size, costo: previo.info.costo });
  info.compactaciones = contarCompactaciones(file, size, previo && { size: previo.size, compactaciones: previo.info.compactaciones });
  return info;
}

// Ventana de contexto de la sesión, en tokens.
function ventanaDe(info) {
  if (MODELOS_1M.has(info.modelo) || /\[1m\]/i.test(info.modelo) || (info.contexto || 0) > 200000) return 1000000;
  return 200000;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const rutaTranscripcion = new Map(); // sessionId -> ruta del .jsonl

function buscarTranscripcion(sessionId) {
  const conocida = rutaTranscripcion.get(sessionId);
  if (conocida && fs.existsSync(conocida)) return conocida;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(PROJECTS, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) { rutaTranscripcion.set(sessionId, p); return p; }
  }
  return null;
}

function infoTranscripcion(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let c = cache.get(file);
  if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
    c = { size: st.size, mtimeMs: st.mtimeMs, info: analizar(file, st.size, c) };
    cache.set(file, c);
  }
  return c.info;
}

function estadoDe(proc, info, ahora) {
  const pend = info ? [...info.pendientes.values()] : [];
  if (info && info.limitado) return { estado: 'limited', detalle: 'se quedó sin cuota' };
  const pregunta = pend.find(n => PREGUNTAN.has(n));
  if (proc.status === 'waiting' || pregunta) {
    const detalle = proc.needs || (pregunta && TOOL_DETALLE[pregunta]) ||
      (proc.waitingFor === 'dialog open' ? 'espera tu respuesta' : proc.waitingFor) || 'espera tu respuesta';
    return { estado: 'blocked', detalle };
  }
  if (proc.status === 'busy') {
    const tool = pend.length ? pend[pend.length - 1] : '';
    return { estado: 'working', detalle: TOOL_DETALLE[tool] || (tool ? `usando ${tool}` : 'pensando') };
  }
  // `shell`: libre, pero con un comando que dejó corriendo en segundo plano (se resuelve en leerSesiones)
  if (proc.status === 'idle' || proc.status === 'shell') {
    const desde = ahora - (proc.statusUpdatedAt || proc.updatedAt || ahora);
    return desde <= TERMINO_MAX_MS
      ? { estado: 'done', detalle: 'te respondió' }
      : { estado: 'idle', detalle: 'esperando' };
  }
  return { estado: 'unknown', detalle: proc.status || '' };
}

const PRIORIDAD = { blocked: 0, limited: 1, done: 2, working: 3, unknown: 4, idle: 5 };

// Trabajo en segundo plano: cuando el agente principal te devuelve el turno pero dejó subagentes (o un
// workflow) trabajando, Claude lo informa como libre. Sus subagentes escriben su propia transcripción en
// <transcripción sin .jsonl>/subagents/*.jsonl (y los workflows, más adentro): los que se escribieron hace
// poco están trabajando.
const FONDO_ACTIVO_MS = 45 * 1000;

// Comandos que un agente dejó corriendo en segundo plano (un servidor, un build largo): cada comando que
// corre Claude es una shell hija de su proceso que arranca cargando ~/.claude/shell-snapshots/snapshot-…
function comandosDeFondoPorPid() {
  let salida = '';
  try { salida = require('child_process').execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 3000 }); }
  catch { return new Map(); }
  const porPadre = new Map();
  for (const l of salida.split('\n')) {
    const m = l.match(/^\s*\d+\s+(\d+)\s+(.*)$/);
    if (!m || !m[2].includes('.claude/shell-snapshots/snapshot-')) continue;
    porPadre.set(Number(m[1]), (porPadre.get(Number(m[1])) || 0) + 1);
  }
  return porPadre;
}

function subagentesActivos(transcripcion, ahora) {
  const dir = transcripcion.replace(/\.jsonl$/, '');
  let activos = 0;
  const recorrer = (d, nivel) => {
    let entradas = [];
    try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const ruta = path.join(d, e.name);
      if (e.isDirectory()) { if (nivel < 3) recorrer(ruta, nivel + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try { if (ahora - fs.statSync(ruta).mtimeMs <= FONDO_ACTIVO_MS) activos++; } catch { /* se borró */ }
    }
  };
  recorrer(dir, 0);
  return activos;
}

function mismoTitulo(a, b) {
  const norm = s => (s || '').replace(/(…|\.\.\.)\s*$/, '').trim().toLowerCase();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 6 && (x.startsWith(y) || y.startsWith(x)));
}

// Una pestaña pineada de la que no se sabe la sesión: se busca por título entre las transcripciones
// recientes de su carpeta (~/.claude/projects/<carpeta con / y . cambiados por ->/).
function buscarPorTitulo(carpeta, titulo) {
  const dir = path.join(PROJECTS, carpeta.replace(/[^a-zA-Z0-9]/g, '-'));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).slice(0, 40);
  } catch { return null; }
  for (const { f } of files) {
    const file = path.join(dir, f);
    let info;
    try { info = infoTranscripcion(file); } catch { continue; }
    if (info && mismoTitulo(info.titulo, titulo)) {
      const id = path.basename(f, '.jsonl');
      rutaTranscripcion.set(id, file);
      return id;
    }
  }
  return null;
}

const idPorTitulo = new Map(); // carpeta|título -> sessionId (para no buscar cada 2 s)

function tarjeta(id, proc, info, carpeta, estado, detalle, ahora) {
  return {
    id,
    pid: proc ? proc.pid : null,
    titulo: (info && info.titulo) || (proc && proc.name) || 'Sesión nueva',
    branch: info ? info.branch : '',
    repo: carpeta ? path.basename(carpeta) : '',
    carpeta,
    estado, detalle,
    edadMs: proc ? ahora - (proc.statusUpdatedAt || proc.updatedAt || proc.startedAt || ahora) : 0,
    nacio: proc ? proc.startedAt || 0 : 0,
    heroe: hash(id) % 6,
    enVsCode: proc ? proc.entrypoint === 'claude-vscode' : true,
    pineada: false,
    costo: info && typeof info.costo === 'number' ? Math.round(info.costo * 100) / 100 : null,
    contexto: info && info.contexto ? info.contexto : null,
    ventana: info ? ventanaDe(info) : 200000,
    compactaciones: info ? info.compactaciones || 0 : 0,
    subagentes: 0,
    esperandoSubagentes: false,
  };
}

// ---------- Nivel de gasto: siempre comparado con el uso de la propia persona ----------
// Con 3 o más sesiones abiertas con gasto, se comparan entre sí (tercios). Con menos, contra las sesiones
// de la persona en las últimas 2 semanas (en qué tercio de su historial cae). Sin historial, sin nivel.
const HISTORIAL_DIAS = 14;
const HISTORIAL_CADA_MS = 60 * 60 * 1000;
const HISTORIAL_MAX_BYTES = 4 * CHUNK; // por archivo: el costo suele estar cerca del final
const costoHistorial = new Map(); // ruta -> { size, mtimeMs, costo }
let historial = { calculado: 0, costos: [] };

function costoDesdeElFinal(file, size) {
  for (let fin = size, leidos = 0; fin > 0 && leidos < HISTORIAL_MAX_BYTES; fin -= CHUNK, leidos += CHUNK) {
    const ini = Math.max(0, fin - CHUNK - 64 * 1024);
    const c = costoDe(readSlice(file, ini, fin - ini));
    if (c !== null) return c;
  }
  return null;
}

function costosDelHistorial() {
  const ahora = Date.now();
  if (ahora - historial.calculado < HISTORIAL_CADA_MS) return historial.costos;
  const costos = [], vistos = new Set();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { dirs = []; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(PROJECTS, d)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(PROJECTS, d, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (ahora - st.mtimeMs > HISTORIAL_DIAS * 86400000) continue;
      vistos.add(file);
      let c = costoHistorial.get(file);
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
        let costo = null;
        try { costo = costoDesdeElFinal(file, st.size); } catch { costo = null; }
        c = { size: st.size, mtimeMs: st.mtimeMs, costo };
        costoHistorial.set(file, c);
      }
      if (typeof c.costo === 'number' && c.costo >= 0.01) costos.push(c.costo);
    }
  }
  for (const k of costoHistorial.keys()) if (!vistos.has(k)) costoHistorial.delete(k);
  historial = { calculado: ahora, costos };
  return costos;
}

function asignarNivelesDeGasto(sesiones) {
  const conGasto = sesiones.filter(s => typeof s.costo === 'number' && s.costo >= 0.01);
  for (const s of sesiones) s.nivelGasto = null;
  if (conGasto.length >= 3) {
    const orden = [...conGasto].sort((a, b) => a.costo - b.costo);
    orden.forEach((s, i) => { s.nivelGasto = Math.min(2, Math.floor(i * 3 / orden.length)); });
    return;
  }
  const hist = costosDelHistorial();
  if (hist.length < 3) return;
  for (const s of conGasto) {
    const debajo = hist.filter(c => c < s.costo).length / hist.length;
    s.nivelGasto = debajo < 1 / 3 ? 0 : debajo < 2 / 3 ? 1 : 2;
  }
}

/**
 * Los agentes de Claude Code que están corriendo ahora, más las pestañas de Claude abiertas en VS Code
 * aunque su agente no esté corriendo. Primero las pineadas; dentro de cada grupo, las que te necesitan.
 */
function leerSesiones(pineadas = []) {
  let comandosFondo = null; // se consulta una vez por lectura, solo si hace falta
  const ahora = Date.now();
  const out = [];
  const vistos = new Set();
  let archivos = [];
  try { archivos = fs.readdirSync(SESSIONS).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of archivos) {
    let proc;
    try { proc = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8')); } catch { continue; }
    if (!proc.sessionId || !proc.pid || !vivo(proc.pid)) continue;
    if (proc.kind && proc.kind !== 'interactive') continue;
    if (vistos.has(proc.sessionId)) continue;
    vistos.add(proc.sessionId);
    const file = buscarTranscripcion(proc.sessionId);
    let info = null;
    try { info = file ? infoTranscripcion(file) : null; } catch { info = null; }
    let { estado, detalle } = estadoDe(proc, info, ahora);
    const sub = file ? subagentesActivos(file, ahora) : 0; // el slime de la tarjeta
    let esperandoSubagentes = false;
    if (estado === 'done' || estado === 'idle') { // también con status `shell` de Claude
      // Libre para Claude, pero con trabajo en segundo plano: subagentes o comandos que dejó corriendo
      esperandoSubagentes = sub > 0;
      if (!comandosFondo) comandosFondo = comandosDeFondoPorPid();
      const cmd = comandosFondo.get(proc.pid) || 0;
      const partes = [];
      if (sub) partes.push(`${sub} ${sub === 1 ? 'subagente trabajando' : 'subagentes trabajando'}`);
      if (cmd) partes.push(`${cmd} ${cmd === 1 ? 'comando corriendo' : 'comandos corriendo'}`);
      if (!partes.length && proc.status === 'shell') partes.push('comando corriendo'); // Claude lo informa aunque no veamos la shell
      if (partes.length) { estado = 'working'; detalle = `${partes.join(' y ')} en segundo plano`; }
    }
    const carpeta = proc.cwd || (info && info.carpeta) || '';
    const t = tarjeta(proc.sessionId, proc, info, carpeta, estado, detalle, ahora);
    t.subagentes = sub;
    t.esperandoSubagentes = esperandoSubagentes;
    out.push(t);
  }

  for (const p of pineadas) {
    let id = p.id;
    if (!id && p.carpeta) {
      const clave = `${p.carpeta}|${p.titulo}`;
      const previo = idPorTitulo.get(clave);
      // Lo no encontrado se reintenta al minuto (la conversación puede recibir su título más tarde).
      if (!previo || (!previo.id && ahora - previo.ts > 60 * 1000)) {
        const vivoConTitulo = out.find(s => s.carpeta === p.carpeta && mismoTitulo(s.titulo, p.titulo));
        idPorTitulo.set(clave, { id: vivoConTitulo ? vivoConTitulo.id : buscarPorTitulo(p.carpeta, p.titulo), ts: ahora });
      }
      id = idPorTitulo.get(clave).id;
    }
    if (!id) continue;
    const ya = out.find(s => s.id === id);
    const pineada = p.pineada !== false; // las versiones anteriores publicaban solo las pineadas
    if (ya) { ya.pineada = ya.pineada || pineada; continue; }
    // Pestaña sin agente corriendo (por ejemplo, después de reabrir VS Code): igual se muestra.
    const file = buscarTranscripcion(id);
    let info = null;
    try { info = file ? infoTranscripcion(file) : null; } catch { info = null; }
    const t = tarjeta(id, null, info, p.carpeta || (info && info.carpeta) || '', 'idle', 'agente sin abrir: tocala para retomarla', ahora);
    if (!info || !info.titulo) t.titulo = p.titulo;
    t.pineada = pineada;
    vistos.add(id);
    out.push(t);
  }

  const usados = new Set([...vistos].map(id => rutaTranscripcion.get(id)));
  for (const k of cache.keys()) if (!usados.has(k)) cache.delete(k);
  out.sort((a, b) => (b.pineada - a.pineada) || (PRIORIDAD[a.estado] - PRIORIDAD[b.estado]) || (b.nacio - a.nacio) ||
    a.titulo.localeCompare(b.titulo, 'es'));
  asignarNivelesDeGasto(out);
  return out;
}

module.exports = { leerSesiones, costosDelHistorial, subagentesActivos, comandosDeFondoPorPid, contarCompactaciones, analizar };
