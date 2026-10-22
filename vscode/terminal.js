// Lleva a la pestaña de Terminal o iTerm2 donde corre un agente (por la tty de su proceso). Misma lógica
// que la app de macOS (../mac/main.swift, `Foco`).
//
// En la Terminal de macOS las pestañas son pestañas del sistema: cada una es una ventana para AppleScript
// y traerla al frente no cambia la pestaña visible. Lo que funciona es elegirla en el menú Ventana. Como
// dos agentes en la misma carpeta tienen el mismo título, le pongo a la pestaña un título temporal único,
// la elijo por ese título y le devuelvo el suyo. Hace falta que VS Code tenga permiso para controlar la
// Terminal (macOS lo pide solo) y de Accesibilidad (para el menú Ventana).
//
// También termina agentes (la ✕ de la tarjeta): el proceso con todo lo que cuelga de él, y su pestaña.
const { execFile } = require('child_process');

function run(cmd, args) {
  return new Promise(resolve => execFile(cmd, args, { timeout: 10000 }, (err, out, errOut) =>
    resolve({ ok: !err, out: String(out || '').trim(), err: String(errOut || (err && err.message) || '') })));
}

const osa = script => run('/usr/bin/osascript', ['-e', script]);
const corriendo = async app => (await run('/usr/bin/pgrep', ['-x', app])).ok;
const textoAS = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const esperar = ms => new Promise(r => setTimeout(r, ms));

const SIN_ACCESIBILIDAD = 'sin-accesibilidad';

async function irEnITerm(dev) {
  const r = await osa(`
    tell application id "com.googlecode.iterm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is "${dev}" then
              select w
              tell t to select
              tell s to select
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell
    return "no"`);
  return r.out === 'ok';
}

async function irEnTerminal(dev) {
  const marca = `dungeon ${dev.replace('/dev/', '')}`;
  const r = await osa(`
    tell application id "com.apple.Terminal"
      repeat with i from 1 to (count of windows)
        repeat with j from 1 to (count of tabs of window i)
          if tty of tab j of window i is "${dev}" then
            set w to window i
            set t to tab j of w
            set viejaMuestra to title displays custom title of t
            set viejoTitulo to custom title of t
            set custom title of t to "${marca}"
            set title displays custom title of t to true
            set selected of t to true
            set index of w to 1
            activate
            return "ok|" & viejaMuestra & "|" & viejoTitulo
          end if
        end repeat
      end repeat
    end tell
    return "no"`);
  if (!r.out.startsWith('ok|')) return r.ok ? 'no' : `controlar-terminal:${r.err}`;
  const [, viejaMuestra, ...resto] = r.out.split('|');
  const viejoTitulo = resto.join('|');
  try {
    await esperar(150); // que el menú Ventana tome el título nuevo
    // El menú Ventana está casi al final de la barra (antes de Ayuda): lo busco de atrás para adelante.
    const m = await osa(`
      tell application "System Events" to tell process "Terminal"
        set frontmost to true
        repeat with k from (count of menu bar items of menu bar 1) to 1 by -1
          try
            repeat with mi in menu items of menu 1 of menu bar item k of menu bar 1
              try
                if name of mi contains "${marca}" then
                  click mi
                  return "ok"
                end if
              end try
            end repeat
          end try
        end repeat
      end tell
      return "no"`);
    if (m.out === 'ok') return null;
    if (/assistive|accesib|-25211|-1719/i.test(m.err)) return SIN_ACCESIBILIDAD;
    return 'No encontré la pestaña del agente en el menú Ventana de la Terminal.';
  } finally {
    await osa(`
      tell application id "com.apple.Terminal"
        repeat with i from 1 to (count of windows)
          repeat with j from 1 to (count of tabs of window i)
            if tty of tab j of window i is "${dev}" then
              set custom title of tab j of window i to ${textoAS(viejoTitulo)}
              set title displays custom title of tab j of window i to ${viejaMuestra === 'true' ? 'true' : 'false'}
              return "ok"
            end if
          end repeat
        end repeat
      end tell`);
  }
}

/** Devuelve null si salió bien; si no, SIN_ACCESIBILIDAD o el motivo para mostrar. */
async function irATerminal(pid) {
  const { out: tty } = await run('/bin/ps', ['-o', 'tty=', '-p', String(pid)]);
  if (!tty) return 'Ese agente ya no está corriendo.';
  if (tty.startsWith('?')) return 'Ese agente no corre en una terminal.';
  const dev = `/dev/${tty}`;
  if (await corriendo('iTerm2') && await irEnITerm(dev)) return null;
  if (await corriendo('Terminal')) {
    const r = await irEnTerminal(dev);
    if (r === 'no') return 'No encontré la pestaña de ese agente en la Terminal.';
    if (r && r.startsWith('controlar-terminal:')) {
      return 'No pude controlar la Terminal. Si macOS preguntó si «Visual Studio Code» puede controlarla, aceptalo (Ajustes del Sistema → Privacidad y seguridad → Automatización) y volvé a tocar la tarjeta.';
    }
    return r;
  }
  return 'No encontré la pestaña de ese agente (funciona con la Terminal de macOS e iTerm2).';
}

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Termina el proceso del agente y todo lo que cuelga de él (subagentes, comandos, MCP). true si murió. */
async function matarArbol(pid) {
  const { out } = await run('/bin/ps', ['-axo', 'pid=,ppid=']);
  const hijos = new Map();
  for (const l of out.split('\n')) {
    const [p, padre] = l.trim().split(/\s+/).map(Number);
    if (!hijos.has(padre)) hijos.set(padre, []);
    hijos.get(padre).push(p);
  }
  const todos = [];
  for (const pila = [pid]; pila.length;) {
    const p = pila.pop();
    if (p > 1 && p !== process.pid && !todos.includes(p)) { todos.push(p); pila.push(...(hijos.get(p) || [])); }
  }
  const senal = s => { for (const p of todos) { try { process.kill(p, s); } catch { /* ya terminó */ } } };
  senal('SIGTERM');
  for (let i = 0; i < 30 && todos.some(vivo); i++) await esperar(100);
  if (todos.some(vivo)) { senal('SIGKILL'); await esperar(200); }
  return !vivo(pid);
}

// Cierra la pestaña de la Terminal con esa tty si ya no corre nada más que la shell (si no, la deja).
async function cerrarEnTerminal(dev) {
  const r = await osa(`
    tell application id "com.apple.Terminal"
      repeat with i from 1 to (count of windows)
        repeat with j from 1 to (count of tabs of window i)
          if tty of tab j of window i is "${dev}" then
            set t to tab j of window i
            set procesos to (get processes of t)
            repeat with k from 1 to (count of procesos)
              if {item k of procesos} is not in {"login", "-zsh", "zsh", "-bash", "bash", "-sh", "sh", "-fish", "fish"} then return "ocupada"
            end repeat
            if (count of tabs of window i) is 1 then
              close window i
            else
              do script "exit" in t
            end if
            return "ok"
          end if
        end repeat
      end repeat
    end tell
    return "no"`);
  return r.out;
}

/** Termina un agente que corre en una terminal y cierra su pestaña. Devuelve null o el motivo para mostrar. */
async function cerrarAgenteDeTerminal(pid) {
  const { out: tty } = await run('/bin/ps', ['-o', 'tty=', '-p', String(pid)]);
  if (!tty) return null; // ya no corría
  if (!await matarArbol(pid)) return 'No pude terminar el agente.';
  if (tty.startsWith('?')) return null;
  const dev = `/dev/${tty}`;
  await esperar(300); // que la Terminal vea que el agente terminó
  if (await corriendo('iTerm2')) {
    const r = await osa(`
      tell application id "com.googlecode.iterm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${dev}" then
                tell s to close
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return "no"`);
    if (r.out === 'ok') return null;
  }
  if (await corriendo('Terminal') && await cerrarEnTerminal(dev) === 'ocupada') {
    return 'Terminé el agente, pero dejé abierta su pestaña de la Terminal porque tiene otros procesos corriendo.';
  }
  return null;
}

module.exports = { irATerminal, SIN_ACCESIBILIDAD, matarArbol, cerrarAgenteDeTerminal, vivo };
