/* LECTOR EN VIVO — Colegio MASTER'S
   La camara apunta a la mesa y se van deslizando cartillas. Cuando una se lee
   entera y sin dudas, suena y queda guardada. No se toman fotos ni se envian
   archivos uno por uno: al final se exporta todo junto.

   Una hoja NO se decide con un cuadro: se juntan varios y se vota pregunta por
   pregunta (ver "consenso de varios cuadros"). Sobre papel el grafito brilla y
   la misma marca sale negra en un cuadro y blanca en el siguiente. Y volver a
   pasar una hoja ya leida la MEJORA en vez de descartarse.

   El telefono SOLO captura. La correccion contra la clave se hace despues en
   la computadora, para no repartir la clave del examen entre varios celulares. */

const App = (() => {
  const $ = id => document.getElementById(id);
  const ANCHO_PROCESO = 800;          // mas resolucion = lectura mas estable
  const RANGO = [1001, 1148];
  const REPETIR_MS = 2500;            // no volver a contar la misma hoja seguida
  const MAX_DUDOSAS = 6;              // hasta aqui se captura y se anota cuales

  /* ---- consenso de varios cuadros ----
     Sobre PAPEL el grafito BRILLA. Segun como caiga la luz, la misma marca sale
     negra en un cuadro y casi blanca en el siguiente: con una hoja real quieta
     delante de la camara, un cuadro leyo 19 de 80 respuestas y otro dio 28
     preguntas con dos marcas. Un cuadro suelto no es una lectura, es una
     muestra.

     Antes se guardaba con el PRIMER cuadro que pasaba los controles y todos los
     siguientes se tiraban con "ya estaba leida": una hoja mal leida quedaba mal
     para siempre y volver a pasarla no servia de nada. Ahora se juntan varios
     cuadros de la misma hoja y se decide con todos. */
  const CUADROS_MIN = 3;              // minimo antes de dar una hoja por leida
  const CUADROS_MAX = 12;             // tope, ~2 s: la hoja no se queda pegada
  const ESTABLES = 2;                 // consolidaciones seguidas iguales = ya no aporta
  const MAX_CONTRADICE = 4;           // contradicciones que delatan un cuadro basura

  let nq = 80, video, lienzo, ctx, corriendo = false;
  let ultimoCodigo = null, ultimoT = 0;
  let leidas = {};                    // codigo -> {respuestas, dudosas, votos, hora}
  let acum = null;                    // la hoja que se esta mirando ahora mismo
  let esperados = 148;

  // ---- persistencia: si se cierra el navegador, no se pierde el trabajo ----
  const guardar = () => localStorage.setItem('omr_leidas', JSON.stringify(leidas));
  const cargar = () => {
    try { leidas = JSON.parse(localStorage.getItem('omr_leidas')) || {}; }
    catch (e) { leidas = {}; }
  };

  const hhmm = () => new Date().toLocaleTimeString('es-PE',
    { hour: '2-digit', minute: '2-digit' });
  const resueltasDe = d =>
    Object.keys(d.respuestas || {}).filter(k => d.respuestas[k]).length;

  /* ---- votos: como se junta lo que vieron varios cuadros ----
     La regla que lo hace funcionar es que UN CUADRO QUE VE LA PREGUNTA EN BLANCO
     NO VOTA. Con el brillo del lapiz una marca real desaparece en algunos
     cuadros, asi que "no la vi" no prueba que no este; verla, si prueba que
     esta. El blanco final es la AUSENCIA de votos, no un voto.

     Al cerrar, por pregunta:
        sin votos              -> en blanco
        una sola letra         -> esa letra
        gana la doble marca    -> dudosa (se manda a revisar, no se adivina)
        dos letras distintas   -> dudosa (la lectura se contradice a si misma)

     Los votos se guardan junto con la hoja, asi que volver a pasar una hoja mal
     leida SUMA a lo que ya habia en vez de reemplazarlo. */
  function nuevoAcumulado(codigo) {
    const previo = leidas[codigo], votos = {};
    if (previo && previo.votos)
      for (const q in previo.votos) votos[q] = Object.assign({}, previo.votos[q]);
    return { codigo, votos, cuadros: 0, firma: '', estables: 0, descartados: 0 };
  }

  /* Cuantas preguntas lee este cuadro DISTINTAS de lo ya acumulado. Con la hoja
     bien cuadrada esto es cero o casi; cuando sale un numero grande, lo que ha
     fallado es la homografia —las 4 esquinas se detectaron donde no eran— y el
     cuadro trae la rejilla corrida: respuestas de otra fila. Un cuadro asi no
     debe votar, porque el consenso no lo detectaria: donde los demas ven blanco,
     el blanco no vota y su respuesta inventada se quedaria sola. */
  function contradice(r, c) {
    let n = 0;
    for (let q = 1; q <= nq; q++)
      if (r.flags[q] === 'ok' && c.respuestas[q] && r.answers[q] !== c.respuestas[q]) n++;
    return n;
  }

  function votar(r) {
    acum.cuadros++;
    for (const q in r.flags) {
      if (r.flags[q] === 'blanco') continue;
      const k = r.flags[q] === 'ambiguo' ? '?' : r.answers[q];
      if (!k) continue;
      const v = acum.votos[q] || (acum.votos[q] = {});
      v[k] = (v[k] || 0) + 1;
    }
  }

  function consolidar() {
    const respuestas = {}, dudosas = [];
    let blancos = 0;
    for (let q = 1; q <= nq; q++) {
      const v = acum.votos[q] || {};
      const letras = Object.keys(v).filter(k => k !== '?');
      if (!letras.length && !v['?']) { respuestas[q] = ''; blancos++; continue; }
      letras.sort((a, b) => v[b] - v[a]);
      // La doble marca solo cede si UNA letra se vio clara mas veces que ella.
      if (letras.length !== 1 || (v['?'] || 0) >= v[letras[0]]) {
        respuestas[q] = ''; dudosas.push(q); continue;
      }
      respuestas[q] = letras[0];
    }
    return { respuestas, dudosas, blancos,
             resueltas: nq - blancos - dudosas.length };
  }

  // Firma de la lectura junta: si no cambia de un cuadro a otro, mirar mas no aporta.
  const firmaDe = c => {
    const dud = new Set(c.dudosas);
    let s = '';
    for (let q = 1; q <= nq; q++) s += dud.has(q) ? '?' : (c.respuestas[q] || '.');
    return s;
  };

  // Traduce la lectura junta al formato que espera dibujarLectura.
  /* La lectura JUNTA de las respuestas, en el formato que dibuja la pantalla.
     El codigo NO se acumula —se decide en cada cuadro y es el de este cuadro el
     que se va a usar—, asi que se arrastra tal cual para pintarlo. */
  function vistaDe(c, r) {
    const v = { H: r.H, codElegidas: r.codElegidas, codFlags: r.codFlags,
                flags: {}, elegidas: {} }, dud = new Set(c.dudosas);
    for (let q = 1; q <= nq; q++) {
      if (dud.has(q)) { v.flags[q] = 'ambiguo'; v.elegidas[q] = -1; }
      else if (c.respuestas[q]) {
        v.flags[q] = 'ok'; v.elegidas[q] = GEO.LETTERS.indexOf(c.respuestas[q]);
      } else { v.flags[q] = 'blanco'; v.elegidas[q] = -1; }
    }
    return v;
  }

  /* ---- sonido ----
     Tres avisos que se distinguen POR RITMO, no por tono: el altavoz de un
     celular casi no reproduce por debajo de 500 Hz, asi que un pitido grave
     —que era lo que habia— practicamente no se oye. Contar pitidos funciona
     aunque el telefono este sobre la mesa y con ruido de aula alrededor.

        1 pitido  = leida y guardada, sigue
        2 pitidos = guardada pero hay preguntas que revisar
        3 pitidos = NO se guardo, esa hoja hay que repetirla

     El de 3 es el importante: antes los rechazos eran mudos y el operador
     seguia pasando hojas creyendo que habian entrado. */
  let audio = null, ultimoSonido = 0, ultimoTipo = '';

  const SONIDOS = {
    ok:      { veces: 1, hz: 900, dur: 0.11, vibra: [60] },
    revisar: { veces: 2, hz: 760, dur: 0.09, vibra: [70, 70, 70] },
    rechazo: { veces: 3, hz: 560, dur: 0.08, vibra: [90, 70, 90, 70, 90] }
  };

  function pitar(tipo) {
    const cfg = SONIDOS[tipo];
    if (!cfg) return;
    const ahora = Date.now();
    // Un rechazo se repite en cada cuadro mientras la hoja siga delante: se
    // deja sonar una vez y no se repite hasta que cambie el estado.
    if (tipo === ultimoTipo && ahora - ultimoSonido < 2000) return;
    ultimoTipo = tipo; ultimoSonido = ahora;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      for (let i = 0; i < cfg.veces; i++) {
        const t = audio.currentTime + i * (cfg.dur + 0.07);
        const o = audio.createOscillator(), g = audio.createGain();
        o.connect(g); g.connect(audio.destination);
        o.frequency.value = cfg.hz;
        o.type = 'square';                       // se oye mas que la senoidal
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + cfg.dur);
        o.start(t); o.stop(t + cfg.dur + 0.01);
      }
      if (navigator.vibrate) navigator.vibrate(cfg.vibra);
    } catch (e) { /* sin audio queda el color y la vibracion */ }
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
    $('btnExportar').textContent = n ? 'Enviar lo leído (' + n + ')' : 'Enviar lo leído';
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

  /* Pinta sobre cada pregunta lo que el lector CREE haber visto. Es lo que
     permite comprobar de un vistazo si esta acertando, sin tener que confiar.
     El celular no lleva la clave del examen, asi que no puede decir "correcto"
     o "incorrecto": solo marcada, dudosa o en blanco. */
  function dibujarLectura(r, esc, m) {
    if (!r || !r.H) return;
    const c = $('overlay').getContext('2d');
    const geo = GEO.ans[String(nq)];
    const pt = (cx, cy) => {
      const d = r.H[6] * cx + r.H[7] * cy + r.H[8];
      const x = (r.H[0] * cx + r.H[1] * cy + r.H[2]) / d;
      const y = (r.H[3] * cx + r.H[4] * cy + r.H[5]) / d;
      return [m.dx + (x / esc) * m.s, m.dy + (y / esc) * m.s];
    };
    for (const q in geo) {
      const est = r.flags[q], i = r.elegidas[q];
      if (est === 'ok') {
        const p = pt(geo[q][i][0], geo[q][i][1]);
        c.fillStyle = '#22c55e';                       // verde: marca clara
        c.beginPath(); c.arc(p[0], p[1], 5, 0, 7); c.fill();
      } else if (est === 'ambiguo') {
        geo[q].forEach(b => {                          // rojo: las 5 de la fila
          const p = pt(b[0], b[1]);
          c.strokeStyle = '#ef4444'; c.lineWidth = 2.5;
          c.beginPath(); c.arc(p[0], p[1], 6, 0, 7); c.stroke();
        });
      } else {
        const p = pt(geo[q][2][0], geo[q][2][1]);      // gris: fila en blanco
        c.fillStyle = 'rgba(255,255,255,.35)';
        c.beginPath(); c.arc(p[0], p[1], 3, 0, 7); c.fill();
      }
    }

    /* Y lo mismo sobre el CODIGO, que es lo que decide DE QUIEN es la hoja: si
       se lee mal, las 80 respuestas se le cuelgan a otro alumno. El numero ya
       salia en el cartel, pero el cartel no dice si el verde cayo donde el
       alumno pinto: con el codigo 1144 y el 1141 mal marcado, el cartel se ve
       igual de convincente en los dos casos.

       Una columna sin marcar o con dos marcas se pinta ENTERA, no con un punto
       tenue como las respuestas en blanco: un digito ilegible tira la hoja
       completa, asi que tiene que verse de un vistazo y sin buscarlo. */
    if (!r.codFlags) return;
    for (let k = 0; k < 4; k++) {
      const col = GEO.code['d' + k], est = r.codFlags[k];
      if (est === 'ok') {
        const p = pt(col.centers[r.codElegidas[k]][0], col.centers[r.codElegidas[k]][1]);
        c.fillStyle = '#22c55e';
        c.beginPath(); c.arc(p[0], p[1], 4, 0, 7); c.fill();
        continue;
      }
      c.strokeStyle = est === 'ambiguo' ? '#ef4444' : '#f59e0b';   // rojo dos · ámbar ninguna
      c.lineWidth = 2;
      col.centers.forEach(b => {
        const p = pt(b[0], b[1]);
        c.beginPath(); c.arc(p[0], p[1], 5, 0, 7); c.stroke();
      });
    }
  }

  function dibujarGuia(esquinas, esc, ok, lectura) {
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
    if (lectura) dibujarLectura(lectura, esc, m);
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
      ultimoTipo = '';                 // hoja fuera: el proximo aviso vuelve a sonar
      pintarEstado('buscando', 'Buscando la hoja…',
        'Que entren las 4 esquinas negras y no haya sombra encima');
      return;
    }
    if (r.girada) {
      dibujarGuia(r.esquinas, esc, false);
      pintarEstado('aviso', 'Gira la hoja',
        'La cartilla va vertical, con el título arriba');
      pitar('rechazo');
      return;
    }
    const ahora = Date.now();

    if (r.codigo.indexOf('?') >= 0) {
      dibujarGuia(r.esquinas, esc, false, r);
      pintarEstado('aviso', 'Código ilegible', 'Revisar que marcó sus 4 dígitos');
      pitar('rechazo');
      return;
    }
    const n = parseInt(r.codigo, 10);
    if (n < RANGO[0] || n > RANGO[1]) {
      dibujarGuia(r.esquinas, esc, false, r);
      pintarEstado('aviso', 'Código ' + r.codigo + ' no existe',
        'Los códigos van del ' + RANGO[0] + ' al ' + RANGO[1]);
      pitar('rechazo');
      return;
    }

    /* Este cuadro no decide: VOTA. El acumulado se reinicia solo cuando cambia
       el codigo, no cuando la hoja se pierde un cuadro, para que un temblor de
       la mano no borre lo que ya se habia visto. */
    if (!acum || acum.codigo !== r.codigo) acum = nuevoAcumulado(r.codigo);
    if (acum.cuadros && contradice(r, consolidar()) > MAX_CONTRADICE) {
      /* Dos seguidos y el equivocado puede ser lo acumulado —si el cuadro malo
         fue el primero—, asi que se tira lo de esta pasada y se empieza otra
         vez. Lo que ya estaba guardado de la hoja no se toca. */
      if (++acum.descartados >= 2) acum = nuevoAcumulado(r.codigo);
      dibujarGuia(r.esquinas, esc, false, r);
      pintarEstado('buscando', r.codigo + ' · no cuadra',
        'Aparta y vuelve a acercar la hoja, entera y sin sombra');
      return;
    }
    acum.descartados = 0;
    votar(r);
    const c = consolidar();
    const firma = firmaDe(c);
    acum.estables = (firma === acum.firma) ? acum.estables + 1 : 0;
    acum.firma = firma;

    /* Sobre la hoja se pinta la lectura JUNTA, no la del cuadro suelto: asi el
       operador ve encenderse las marcas que un cuadro solo se pierde, y sigue
       sirviendo de comprobacion de que esta leyendo la hoja correcta. */
    dibujarGuia(r.esquinas, esc, !c.dudosas.length, vistaDe(c, r));

    const cerrada = acum.cuadros >= CUADROS_MAX ||
      (acum.cuadros >= CUADROS_MIN && acum.estables >= ESTABLES);
    if (!cerrada) {
      /* Si la hoja ya estaba guardada se dice eso y no "leyendo…": el operador
         tiene que saber en el acto que esa hoja ya entro, aunque el lector siga
         juntando cuadros por si esta pasada la mejora. */
      const yaEsta = leidas[r.codigo];
      if (!yaEsta) {
        pintarEstado('buscando', r.codigo + ' · leyendo…',
          c.resueltas + ' de ' + nq + ' respuestas — sostén la hoja un momento');
      } else if (r.codigo !== ultimoCodigo || ahora - ultimoT > REPETIR_MS) {
        ultimoCodigo = r.codigo; ultimoT = ahora;
        pintarEstado('repetida', 'Hoja ' + r.codigo + ' ya estaba leída',
          resueltasDe(yaEsta) + ' de ' + nq + ' respuestas · registrada a las ' +
          yaEsta.hora);
      }
      return;
    }

    /* Los dos rechazos se deciden sobre la lectura JUNTA. Un cuadro con brillo
       puede dar 28 preguntas con dos marcas y eso no significa nada si los
       demas la leyeron limpia; antes eso tiraba la hoja entera. */
    const lista = c.dudosas;
    if (lista.length > MAX_DUDOSAS) {
      pintarEstado('aviso', lista.length + ' preguntas con dos marcas',
        'Demasiadas — revisar la hoja ' + r.codigo + ' a mano');
      pitar('rechazo');
      return;
    }
    if (c.blancos >= 0.85 * nq) {
      pintarEstado('aviso', 'Casi no se leyó nada',
        c.blancos + ' de ' + nq + ' en blanco — marca floja, poca luz o brillo del lápiz');
      pitar('rechazo');
      return;
    }

    /* Si ya estaba leida y esta pasada no aporta, se avisa y no se toca nada.
       Si aporta, se CORRIGE la que habia: es lo que arregla la hoja que quedo
       guardada con media lectura. Nunca se pierden respuestas, porque los votos
       viejos siguen contando. */
    const antes = leidas[r.codigo];
    const previas = antes ? resueltasDe(antes) : -1;
    if (antes && c.resueltas <= previas) {
      if (r.codigo !== ultimoCodigo || ahora - ultimoT > REPETIR_MS) {
        ultimoCodigo = r.codigo; ultimoT = ahora;
        pintarEstado('repetida', 'Hoja ' + r.codigo + ' ya estaba leída',
          previas + ' de ' + nq + ' respuestas · registrada a las ' + antes.hora);
      }
      return;
    }

    leidas[r.codigo] = {
      respuestas: c.respuestas,
      blancos: c.blancos,
      dudosas: lista,
      votos: acum.votos,               // para que la proxima pasada sume
      cuadros: acum.cuadros,
      hora: antes ? antes.hora : hhmm(),
      corregida: antes ? hhmm() : ''
    };
    guardar();
    ultimoCodigo = r.codigo; ultimoT = ahora;
    pintarContador();

    if (antes) {
      pintarEstado('ok', r.codigo + ' corregida',
        'pasó de ' + previas + ' a ' + c.resueltas + ' respuestas de ' + nq);
    } else if (lista.length) {
      pintarEstado('aviso', r.codigo + ' guardada · revisar ' +
        (lista.length > 1 ? 'preguntas ' : 'pregunta ') +
        lista.slice(0, 4).join(', ') + (lista.length > 4 ? '…' : ''),
        'Se guardó el resto. Aparta la hoja para mirar esas.');
    } else {
      pintarEstado('ok', r.codigo + ' ✓',
        c.resueltas + ' respuestas · ' + c.blancos + ' en blanco');
    }
    pitar(lista.length ? 'revisar' : 'ok');
  }

  // ---- exportar ----
  /* Tres caminos, en orden, y cada uno protegido: compartir por el menu de
     Android, descargar como archivo, y si las dos fallan, mostrar el texto en
     pantalla para copiarlo. El boton nunca puede quedarse sin hacer nada:
     si el operador pulsa y no pasa nada, da el trabajo por perdido. */
  function exportar() {
    const n = Object.keys(leidas).length;
    if (!n) {
      pintarEstado('aviso', 'Todavía no hay nada leído',
        'Pasa una cartilla hasta que suene y vuelve a intentarlo');
      return;
    }
    // Los votos por cuadro se quedan en el telefono: sirven para mejorar la
    // lectura al repasar una hoja, no para corregir en la PC.
    const paraEnviar = {};
    for (const k in leidas) {
      const d = leidas[k];
      paraEnviar[k] = { respuestas: d.respuestas, blancos: d.blancos,
                        dudosas: d.dudosas, cuadros: d.cuadros,
                        hora: d.hora, corregida: d.corregida || '' };
    }
    const cuerpo = {
      generado: new Date().toISOString(),
      preguntas: nq,
      operador: $('operador').value.trim(),
      fecha_simulacro: $('fecha').value,
      leidas: paraEnviar
    };
    const txt = JSON.stringify(cuerpo, null, 1);
    const nombre = 'omr_' + ($('operador').value.trim() || 'sin-nombre') + '_' +
      ($('fecha').value || 'sin-fecha') + '.json';

    // 1) menú de compartir de Android
    try {
      const arch = new File([txt], nombre, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [arch] })) {
        navigator.share({ files: [arch], title: nombre })
          .then(() => pintarEstado('repetida', 'Enviado · ' + n + ' hoja(s)', nombre))
          .catch(() => pintarEstado('aviso', 'No se envió',
            'Usa «Ver y copiar» para sacar los datos'));
        return;
      }
    } catch (e) { /* sin compartir: se prueba con descarga */ }

    // 2) descarga normal
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([txt], { type: 'application/json' }));
      a.download = nombre;
      document.body.appendChild(a);
      a.click();
      a.remove();
      pintarEstado('repetida', 'Descargado · ' + n + ' hoja(s)',
        nombre + ' — está en la carpeta Descargas');
      return;
    } catch (e) { /* ultimo recurso */ }

    // 3) a la vista, en compacto: es lo que cabe en un mensaje
    const c = compacto();
    mostrarTexto(c, n + ' hoja(s) · ' + c.length + ' caracteres', n);
  }

  /* Formato COMPACTO, para mandar por WhatsApp.
     El JSON de 40 hojas son unos 50 KB de texto: no cabe en un mensaje. Aqui
     cada hoja es una linea de ~90 caracteres —el codigo y una letra por
     pregunta— asi que las 148 caben de sobra. Se lee igual de bien en la PC.
        .  = en blanco
        ?  = dos marcas (cuenta como error)
     Es el camino que de verdad va a usarse el dia del simulacro: el operador
     copia y pega en el chat, sin archivos ni cables. */
  function compacto() {
    const L = ['MASTERS-OMR v1',
               'fecha ' + ($('fecha').value || '?'),
               'operador ' + ($('operador').value.trim() || '?'),
               'preguntas ' + nq];
    for (const cod of Object.keys(leidas).sort()) {
      const d = leidas[cod];
      const dud = new Set((d.dudosas || []).map(Number));
      let linea = '';
      for (let q = 1; q <= nq; q++) {
        linea += dud.has(q) ? '?' : (d.respuestas[q] || d.respuestas[String(q)] || '.');
      }
      L.push(cod + ' ' + linea);
    }
    L.push('fin ' + Object.keys(leidas).length);
    return L.join('\n');
  }

  /* Red de seguridad: el JSON en pantalla, seleccionable. Con esto los datos
     salen del telefono aunque el navegador bloquee compartir y descargar. */
  function mostrarTexto(txt, nombre, n) {
    const caja = $('copiar');
    $('copiarTexto').value = txt;
    $('copiarTitulo').textContent = nombre + ' · ' + n + ' hoja(s)';
    caja.style.display = 'flex';
    $('copiarTexto').select();
  }

  function faltantes() {
    const f = [];
    for (let i = RANGO[0]; i <= RANGO[1]; i++) if (!leidas[String(i)]) f.push(i);
    return f;
  }

  // ---- arranque ----
  async function iniciar() {
    try {
      // Se pide RETRATO y la mayor resolucion que dé la camara: la cartilla es
      // vertical, y con un flujo apaisado la hoja queda pequeña dentro del
      // encuadre y cada burbuja se lleva muy pocos pixeles.
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1440 }, height: { ideal: 1920 },
          frameRate: { ideal: 24 },
          advanced: [{ focusMode: 'continuous' }]
        },
        audio: false
      });
      video.srcObject = s;
      await video.play();
      corriendo = true;
      $('btnIniciar').style.display = 'none';
      // Mostrar lo que la camara entrego de verdad: si sale muy bajo, se sabe
      // que el problema es la camara y no el encuadre.
      const t = s.getVideoTracks()[0].getSettings();
      $('resol').textContent = (t.width || video.videoWidth) + '×' +
                               (t.height || video.videoHeight);
      pintarEstado('buscando', 'Buscando la hoja…',
        'Acerca hasta que la hoja llene el recuadro');
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
    $('btnVer').onclick = () => {
      const n = Object.keys(leidas).length;
      if (!n) { pintarEstado('aviso', 'Todavía no hay nada leído', ''); return; }
      const t = compacto();
      mostrarTexto(t, n + ' hoja(s) · ' + t.length + ' caracteres', n);
    };
    $('btnCerrarCopiar').onclick = () => { $('copiar').style.display = 'none'; };
    $('btnCopiarPortapapeles').onclick = async () => {
      const t = $('copiarTexto');
      t.select();
      try { await navigator.clipboard.writeText(t.value); $('copiarTitulo').textContent = 'Copiado ✓'; }
      catch (e) { document.execCommand('copy'); $('copiarTitulo').textContent = 'Copiado ✓'; }
    };
    $('btnFaltan').onclick = () => {
      const f = faltantes();
      alert(f.length ? 'Faltan ' + f.length + ' hojas:\n' + f.join(', ')
                     : 'Están todas las ' + esperados + '.');
    };
    $('btnBorrar').onclick = () => {
      if (confirm('¿Borrar las ' + Object.keys(leidas).length + ' hojas leídas?')) {
        leidas = {}; acum = null; guardar(); pintarContador();
        pintarEstado('buscando', 'Listo para empezar', '');
      }
    };
    $('nq').onchange = e => {
      nq = parseInt(e.target.value, 10);
      acum = null;                     // otra geometria: los votos viejos no valen
      OMR.setGeo(Object.assign({}, GEO, { ans: GEO.ans[String(nq)] }));
    };
  }

  return { init, probarConImagen, get leidas() { return leidas; }, faltantes };
})();
