/* LECTOR EN VIVO — Colegio MASTER'S
   La camara apunta a la mesa y se van deslizando cartillas. Cuando una se lee
   entera y sin dudas, suena y queda guardada. No se toman fotos ni se envian
   archivos uno por uno: al final se exporta todo junto.

   El telefono SOLO captura. La correccion contra la clave se hace despues en
   la computadora, para no repartir la clave del examen entre varios celulares. */

const App = (() => {
  const $ = id => document.getElementById(id);
  const ANCHO_PROCESO = 640;          // resolucion de analisis (medida: 52 ms)
  const RANGO = [1001, 1148];
  const REPETIR_MS = 2500;            // no volver a contar la misma hoja seguida

  let nq = 80, video, lienzo, ctx, corriendo = false;
  let ultimoCodigo = null, ultimoT = 0;
  let leidas = {};                    // codigo -> {respuestas, hora}
  let esperados = 148;

  // ---- persistencia: si se cierra el navegador, no se pierde el trabajo ----
  const guardar = () => localStorage.setItem('omr_leidas', JSON.stringify(leidas));
  const cargar = () => {
    try { leidas = JSON.parse(localStorage.getItem('omr_leidas')) || {}; }
    catch (e) { leidas = {}; }
  };

  // ---- sonido: dos tonos distintos, se distinguen sin mirar la pantalla ----
  let audio = null;
  function pitar(ok) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.connect(g); g.connect(audio.destination);
      o.frequency.value = ok ? 880 : 220;
      g.gain.setValueAtTime(0.001, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (ok ? 0.15 : 0.35));
      o.start(); o.stop(audio.currentTime + (ok ? 0.16 : 0.36));
      if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]);
    } catch (e) { /* sin audio, se sigue viendo el color */ }
  }

  // ---- estado en pantalla ----
  function pintarEstado(clase, titulo, detalle) {
    const b = $('estado');
    b.className = 'estado ' + clase;
    $('titulo').textContent = titulo;
    $('detalle').textContent = detalle || '';
  }

  function pintarContador() {
    const n = Object.keys(leidas).length;
    $('contador').textContent = n + ' de ' + esperados;
    $('barra').style.width = Math.min(100, 100 * n / esperados) + '%';
  }

  /* El overlay se dibuja encima del <video>, que va con object-fit:contain.
     Hay que pasar de coordenadas del CUADRO ANALIZADO a pixeles de pantalla:
     primero se deshace la reduccion de analisis (÷esc) y luego se aplica la
     escala y el centrado con que el navegador encaja el video en su caja.
     Sin esto el recuadro salia disparado fuera de la pantalla. */
  function ajustarOverlay() {
    const o = $('overlay'), v = $('vista');
    const w = v.clientWidth, h = v.clientHeight;
    if (o.width !== w || o.height !== h) { o.width = w; o.height = h; }
    const vw = video.videoWidth || w, vh = video.videoHeight || h;
    const s = Math.min(w / vw, h / vh);          // 'contain'
    return { s, dx: (w - vw * s) / 2, dy: (h - vh * s) / 2 };
  }

  function dibujarGuia(esquinas, esc, ok) {
    const o = $('overlay'), c = o.getContext('2d');
    const m = ajustarOverlay();
    c.clearRect(0, 0, o.width, o.height);
    if (!esquinas) return;
    const pt = p => [m.dx + (p[0] / esc) * m.s, m.dy + (p[1] / esc) * m.s];
    c.strokeStyle = ok ? '#16a34a' : '#f59e0b';
    c.lineWidth = 4;
    c.beginPath();
    esquinas.forEach((p, i) => {
      const q = pt(p);
      i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]);
    });
    c.closePath(); c.stroke();
    c.fillStyle = c.strokeStyle;                 // las 4 esquinas detectadas
    esquinas.forEach(p => {
      const q = pt(p);
      c.beginPath(); c.arc(q[0], q[1], 7, 0, 7); c.fill();
    });
  }

  // ---- el ciclo: un cuadro, un intento ----
  function procesar() {
    if (!corriendo) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) { requestAnimationFrame(procesar); return; }

    const esc = ANCHO_PROCESO / vw;
    lienzo.width = Math.round(vw * esc);
    lienzo.height = Math.round(vh * esc);
    ctx.drawImage(video, 0, 0, lienzo.width, lienzo.height);
    const d = ctx.getImageData(0, 0, lienzo.width, lienzo.height);

    const r = OMR.leer(d.data, lienzo.width, lienzo.height);
    evaluar(r, esc);
    setTimeout(() => requestAnimationFrame(procesar), 60);
  }

  function evaluar(r, esc) {
    if (!r) {
      dibujarGuia(null);
      pintarEstado('buscando', 'Buscando la hoja…',
        'Que entren las 4 esquinas negras y no haya sombra encima');
      return;
    }
    const ahora = Date.now();

    if (r.codigo.indexOf('?') >= 0) {
      dibujarGuia(r.esquinas, esc, false);
      pintarEstado('aviso', 'Código ilegible', 'Revisar que marcó sus 4 dígitos');
      return;
    }
    const n = parseInt(r.codigo, 10);
    if (n < RANGO[0] || n > RANGO[1]) {
      dibujarGuia(r.esquinas, esc, false);
      pintarEstado('aviso', 'Código ' + r.codigo + ' no existe',
        'Los códigos van del ' + RANGO[0] + ' al ' + RANGO[1]);
      return;
    }
    if (r.ambiguas > 0) {
      dibujarGuia(r.esquinas, esc, false);
      // Decir CUALES: sin el numero de pregunta, el operador tiene que revisar
      // las 80 a ojo. Con el numero, mira una y sigue.
      const lista = (r.dudosas || []).sort((a, b) => a - b);
      const cuales = lista.slice(0, 4).join(', ') + (lista.length > 4 ? '…' : '');
      pintarEstado('aviso',
        'Revisar pregunta' + (r.ambiguas > 1 ? 's ' : ' ') + cuales,
        'Hoja ' + r.codigo + ' — hay dos marcas en ' +
        (r.ambiguas > 1 ? 'esas preguntas' : 'esa pregunta'));
      return;
    }
    if (r.blancos > 0.6 * nq) {
      dibujarGuia(r.esquinas, esc, false);
      pintarEstado('aviso', 'Casi toda la hoja sale en blanco',
        'Marca muy floja o poca luz — apartar la hoja ' + r.codigo);
      return;
    }
    if (leidas[r.codigo]) {
      dibujarGuia(r.esquinas, esc, true);
      if (r.codigo !== ultimoCodigo || ahora - ultimoT > REPETIR_MS) {
        ultimoCodigo = r.codigo; ultimoT = ahora;
        pintarEstado('repetida', 'Hoja ' + r.codigo + ' ya estaba leída',
          'Registrada a las ' + leidas[r.codigo].hora);
      }
      return;
    }

    leidas[r.codigo] = {
      respuestas: r.answers,
      blancos: r.blancos,
      hora: new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
    };
    guardar();
    ultimoCodigo = r.codigo; ultimoT = ahora;
    dibujarGuia(r.esquinas, esc, true);
    pintarEstado('ok', r.codigo + ' ✓',
      (nq - r.blancos) + ' respuestas · ' + r.blancos + ' en blanco');
    pintarContador();
    pitar(true);
  }

  // ---- exportar ----
  function exportar() {
    const cuerpo = {
      generado: new Date().toISOString(),
      preguntas: nq,
      operador: $('operador').value.trim(),
      fecha_simulacro: $('fecha').value,
      leidas
    };
    const txt = JSON.stringify(cuerpo, null, 1);
    const nombre = 'omr_' + ($('operador').value.trim() || 'sin-nombre') + '_' +
      ($('fecha').value || 'sin-fecha') + '.json';
    if (navigator.share && navigator.canShare &&
        navigator.canShare({ files: [new File([txt], nombre, { type: 'application/json' })] })) {
      navigator.share({ files: [new File([txt], nombre, { type: 'application/json' })],
                        title: nombre });
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'application/json' }));
    a.download = nombre; a.click();
  }

  function faltantes() {
    const f = [];
    for (let i = RANGO[0]; i <= RANGO[1]; i++) if (!leidas[String(i)]) f.push(i);
    return f;
  }

  // ---- arranque ----
  async function iniciar() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' },
                 width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = s;
      await video.play();
      corriendo = true;
      $('btnIniciar').style.display = 'none';
      pintarEstado('buscando', 'Buscando la hoja…', '');
      procesar();
    } catch (e) {
      pintarEstado('aviso', 'No se pudo abrir la cámara', e.message);
    }
  }

  // ---- modo de prueba: mismo camino, con una imagen fija en vez de video ----
  async function probarConImagen(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const esc = ANCHO_PROCESO / img.naturalWidth;
    lienzo.width = Math.round(img.naturalWidth * esc);
    lienzo.height = Math.round(img.naturalHeight * esc);
    ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
    const d = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
    const t0 = performance.now();
    const r = OMR.leer(d.data, lienzo.width, lienzo.height);
    evaluar(r, esc);
    return { ms: Math.round(performance.now() - t0), r };
  }

  function init() {
    video = $('video');
    lienzo = document.createElement('canvas');
    ctx = lienzo.getContext('2d', { willReadFrequently: true });
    OMR.setGeo(Object.assign({}, GEO, { ans: GEO.ans[String(nq)] }));
    cargar();
    pintarContador();
    $('fecha').value = new Date().toISOString().slice(0, 10);
    $('btnIniciar').onclick = iniciar;
    $('btnExportar').onclick = exportar;
    $('btnFaltan').onclick = () => {
      const f = faltantes();
      alert(f.length ? 'Faltan ' + f.length + ' hojas:\n' + f.join(', ')
                     : 'Están todas las ' + esperados + '.');
    };
    $('btnBorrar').onclick = () => {
      if (confirm('¿Borrar las ' + Object.keys(leidas).length + ' hojas leídas?')) {
        leidas = {}; guardar(); pintarContador();
        pintarEstado('buscando', 'Listo para empezar', '');
      }
    };
    $('nq').onchange = e => {
      nq = parseInt(e.target.value, 10);
      OMR.setGeo(Object.assign({}, GEO, { ans: GEO.ans[String(nq)] }));
    };
  }

  return { init, probarConImagen, get leidas() { return leidas; }, faltantes };
})();
