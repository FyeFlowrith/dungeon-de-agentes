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

  const dinero = n => '≈ US$ ' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const miles = n => n >= 1000000 ? `${(n / 1000000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} millón` : `${Math.round(n / 1000)} mil`;

  // Ayuda al pasar el mouse: propia (el `title` de HTML no se muestra en la app de macOS, que usa WebKit).
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let tipEspera = null, tipDe = null;
  function ubicarTip(e) {
    const m = 12, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + m, y = e.clientY + m;
    if (x + w > window.innerWidth - 4) x = Math.max(4, e.clientX - w - m);
    if (y + h > window.innerHeight - 4) y = Math.max(4, e.clientY - h - m);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  function conTip(el) {
    el.addEventListener('mouseenter', e => {
      clearTimeout(tipEspera);
      tipDe = el;
      tipEspera = setTimeout(() => { if (tipDe !== el) return; tip.textContent = el.dataset.tip || ''; tip.hidden = !tip.textContent; ubicarTip(e); }, 450);
    });
    el.addEventListener('mousemove', e => { if (!tip.hidden && tipDe === el) ubicarTip(e); });
    el.addEventListener('mouseleave', () => { clearTimeout(tipEspera); if (tipDe === el) { tipDe = null; tip.hidden = true; } });
  }

  function crear(s) {
    const el = document.createElement('div');
    el.className = 'card';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.innerHTML = '<div class="hud" hidden><span class="lleno"></span><span class="txt"><span>CONTEXTO</span><span class="pct"></span></span></div>' +
      '<canvas></canvas><div class="cartel" hidden><span class="moneda">≈ u$s</span><span class="monto"></span></div>' +
      '<div class="pie"><div class="titulo"></div>' +
      '<div class="linea"><span class="rama"></span><span class="estado"></span></div></div>';
    const abrir = () => vscode.postMessage({
      tipo: 'abrir', id: el.dataset.id, carpeta: el.dataset.carpeta, enVsCode: el.dataset.vscode === '1',
    });
    el.addEventListener('click', abrir);
    conTip(el);
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
    // Franja de contexto, arriba de la tarjeta, por fuera del cuarto
    const hud = t.el.querySelector('.hud');
    const pct = s.contexto ? Math.min(1, s.contexto / (s.ventana || 200000)) : null;
    hud.hidden = pct === null;
    if (pct !== null) {
      hud.className = 'hud' + (pct > 0.9 ? ' alto' : pct > 0.7 ? ' medio' : '');
      hud.querySelector('.lleno').style.width = `${Math.round(pct * 100)}%`;
      hud.querySelector('.pct').textContent = `${Math.round(pct * 100)} %`;
    }
    const datos = [];
    if (typeof s.costo === 'number') {
      const nivel = ['bajo', 'medio', 'alto'][s.nivelGasto];
      datos.push(`Gasto de la sesión: ${dinero(s.costo)} (a precio de lista)` + (nivel ? ` · ${nivel} comparado con tus otras sesiones` : ''));
    }
    if (pct !== null) datos.push(`Contexto: ${Math.round(pct * 100)} % (${miles(s.contexto)} de ${miles(s.ventana)} tokens)`);
    t.el.dataset.tip = `${s.pineada ? '📌 Pineada · ' : ''}${s.titulo}\n${[s.repo, s.branch].filter(Boolean).join(' · ')}\n` +
      `${ETIQUETA[s.estado]}${s.detalle ? ' · ' + s.detalle : ''} · ${hace(s.edadMs)}\n` +
      (datos.length ? datos.join('\n') + '\n' : '') +
      (s.pista || (s.enVsCode ? 'Clic para abrir la sesión' : 'Clic para ir a su pestaña de la Terminal'));
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

  // Slime: la mascota de cada agente, de un color propio por agente, que reacciona al estado.
  // o = contorno, b = cuerpo, h = brillo, e = ojo abierto, c = ojo cerrado.
  const SLIME = [
    '...oooo...',
    '..obbbbo..',
    '.obhhbbbo.',
    'obhbbbbbbo',
    'obbebbebbo',
    'obbbbbbbbo',
    'obbbbbbbbo',
    '.oooooooo.',
  ];
  const SLIME_DUERME = SLIME.map((f, j) => (j === 4 ? 'obccbbccbo' : f));
  const COLORES_SLIME = [[110, 205, 90], [80, 155, 235], [235, 120, 180], [165, 115, 225], [240, 155, 60], [60, 200, 190]];
  const SW = 10 * 1.5, SH = 8 * 1.5; // tamaño del slime en unidades del cuarto
  const mezclar = (c, o, k) => c.map((v, i) => Math.round(v + (o[i] - v) * k));
  const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

  function colorSlime(id) {
    let h = 7;
    for (const ch of id) h = (h * 33 + ch.charCodeAt(0)) | 0;
    return COLORES_SLIME[Math.abs(h) % COLORES_SLIME.length];
  }

  // Altura de un saltito periódico (0 en el piso).
  function salto(now, periodo, alto) {
    return reducido ? 0 : Math.max(0, Math.sin((now % periodo) / periodo * Math.PI * 2)) * alto;
  }

  // x: borde izquierdo; piso: y de la base. aplastado > 0 lo achata (en el piso), < 0 lo estira (en el aire).
  function slime(ctx, base, x, piso, { aplastado = 0, dormido = false, susto = false } = {}) {
    const P = 1.5;
    const pal = {
      o: rgb(mezclar(base, [20, 12, 8], 0.65)), b: rgb(base), h: rgb(mezclar(base, [255, 255, 255], 0.55)),
      e: '#140c08', c: '#140c08',
    };
    ctx.save();
    ctx.translate(x + SW / 2, piso);
    ctx.scale(1 + aplastado, 1 - aplastado);
    (dormido ? SLIME_DUERME : SLIME).forEach((fila, j) => [...fila].forEach((ch, i) => {
      if (ch === '.') return;
      ctx.fillStyle = pal[ch];
      ctx.fillRect(-SW / 2 + i * P, -SH + j * P, P + 0.05, P + 0.05);
    }));
    ctx.restore();
    if (susto) { // gotita de susto
      ctx.fillStyle = '#bfe6ff';
      ctx.fillRect(x + SW, piso - SH - 2, 1.5, 3);
    }
  }

  function slimeSaltando(ctx, base, x, piso, now, periodo, alto) {
    const s = salto(now, periodo, alto);
    const aplastado = reducido ? 0 : (s > alto * 0.3 ? -0.12 : 0.14 * (1 - s / (alto * 0.3 || 1)));
    slime(ctx, base, x, piso - s, { aplastado });
  }

  function slimeDurmiendo(ctx, base, x, piso, now, seg) {
    slime(ctx, base, x, piso, { dormido: true, aplastado: 0.16 + (reducido ? 0 : Math.sin(now / 700) * 0.05) });
    const sube = reducido ? 0 : (seg * 2) % 6;
    pixelTexto(ctx, '#d8e4ff', x + SW + 1, piso - SH - 6 - sube, ZZZ);
  }

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
    const color = colorSlime(s.id);
    switch (s.estado) {
      case 'working': {
        // parado detrás del escritorio (tapa de y=44 a 57), trabajando sobre él; el slime da
        // saltitos al lado del escritorio
        heroe(ctx, h, true, tick, CX, 44 - HU + 9, false);
        if (img.workingFront.complete) ctx.drawImage(img.workingFront, 0, 0, RW, RH);
        slimeSaltando(ctx, color, 101, 70, now, 1300, 3);
        break;
      }
      case 'blocked': {
        // el slime se esconde detrás del héroe, temblando (se dibuja antes para que el héroe lo tape)
        const tiembla = reducido ? 0 : Math.sin(now / 35) * 0.6;
        slime(ctx, color, CX + 16 + tiembla, 70, { aplastado: 0.12, susto: true });
        const sl = reducido ? 0 : Math.abs(Math.sin(now / 180)) * 4;
        heroe(ctx, h, false, tick, CX, PISO - sl, false);
        const vis = reducido || Math.floor(now / 400) % 2 === 0;
        if (vis) pixelTexto(ctx, '#ff4a3a', CX + HU / 2 - 1, PISO - 10 - sl, EXCL);
        break;
      }
      case 'done': {
        const sl = reducido ? 0 : Math.abs(Math.sin(now / 220)) * 3;
        heroe(ctx, h, false, tick, CX, PISO - sl, false);
        pixelTexto(ctx, '#6fcf5a', CX + HU / 2 - 4, PISO - 10 - sl, TILDE);
        slimeSaltando(ctx, color, CX + HU + 6, 70, now, 520, 10); // salta contento
        break;
      }
      case 'idle': {
        // junto al fuego, mirando hacia la ventana; el slime duerme en la alfombra
        heroe(ctx, h, false, Math.floor(tick / 6), 96, 30, true);
        slimeDurmiendo(ctx, color, 64, 76, now, seg);
        break;
      }
      case 'limited': {
        // acostado en la camilla (x 52–92, y 52–66); el slime duerme en el piso, al lado
        ctx.save();
        ctx.translate(66, 59);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(img.heroes, 0, h * 2 * T, T, T, -HU / 2, -HU / 2, HU, HU);
        ctx.restore();
        const sube = reducido ? 0 : (seg * 3) % 8;
        pixelTexto(ctx, '#d8e4ff', 76, 40 - sube, ZZZ);
        slimeDurmiendo(ctx, color, 96, 76, now, seg);
        break;
      }
      default: {
        if (!reducido) {
          t.x += t.dir * 0.4;
          if (t.x > RW - HU - 14) t.dir = -1;
          if (t.x < 14) t.dir = 1;
        }
        heroe(ctx, h, false, Math.floor(tick / 2), t.x, PISO, t.dir < 0);
        // el slime lo sigue, del lado de atrás
        slimeSaltando(ctx, color, t.dir > 0 ? t.x - SW - 2 : t.x + HU + 2, 70, now, 700, 4);
      }
    }
  }

  // Gasto de la sesión: una pila de monedas con un cartelito de precio. El tamaño y el color salen del
  // nivel que calcula sesiones.js comparando con el uso de la propia persona (bajo, medio, alto); si no
  // hay con qué comparar, pila mediana y número sin color de nivel. Sin gasto, no hay pila.
  function nivelGasto(s) {
    if (typeof s.costo !== 'number' || s.costo < 0.01) return -1;
    return typeof s.nivelGasto === 'number' ? s.nivelGasto : null;
  }

  function monedas(ctx, nivel, now) {
    const n = [3, 10, 21][nivel];
    for (let i = 0; i < n; i++) {
      const fila = i < 7 ? 0 : i < 13 ? 1 : i < 18 ? 2 : 3;
      const pos = i - [0, 7, 13, 18][fila];
      const x = 14 + fila * 2.5 + pos * 4.6, y = 87 - fila * 3;
      ctx.fillStyle = '#6b4a10'; ctx.fillRect(x - 0.6, y - 0.6, 5.2, 3.2);
      ctx.fillStyle = '#f5c542'; ctx.fillRect(x, y, 4, 2);
      ctx.fillStyle = '#fff2b0'; ctx.fillRect(x + 0.6, y, 1.4, 0.8);
    }
    if (nivel === 2 && !reducido && Math.floor(now / 300) % 2) {
      ctx.fillStyle = '#fff8d0'; ctx.fillRect(30, 74, 1.2, 1.2); ctx.fillRect(38, 78, 1, 1);
    }
  }

  // Cartelito de precio: es texto HTML apoyado sobre el dibujo (siempre del mismo tamaño, se lea en la
  // tarjeta que sea); en el cuarto solo va el palito que lo sostiene, clavado en la pila.
  const PALITO_X = 31;
  function dibujarGasto(t, now) {
    const nivel = nivelGasto(t.s);
    const cartel = t.el.querySelector('.cartel');
    if (nivel === -1) { cartel.hidden = true; return; }
    const pila = nivel === null ? 1 : nivel;
    monedas(t.ctx, pila, now);
    const tope = 64 - [0, 1, 3][pila] * 3; // el cartel sube a medida que crece la pila
    t.ctx.fillStyle = '#140c08'; t.ctx.fillRect(PALITO_X - 1.2, tope, 2.4, 80 - tope);
    t.ctx.fillStyle = '#8a5a2b'; t.ctx.fillRect(PALITO_X - 0.6, tope, 1.2, 80 - tope);
    // Del cuarto a píxeles de la tarjeta, con la misma transformación del dibujo
    const m = t.ctx.getTransform(), dpr = window.devicePixelRatio || 1;
    const x = (m.a * PALITO_X + m.e) / dpr, y = (m.d * tope + m.f) / dpr + t.canvas.offsetTop;
    cartel.style.left = `${x}px`;
    cartel.style.top = `${y}px`;
    cartel.dataset.nivel = nivel === null ? 'sin' : nivel;
    const monto = t.s.costo.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const span = cartel.querySelector('.monto');
    if (span.textContent !== monto) span.textContent = monto;
    cartel.hidden = false;
  }

  let ultimo = 0;
  function loop(now) {
    if (now - ultimo > 1000 / 12) {
      ultimo = now;
      for (const t of tarjetas.values()) { dibujar(t, now); if (t.s) dibujarGasto(t, now); }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  vscode.postMessage({ tipo: 'listo' });
})();
