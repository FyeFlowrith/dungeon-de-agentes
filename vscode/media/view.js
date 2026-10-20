// Dibuja una tarjeta por sesión: el cuarto de su estado y el héroe animado adentro.
(function () {
  const vscode = acquireVsCodeApi();
  const S = window.SPRITES;
  const lista = document.getElementById('lista');
  const vacio = document.getElementById('vacio');

  const T = 16; // héroe 16×16 en la hoja de sprites
  const ETIQUETA = {
    working: 'TRABAJANDO', blocked: 'TE NECESITA', done: 'TERMINÓ',
    idle: 'EN PAUSA', limited: 'SIN CUOTA', unknown: '¿?',
  };

  const img = {};
  for (const [k, src] of Object.entries(S)) { const i = new Image(); i.src = src; img[k] = i; }

  const tarjetas = new Map(); // id -> { el, canvas, ctx, s, x, dir, cambio }

  function hace(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'recién';
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    return `hace ${h} h`;
  }

  function crear(s) {
    const el = document.createElement('div');
    el.className = 'card';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.innerHTML = '<canvas></canvas>' +
      '<div class="pie"><div class="titulo"></div>' +
      '<div class="linea"><span class="rama"></span><span class="estado"></span></div></div>';
    const abrir = () => vscode.postMessage({
      tipo: 'abrir', id: el.dataset.id, carpeta: el.dataset.carpeta, enVsCode: el.dataset.vscode === '1',
    });
    el.addEventListener('click', abrir);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); }
    });
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    return { el, canvas, ctx, x: 64, dir: 1, cambio: performance.now() };
  }

  function actualizar(t, s) {
    const cambioEstado = !t.s || t.s.estado !== s.estado;
    t.s = s;
    if (cambioEstado) t.cambio = performance.now();
    t.el.dataset.id = s.id;
    t.el.dataset.carpeta = s.carpeta || '';
    t.el.dataset.vscode = s.enVsCode ? '1' : '0';
    t.el.dataset.estado = s.estado;
    t.el.dataset.pineada = s.pineada ? '1' : '0';
    t.el.querySelector('.titulo').textContent = (s.pineada ? '📌 ' : '') + s.titulo;
    t.el.querySelector('.rama').textContent = [s.repo, s.branch].filter(Boolean).join(' · ');
    const est = t.el.querySelector('.estado');
    est.dataset.estado = s.estado;
    est.textContent = ETIQUETA[s.estado] || s.estado;
    t.el.title = `${s.pineada ? '📌 Pineada · ' : ''}${s.titulo}\n${[s.repo, s.branch].filter(Boolean).join(' · ')}\n` +
      `${ETIQUETA[s.estado]}${s.detalle ? ' · ' + s.detalle : ''} · ${hace(s.edadMs)}\n` +
      (s.enVsCode ? 'Clic para abrir la sesión' : 'Corre en una terminal');
    t.el.setAttribute('aria-label', `${s.titulo}: ${ETIQUETA[s.estado]}${s.detalle ? ', ' + s.detalle : ''}`);
  }

  function mostrar(sesiones) {
    const ids = new Set(sesiones.map(s => s.id));
    for (const [id, t] of tarjetas) if (!ids.has(id)) { t.el.remove(); tarjetas.delete(id); }
    sesiones.forEach((s, i) => {
      let t = tarjetas.get(s.id);
      if (!t) { t = crear(s); tarjetas.set(s.id, t); }
      actualizar(t, s);
      if (lista.children[i] !== t.el) lista.insertBefore(t.el, lista.children[i] || null);
    });
    vacio.hidden = sesiones.length > 0;
  }

  // Buscador (si la página lo tiene): filtra por nombre, carpeta y rama, sin importar mayúsculas ni acentos.
  const q = document.getElementById('q');
  const textoVacio = vacio.textContent;
  let todas = [];
  const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function filtrar() {
    const texto = q ? norm(q.value.trim()) : '';
    const sesiones = texto ? todas.filter(s => norm(`${s.titulo} ${s.repo} ${s.branch}`).includes(texto)) : todas;
    vacio.textContent = texto && todas.length ? `Ningún agente coincide con «${q.value.trim()}».` : textoVacio;
    mostrar(sesiones);
  }

  if (q) {
    q.addEventListener('input', filtrar);
    q.addEventListener('keydown', e => { if (e.key === 'Escape') { q.value = ''; filtrar(); q.blur(); } });
    // Empezar a escribir con la vista activa va directo al buscador.
    document.addEventListener('keydown', e => {
      if (document.activeElement !== q && e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) q.focus();
    });
  }

  window.addEventListener('message', ev => {
    const msg = ev.data;
    if (msg.tipo !== 'sesiones') return;
    todas = msg.sesiones;
    filtrar();
  });

  // El cuarto (144×100) llena el lienzo de alto y se centra (recortando pared a los costados si la
  // tarjeta es más angosta). Todo se dibuja en unidades del cuarto con una transformación; el héroe
  // mide HU unidades (1,5 veces su tamaño original respecto del cuarto).
  const RW = 144, RH = 100, HU = 24;

  function ajustar(t) {
    const c = t.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const s = Math.max(h / RH, w / RW);
    t.ctx.setTransform(s, 0, 0, s, (w - RW * s) / 2, (h - RH * s) / 2);
    t.ctx.imageSmoothingEnabled = false;
  }

  function heroe(ctx, h, accion, frame, x, y, espejo) {
    const fila = h * 2 + (accion ? 1 : 0);
    const f = frame % (accion ? 3 : 2);
    ctx.save();
    if (espejo) {
      ctx.translate(x + HU, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img.heroes, f * T, fila * T, T, T, 0, y, HU, HU);
    } else {
      ctx.drawImage(img.heroes, f * T, fila * T, T, T, x, y, HU, HU);
    }
    ctx.restore();
  }

  // Un mapa de píxeles (cada uno de P unidades) con contorno oscuro, para que se lea sobre cualquier cuarto.
  function pixelTexto(ctx, color, x, y, mapa) {
    const P = 1.5;
    const pts = [];
    mapa.forEach((fila, j) => [...fila].forEach((c, i) => { if (c === '#') pts.push([x + i * P, y + j * P]); }));
    ctx.fillStyle = '#140c08';
    for (const [px, py] of pts) ctx.fillRect(px - 1, py - 1, P + 2, P + 2);
    ctx.fillStyle = color;
    for (const [px, py] of pts) ctx.fillRect(px, py, P, P);
  }
  const EXCL = ['#', '#', '#', ' ', '#'];
  const TILDE = ['    #', '   ##', '#  # ', '###  ', ' #   '];
  const ZZZ = ['###', '  #', ' # ', '###'];

  const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CX = RW / 2 - HU / 2; // héroe centrado
  const PISO = 46;            // y del héroe parado en el medio del cuarto (pies en y=70)

  function dibujar(t, now) {
    const { ctx, s } = t;
    if (!s) return;
    ajustar(t);
    const fondo = img[s.estado] || img.unknown;
    ctx.clearRect(-RW, -RH, RW * 3, RH * 3);
    if (fondo.complete) ctx.drawImage(fondo, 0, 0, RW, RH);
    if (!img.heroes.complete) return;
    const seg = (now - t.cambio) / 1000;
    const tick = reducido ? 0 : Math.floor(now / 1000 * 6);
    const h = s.heroe;
    switch (s.estado) {
      case 'working': {
        // parado detrás del escritorio (tapa de y=44 a 57), trabajando sobre él
        heroe(ctx, h, true, tick, CX, 44 - HU + 9, false);
        if (img.workingFront.complete) ctx.drawImage(img.workingFront, 0, 0, RW, RH);
        break;
      }
      case 'blocked': {
        const salto = reducido ? 0 : Math.abs(Math.sin(now / 180)) * 4;
        heroe(ctx, h, false, tick, CX, PISO - salto, false);
        const vis = reducido || Math.floor(now / 400) % 2 === 0;
        if (vis) pixelTexto(ctx, '#ff4a3a', CX + HU / 2 - 1, PISO - 10 - salto, EXCL);
        break;
      }
      case 'done': {
        const salto = reducido ? 0 : Math.abs(Math.sin(now / 220)) * 3;
        heroe(ctx, h, false, tick, CX, PISO - salto, false);
        pixelTexto(ctx, '#6fcf5a', CX + HU / 2 - 4, PISO - 10 - salto, TILDE);
        break;
      }
      case 'idle': {
        // junto al fuego, mirando hacia la ventana
        heroe(ctx, h, false, Math.floor(tick / 6), 96, 30, true);
        break;
      }
      case 'limited': {
        // acostado en la camilla (x 52–92, y 52–66)
        ctx.save();
        ctx.translate(66, 59);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(img.heroes, 0, h * 2 * T, T, T, -HU / 2, -HU / 2, HU, HU);
        ctx.restore();
        const sube = reducido ? 0 : (seg * 3) % 8;
        pixelTexto(ctx, '#d8e4ff', 76, 40 - sube, ZZZ);
        break;
      }
      default: {
        if (!reducido) {
          t.x += t.dir * 0.4;
          if (t.x > RW - HU - 14) t.dir = -1;
          if (t.x < 14) t.dir = 1;
        }
        heroe(ctx, h, false, Math.floor(tick / 2), t.x, PISO, t.dir < 0);
      }
    }
  }

  let ultimo = 0;
  function loop(now) {
    if (now - ultimo > 1000 / 12) {
      ultimo = now;
      for (const t of tarjetas.values()) dibujar(t, now);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  vscode.postMessage({ tipo: 'listo' });
})();
