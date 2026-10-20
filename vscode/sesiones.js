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

function analizar(file, size) {
  const truncado = size > TAIL_BYTES;
  const entries = lines(readSlice(file, Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)), truncado);
  const info = {
    titulo: '', branch: '', cwd: '', entrypoint: '',
    ultimo: null, // 'prompt' | 'tool_result' | 'tool_use' | 'end_turn' | 'interrumpido' | 'error'
    pendientes: new Map(), // tool_use id -> nombre
    ultimaTool: '', limitado: false, hayAssistant: false,
  };
  let customTitle = '', aiTitle = '', agentName = '';
  for (const d of entries) {
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
      const txt = textoDe(content);
      info.limitado = /hit your (session|usage|weekly)? ?limit|usage limit reached/i.test(txt);
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
      info.ultimo = 'error';
      if (/limit/i.test(JSON.stringify(d).slice(0, 4000))) info.limitado = true;
    }
  }
  const ini = inicio(file, size);
  info.carpeta = ini.carpeta || info.cwd;
  info.titulo = customTitle || agentName || aiTitle || ini.prompt;
  return info;
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
    c = { size: st.size, mtimeMs: st.mtimeMs, info: analizar(file, st.size) };
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
  if (proc.status === 'idle') {
    const desde = ahora - (proc.statusUpdatedAt || proc.updatedAt || ahora);
    return desde <= TERMINO_MAX_MS
      ? { estado: 'done', detalle: 'te respondió' }
      : { estado: 'idle', detalle: 'esperando' };
  }
  return { estado: 'unknown', detalle: proc.status || '' };
}

const PRIORIDAD = { blocked: 0, limited: 1, done: 2, working: 3, unknown: 4, idle: 5 };

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
  };
}

/**
 * Los agentes de Claude Code que están corriendo ahora, más las conversaciones pineadas aunque su
 * agente no esté corriendo. Primero las pineadas; dentro de cada grupo, las que te necesitan.
 */
function leerSesiones(pineadas = []) {
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
    const { estado, detalle } = estadoDe(proc, info, ahora);
    const carpeta = proc.cwd || (info && info.carpeta) || '';
    out.push(tarjeta(proc.sessionId, proc, info, carpeta, estado, detalle, ahora));
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
    if (ya) { ya.pineada = true; continue; }
    // Pineada sin agente corriendo (por ejemplo, después de recargar la ventana): igual se muestra.
    const file = buscarTranscripcion(id);
    let info = null;
    try { info = file ? infoTranscripcion(file) : null; } catch { info = null; }
    const t = tarjeta(id, null, info, p.carpeta || (info && info.carpeta) || '', 'idle', 'agente sin abrir: tocala para retomarla', ahora);
    if (!info || !info.titulo) t.titulo = p.titulo;
    t.pineada = true;
    vistos.add(id);
    out.push(t);
  }

  const usados = new Set([...vistos].map(id => rutaTranscripcion.get(id)));
  for (const k of cache.keys()) if (!usados.has(k)) cache.delete(k);
  out.sort((a, b) => (b.pineada - a.pineada) || (PRIORIDAD[a.estado] - PRIORIDAD[b.estado]) || (b.nacio - a.nacio));
  return out;
}

module.exports = { leerSesiones };
