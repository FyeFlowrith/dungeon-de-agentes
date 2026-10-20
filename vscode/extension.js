const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { leerSesiones } = require('./sesiones');

const INTERVALO_MS = 2000;
// Un pedido de abrir sesión que ninguna ventana tomó en este tiempo se descarta.
const PENDIENTE_MAX_MS = 90 * 1000;

function mismaCarpeta(a, b) {
  const norm = p => path.resolve(p).replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function carpetasDeEstaVentana() {
  return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
}

// El título de una pestaña puede venir cortado con «…».
function mismoTitulo(a, b) {
  const norm = s => (s || '').replace(/(…|\.\.\.)\s*$/, '').trim().toLowerCase();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 6 && (x.startsWith(y) || y.startsWith(x)));
}

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class DungeonView {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.ultimo = '';
    // Archivo compartido por todas las ventanas de VS Code: una deja el pedido y la ventana de la
    // carpeta de la sesión lo toma y la abre (la extensión de Claude solo abre sesiones de su carpeta).
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    this.pendiente = path.join(dir, 'abrir-sesion.json');
    // Cada ventana publica acá las conversaciones de Claude que tiene pineadas (<pid>.json), para que
    // el dungeon de cualquier ventana las muestre todas.
    this.dirPineadas = path.join(dir, 'pineadas');
    fs.mkdirSync(this.dirPineadas, { recursive: true });
    this.archivoPineadas = path.join(this.dirPineadas, `${process.pid}.json`);
  }

  // Qué sesión hay detrás de cada pestaña de Claude: lo guarda la extensión de Claude en el estado de
  // este workspace (panelTabSessions: sessionId + título).
  pestaniasDeClaude() {
    if (!this.context.storageUri) return Promise.resolve([]);
    const db = path.join(path.dirname(this.context.storageUri.fsPath), 'state.vscdb');
    return new Promise(resolve => {
      execFile('/usr/bin/sqlite3', ['-readonly', db, "select value from ItemTable where key='Anthropic.claude-code'"],
        { timeout: 5000 }, (err, out) => {
          if (err) return resolve([]);
          try { resolve(JSON.parse(out).panelTabSessions || []); } catch { resolve([]); }
        });
    });
  }

  async actualizarPineadas() {
    const titulos = [];
    for (const grupo of vscode.window.tabGroups.all) {
      for (const tab of grupo.tabs) {
        if (tab.isPinned && tab.input instanceof vscode.TabInputWebview && /claudeVSCodePanel/.test(tab.input.viewType)) {
          titulos.push(tab.label);
        }
      }
    }
    const sesiones = [];
    if (titulos.length) {
      const conocidas = await this.pestaniasDeClaude();
      for (const titulo of titulos) {
        const s = conocidas.find(c => mismoTitulo(c.title, titulo));
        sesiones.push({ id: s ? s.sessionId : null, titulo });
      }
    }
    const carpeta = carpetasDeEstaVentana()[0] || '';
    const json = JSON.stringify({ pid: process.pid, carpeta, sesiones });
    if (json === this.pineadasPublicadas) return;
    this.pineadasPublicadas = json;
    const tmp = `${this.archivoPineadas}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, this.archivoPineadas);
    this.ultimo = '';
    this.refrescar();
  }

  // Las pineadas de todas las ventanas abiertas (las de ventanas cerradas se descartan).
  leerPineadas() {
    const out = [];
    let archivos = [];
    try { archivos = fs.readdirSync(this.dirPineadas).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
    for (const f of archivos) {
      const p = path.join(this.dirPineadas, f);
      let d;
      try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (!vivo(d.pid)) { fs.rmSync(p, { force: true }); continue; }
      for (const s of d.sesiones || []) out.push({ ...s, carpeta: d.carpeta });
    }
    return out;
  }

  borrarPineadas() {
    fs.rmSync(this.archivoPineadas, { force: true });
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage(msg => {
      if (msg.tipo === 'abrir') this.abrir(msg.id, msg.carpeta, msg.enVsCode);
      if (msg.tipo === 'listo') { this.ultimo = ''; this.refrescar(); }
    });
    view.onDidChangeVisibility(() => { if (view.visible) { this.ultimo = ''; this.refrescar(); } });
  }

  async abrir(id, carpeta, enVsCode) {
    if (!enVsCode) {
      // Un agente abierto en una terminal: abrirlo en el panel crearía una segunda copia de la conversación.
      vscode.window.showInformationMessage('Ese agente corre en una terminal, no en VS Code: contestale ahí.');
      return;
    }
    const propia = !carpeta || carpetasDeEstaVentana().some(c => mismaCarpeta(c, carpeta));
    if (propia) return this.abrirAca(id);
    if (!fs.existsSync(carpeta)) {
      vscode.window.showWarningMessage(`La carpeta de esa sesión ya no existe: ${carpeta}`);
      return;
    }
    const ts = Date.now();
    fs.writeFileSync(this.pendiente, JSON.stringify({ id, carpeta, ts }));
    // Si ya hay una ventana con esa carpeta, VS Code la trae al frente; si no, abre una nueva.
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(carpeta), { forceNewWindow: true });
    // Si nadie lo tomó, esa ventana no tiene esta extensión cargada (por ejemplo, no se recargó).
    setTimeout(() => {
      let pedido;
      try { pedido = JSON.parse(fs.readFileSync(this.pendiente, 'utf8')); } catch { return; }
      if (pedido.ts !== ts) return;
      fs.rmSync(this.pendiente, { force: true });
      vscode.window.showWarningMessage(
        `La ventana de «${path.basename(carpeta)}» no abrió la sesión: recargala (Cmd+Shift+P → «Developer: Reload Window») y volvé a tocar la tarjeta.`,
      );
    }, 20 * 1000);
  }

  async abrirAca(id) {
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', id);
    } catch (e) {
      vscode.window.showWarningMessage(`No pude abrir la sesión: ${e.message || e}`);
    }
  }

  // Corre en cada ventana: si hay un pedido para una carpeta de esta ventana, lo toma y lo abre.
  tomarPendiente() {
    let pedido;
    try { pedido = JSON.parse(fs.readFileSync(this.pendiente, 'utf8')); } catch { return; }
    if (Date.now() - pedido.ts > PENDIENTE_MAX_MS) { fs.rmSync(this.pendiente, { force: true }); return; }
    if (!carpetasDeEstaVentana().some(c => mismaCarpeta(c, pedido.carpeta))) return;
    // El rename es atómico: si dos ventanas tienen la misma carpeta, solo una lo toma.
    const tomado = `${this.pendiente}.${process.pid}`;
    try { fs.renameSync(this.pendiente, tomado); } catch { return; }
    fs.rmSync(tomado, { force: true });
    this.abrirAca(pedido.id);
  }

  refrescar() {
    const sesiones = leerSesiones(this.leerPineadas());
    if (!this.view) return;
    const atencion = sesiones.filter(s => s.estado === 'blocked' || s.estado === 'limited').length;
    this.view.badge = atencion ? { value: atencion, tooltip: `${atencion} agente(s) te necesitan` } : undefined;
    if (!this.view.visible) return;
    // La edad se redondea a medio minuto para no redibujar cada 2 s sin cambios reales.
    const json = JSON.stringify(sesiones.map(s => ({ ...s, edadMs: Math.round(s.edadMs / 30000) })));
    if (json === this.ultimo) return;
    this.ultimo = json;
    this.view.webview.postMessage({ tipo: 'sesiones', sesiones });
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = f => webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    const sprites = {
      heroes: uri('heroes.png'),
      working: uri('room_working.png'),
      workingFront: uri('room_working_front.png'),
      blocked: uri('room_blocked.png'),
      done: uri('room_done.png'),
      idle: uri('room_idle.png'),
      limited: uri('room_limited.png'),
      unknown: uri('room_unknown.png'),
    };
    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('view.css')}">
</head><body>
<div id="lista"></div>
<p id="vacio" hidden>No hay sesiones de Claude con actividad reciente.</p>
<script nonce="${nonce}">window.SPRITES = ${JSON.stringify(sprites)};</script>
<script nonce="${nonce}" src="${uri('view.js')}"></script>
</body></html>`;
  }
}

function activate(context) {
  const provider = new DungeonView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dungeonAgentes.view', provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );
  provider.tomarPendiente(); // una ventana recién abierta para una sesión
  const timer = setInterval(() => { provider.tomarPendiente(); provider.refrescar(); }, INTERVALO_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Pineadas: al instante cuando cambian las pestañas, y cada 30 s por si Claude renombró alguna.
  let espera;
  const pineadas = () => { clearTimeout(espera); espera = setTimeout(() => provider.actualizarPineadas(), 300); };
  pineadas();
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(pineadas));
  const timerPineadas = setInterval(pineadas, 30 * 1000);
  context.subscriptions.push({ dispose: () => { clearInterval(timerPineadas); provider.borrarPineadas(); } });
}

function deactivate() {}

module.exports = { activate, deactivate };
