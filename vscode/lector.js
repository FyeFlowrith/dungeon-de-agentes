// Hilo aparte para leer las sesiones: las lecturas largas (la primera pasada por una transcripción grande,
// el historial de 2 semanas) son síncronas y, en el hilo de la extensión, frenarían a todas las demás.
const { parentPort } = require('worker_threads');
const { leerSesiones } = require('./sesiones');

parentPort.on('message', pineadas => {
  let sesiones = null;
  try { sesiones = leerSesiones(pineadas); } catch { sesiones = null; }
  parentPort.postMessage(sesiones);
});
