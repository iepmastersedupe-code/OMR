/* Lector OMR en JavaScript puro. Mismo algoritmo que omr_reader.py, sin
   librerias externas: tiene que correr en el navegador de un celular corriente
   y funcionar sin internet. */
const OMR = (() => {
  let G = null;                       // geometria (omr_layout)
  const setGeo = g => { G = g; };

  const gris = (d, w, h) => {         // RGBA -> gris
    const o = new Float32Array(w * h);
    for (let i = 0, j = 0; i < o.length; i++, j += 4)
      o[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return o;
  };

  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

  // Desenfoque de caja separable, repetido: aproxima un gaussiano y es O(n).
  function blur(src, w, h, r, veces) {
    let a = Float32Array.from(src), b = new Float32Array(w * h);
    for (let v = 0; v < veces; v++) {
      for (let y = 0; y < h; y++) {
        const base = y * w;
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += a[base + clamp(x, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          b[base + x] = acc / (2 * r + 1);
          acc -= a[base + clamp(x - r, 0, w - 1)];
          acc += a[base + clamp(x + r + 1, 0, w - 1)];
        }
      }
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += b[clamp(y, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = acc / (2 * r + 1);
          acc -= b[clamp(y - r, 0, h - 1) * w + x];
          acc += b[clamp(y + r + 1, 0, h - 1) * w + x];
        }
      }
    }
    return a;
  }

  // Aplana la iluminacion dividiendo por el propio fondo. Sin esto, una sombra
  // se come una esquina entera y la hoja no se detecta.
  function aplanar(g, w, h) {
    const fondo = blur(g, w, h, Math.max(2, Math.round(Math.max(w, h) / 50)), 3);
    const o = new Float32Array(w * h);
    for (let i = 0; i < o.length; i++)
      o[i] = Math.min(255, (g[i] / Math.max(1, fondo[i])) * 160);
    return o;
  }

  function otsu(g) {
    const hist = new Int32Array(256);
    for (let i = 0; i < g.length; i++) hist[clamp(g[i] | 0, 0, 255)]++;
    const total = g.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, mejor = 0, umbral = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const dif = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
      if (dif > mejor) { mejor = dif; umbral = t; }
    }
    return umbral;
  }

  // Componentes conexos oscuros que parecen marca de registro: cuadrado solido.
  function candidatas(g, w, h) {
    const th = otsu(g);
    const visto = new Uint8Array(w * h);
    const pila = new Int32Array(w * h);
    const areaMin = w * h * 0.00008, areaMax = w * h * 0.02;
    const out = [];
    for (let p0 = 0; p0 < visto.length; p0++) {
      if (visto[p0] || g[p0] >= th) continue;
      let sp = 0;
      pila[sp++] = p0; visto[p0] = 1;
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      while (sp) {
        const p = pila[--sp], x = p % w, y = (p / w) | 0;
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x > 0 && !visto[p - 1] && g[p - 1] < th) { visto[p - 1] = 1; pila[sp++] = p - 1; }
        if (x < w - 1 && !visto[p + 1] && g[p + 1] < th) { visto[p + 1] = 1; pila[sp++] = p + 1; }
        if (y > 0 && !visto[p - w] && g[p - w] < th) { visto[p - w] = 1; pila[sp++] = p - w; }
        if (y < h - 1 && !visto[p + w] && g[p + w] < th) { visto[p + w] = 1; pila[sp++] = p + w; }
      }
      if (n < areaMin || n > areaMax) continue;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const ar = bw / bh, ext = n / (bw * bh);
      if (ar > 0.6 && ar < 1.6 && ext > 0.80)
        out.push([x0 + bw / 2, y0 + bh / 2]);
    }
    return out;
  }

  // Las 4 marcas son los blobs mas exteriores. Tolera que la hoja este girada.
  function extremas(c) {
    if (c.length < 4) return null;
    let is = 0, id = 0, xs = 0, xd = 0;
    for (let i = 1; i < c.length; i++) {
      if (c[i][0] + c[i][1] < c[is][0] + c[is][1]) is = i;
      if (c[i][0] + c[i][1] > c[xs][0] + c[xs][1]) xs = i;
      if (c[i][0] - c[i][1] < c[id][0] - c[id][1]) id = i;
      if (c[i][0] - c[i][1] > c[xd][0] - c[xd][1]) xd = i;
    }
    const idx = [is, xd, xs, id];               // TL, TR, BR, BL
    if (new Set(idx).size < 4) return null;
    return idx.map(i => c[i]);
  }

  // Homografia canonico -> imagen: se muestrea directo, sin rasterizar la hoja.
  function homografia(dst, src) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = dst[i][0], y = dst[i][1], u = src[i][0], v = src[i][1];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    for (let i = 0; i < 8; i++) {
      let piv = i;
      for (let k = i + 1; k < 8; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
      const ta = A[i]; A[i] = A[piv]; A[piv] = ta;
      const tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      if (Math.abs(A[i][i]) < 1e-12) return null;
      for (let k = i + 1; k < 8; k++) {
        const f = A[k][i] / A[i][i];
        for (let j = i; j < 8; j++) A[k][j] -= f * A[i][j];
        b[k] -= f * b[i];
      }
    }
    const h = new Array(8).fill(0);
    for (let i = 7; i >= 0; i--) {
      let s = b[i];
      for (let j = i + 1; j < 8; j++) s -= A[i][j] * h[j];
      h[i] = s / A[i][i];
    }
    h.push(1);
    return h;
  }

  const mapear = (h, x, y) => {
    const d = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
  };

  // Oscuridad media dentro de un disco definido en el espacio canonico.
  function oscuridad(g, w, h, H, cx, cy, r) {
    let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const p = mapear(H, cx + dx, cy + dy);
        const x = p[0] | 0, y = p[1] | 0;
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        s += 255 - g[y * w + x];
        n++;
      }
    return n ? s / n / 255 : 0;
  }

  /* Decide una fila de burbujas.

     La oscuridad ABSOLUTA no sirve para decidir, porque depende de la luz. Con
     la hoja bien iluminada una burbuja VACIA da 0,08 —el aro impreso y la letra
     de dentro—; a media luz la misma burbuja vacia da 0,36, porque el papel ya
     no es blanco. Con el umbral fijo en 0,33 que habia, a partir de cierta
     penumbra TODAS las filas en blanco cruzaban el umbral y salian marcadas
     como "dos marcas": la hoja se llenaba de circulos rojos. Es exactamente lo
     que paso al probar sobre papel de noche.

     Lo estable es la comparacion DENTRO de la fila: las 5 burbujas comparten
     luz, sombra, papel e impresion. La MEDIANA de la fila es el nivel "vacia"
     de esa fila —como mucho 1 o 2 estan marcadas— y se decide por lo que cada
     burbuja SOBRESALE de esa mediana.

     Medido sobre 60 combinaciones de luz (100 %..42 %), sombra, desenfoque,
     motas de papel, ruido de sensor y fuerza de la marca: lo que sobresale una
     burbuja vacia nunca paso de 0,057, y la marca mas floja aun legible
     sobresalio 0,087. El umbral va en 0,07, entre las dos.

     La segunda burbuja tampoco puede compararse con un margen fijo: a poca luz
     todo el rango se comprime y un margen de 0,11 declaraba "dos marcas" una
     fila con una sola. Se pide en proporcion: que la segunda no llegue a la
     mitad de la primera. */
  /* El fondo de una fila no es un NIVEL, es una RECTA.

     Primero se quito el umbral absoluto (0,33) porque dependia de la luz: en
     penumbra una burbuja vacia da 0,36 y todas las filas en blanco salian como
     "dos marcas". Se paso a medir cuanto sobresale cada burbuja de la MEDIANA
     de su fila. Eso arreglo la penumbra, pero sobre fotos de papel de verdad
     aparecio el siguiente: la luz no cae plana sobre la fila, cae en degradado.
     Con un degradado de izquierda a derecha, la burbuja del extremo es siempre
     la mas oscura de su fila y sobresale de la mediana lo bastante para pasar
     por marca. Por eso la basura era SIEMPRE la letra de un borde: A en la
     columna izquierda, E en la derecha. Medido sobre 7 fotos reales de la misma
     hoja: 39 respuestas inventadas donde el alumno no marco nada.

     La solucion es quitar tambien la PENDIENTE: se ajusta una recta a la fila y
     se mira el residuo. Un degradado lineal se anula entero; una marca sigue
     sobresaliendo. La recta se ajusta SIN la burbuja mas oscura, porque si no
     la propia marca tira del fondo hacia arriba y se rebaja a si misma —justo
     en los extremos, que es donde mas leverage tiene.

     Con las mismas 7 fotos: 39 invenciones -> 0, y una foto que devolvia
     `CADA?A?A?AA?` paso a leer sus 22 marcas exactas. Lo que queda son marcas
     no vistas (16 de 154, casi todas en las fotos malas), que es un fallo
     recuperable: el consenso de varios cuadros las recupera y el operador ve
     que faltan puntos verdes. Inventar una respuesta no se recupera nunca. */
  const MARCA = 0.14;        // cuanto debe sobresalir de la recta de su fila
  const SEGUNDA = 0.5;       // si la 2a llega a esta fraccion de la 1a, son dos marcas

  function residuos(d) {
    const n = d.length;
    let peor = 0;
    for (let i = 1; i < n; i++) if (d[i] > d[peor]) peor = i;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
    for (let i = 0; i < n; i++) {
      if (i === peor) continue;
      sx += i; sy += d[i]; sxx += i * i; sxy += i * d[i]; m++;
    }
    const den = m * sxx - sx * sx;
    const a = den ? (m * sxy - sx * sy) / den : 0;
    const b = (sy - a * sx) / m;
    const o = new Array(n);
    for (let i = 0; i < n; i++) o[i] = d[i] - (a * i + b);
    return o;
  }

  function elegir(d) {
    const r = residuos(d);
    let i0 = 0;
    for (let i = 1; i < r.length; i++) if (r[i] > r[i0]) i0 = i;
    let seg = -1e9;
    for (let i = 0; i < r.length; i++) if (i !== i0 && r[i] > seg) seg = r[i];
    if (r[i0] < MARCA) return [-1, 'blanco'];
    if (seg > SEGUNDA * r[i0]) return [-1, 'ambiguo'];
    return [i0, 'ok'];
  }

  /* Lee un frame RGBA. Devuelve null si no es una cartilla utilizable. */
  function leer(data, w, h) {
    const g0 = gris(data, w, h);
    const intentos = [aplanar(g0, w, h), g0];
    for (let t = 0; t < intentos.length; t++) {
      const m = extremas(candidatas(intentos[t], w, h));
      if (!m) continue;
      const area = Math.abs((m[0][0] * (m[1][1] - m[3][1]) + m[1][0] * (m[2][1] - m[0][1]) +
        m[2][0] * (m[3][1] - m[1][1]) + m[3][0] * (m[0][1] - m[2][1])) / 2);
      if (area < 0.15 * w * h) continue;

      /* La cartilla es VERTICAL. Si el cuadrilatero sale mas ancho que alto,
         la hoja esta de lado: las 4 marcas se detectan igual y la homografia
         "funciona", pero mapea la pregunta 1 donde no es y lo lee todo
         transpuesto. Antes se aceptaba en silencio; ahora se avisa. */
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (dist(m[0], m[1]) > dist(m[0], m[3]) * 1.05)
        return { girada: true, esquinas: m };
      const H = homografia(G.markers, m);
      if (!H) continue;
      // Verificacion final: las 4 marcas deben estar donde dice la geometria.
      let ok = true;
      for (let i = 0; i < G.markers.length; i++)
        if (oscuridad(g0, w, h, H, G.markers[i][0], G.markers[i][1], (G.MARK >> 1) - 4) < 0.5) {
          ok = false; break;
        }
      if (!ok) continue;

      const answers = {}, flags = {};
      let blancos = 0, ambiguas = 0;
      const dudosas = [];          // que preguntas concretamente
      const elegidas = {};         // pregunta -> indice de burbuja marcada
      for (const q in G.ans) {
        const d = G.ans[q].map(c => oscuridad(g0, w, h, H, c[0], c[1], G.RM_ANS));
        const e = elegir(d);
        answers[q] = e[0] < 0 ? '' : G.LETTERS[e[0]];
        flags[q] = e[1];
        elegidas[q] = e[0];
        if (e[1] === 'blanco') blancos++;
        if (e[1] === 'ambiguo') { ambiguas++; dudosas.push(+q); }
      }
      let codigo = '';
      // Que burbuja se eligio en cada columna, para poder DIBUJARLO sobre la
      // hoja: el numero en el cartel dice el resultado, pero no si el verde
      // cayo donde el alumno pinto.
      const codElegidas = [], codFlags = [];
      for (let k = 0; k < 4; k++) {
        const col = G.code['d' + k];
        const d = col.centers.map(c => oscuridad(g0, w, h, H, c[0], c[1], G.RM_COD));
        const e = elegir(d);
        codigo += e[0] < 0 ? '?' : col.labels[e[0]];
        codElegidas.push(e[0]); codFlags.push(e[1]);
      }
      return { codigo, codElegidas, codFlags, answers, flags, blancos, ambiguas,
               dudosas, elegidas, H, esquinas: m };
    }
    return null;
  }

  return { setGeo, leer };
})();
