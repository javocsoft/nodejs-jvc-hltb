# HowLongToBeat: la API cambió (otra vez) y cómo adaptar una librería

*Documento para pasarle a un asistente que trabaje sobre una librería de
HowLongToBeat. Contiene el contrato medido contra el sitio real el **28 de agosto
de 2026**, la implementación de referencia, cómo encontrar la ruta la próxima vez
que la muevan, y cómo verificarlo todo.*

---

## El problema, en una frase

HowLongToBeat **movió la ruta de búsqueda de `/api/bleed` a `/api/search/site`**.
Cualquier librería que llame a la anterior recibe `404` y devuelve vacío.

Y eso es lo único que cambió. **Los tres encabezados, el campo del cuerpo con
nombre variable y la forma entera del cuerpo siguen idénticos.** Si tu librería ya
estaba adaptada a `/api/bleed`, el arreglo es una línea.

### Por qué duele tanto para lo poco que es

Es la **cuarta** mudanza de esa ruta:

```
/api/search  →  /api/locate/<clave>  →  /api/bleed  →  /api/search/site
```

Cada una dejó la función muerta **en silencio**. Nada peta: el navegador sigue
cargando la página, la captura simplemente no ve nunca la petición que espera, y
la librería devuelve vacío porque casi todas tratan la búsqueda como opcional.

Si estás depurando esto, la señal es exactamente ésa: **nada falla y no llegan
datos**. Antes de tocar nada, salta a *«Cómo encontrar la ruta»* más abajo: son
cuatro órdenes de consola y un minuto.

---

## El contrato

### La petición

```
POST https://howlongtobeat.com/api/search/site      ← lo único que cambió

x-auth-token: <blob en base64>
x-hp-key:     <clave del día, p. ej. ign_0686331a>
x-hp-val:     <valor que la acompaña, 16 hex>
content-type: application/json
user-agent:   <el MISMO que usó el navegador que obtuvo el token>
referer:      https://howlongtobeat.com/
origin:       https://howlongtobeat.com

{
  "searchType": "games",
  "searchTerms": ["deadly", "towers"],
  "searchPage": 1,
  "size": 20,
  "searchOptions": {
    "games": {
      "userId": 0, "platform": "", "sortCategory": "popular",
      "rangeCategory": "main", "rangeTime": { "min": null, "max": null },
      "gameplay": { "perspective": "", "flow": "", "genre": "", "difficulty": "" },
      "rangeYear": { "min": "", "max": "" }, "modifier": ""
    },
    "users": { "sortCategory": "postcount" },
    "lists": { "sortCategory": "follows" },
    "filter": "", "sort": 0, "randomizer": 0
  },
  "useCache": true,
  "ign_0686331a": "<el mismo valor que x-hp-val>"
}
```

Fíjate en la última línea del cuerpo: **el nombre del campo es la clave del
día**. No es un campo fijo llamado "key"; la propiedad se llama literalmente
`ign_0686331a`, y ese nombre cambia.

Esto está verificado el 28-08-2026 **leyendo su propio JavaScript**, no
deducido. Su código hace literalmente:

```js
let s = { searchType: h, searchTerms: p.trim().split(" "), searchPage: Z, size: 20,
          searchOptions: { ... }, useCache: !(u?.user_id > 0) };
a && (s[a] = l);                                    // a = clave, l = valor
let n = await fetch("/api/search/site", {
  method: "POST",
  headers: { "Content-Type": "application/json",
             "x-auth-token": t, "x-hp-key": a, "x-hp-val": l },
  body: JSON.stringify(s)
});
if (403 === n.status && !e) { /* refresca el token y reintenta una vez */ }
```

Ojo a la última línea: **ellos mismos reintentan una sola vez ante un 403**
recapturando el token. Es exactamente la política que debe seguir la librería.

### Qué es imprescindible

Medido en la ronda anterior quitando cada pieza. La forma no ha cambiado desde
entonces, así que sigue vigente:

| Falta | Respuesta |
| --- | --- |
| `x-hp-val` | **403** |
| el campo del cuerpo con nombre = clave | **404** |
| cookies | *nada, no hacen falta* |
| user-agent distinto al del token | **403** |

### Por qué el token no se puede fabricar

Es base64 y al decodificarlo aparece esto:

```
1786638501331::<IP>|Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/131.0.0.0 ...|ign_0686331a|<val>.<firma>
```

Lleva dentro **la IP y el user-agent** del cliente que lo pidió, más la clave del
día, el valor y una firma. Consecuencias prácticas:

- Un token obtenido en una máquina **no sirve en otra**.
- El user-agent con el que replicas la petición tiene que ser **idéntico** al que
  usó el navegador al obtenerlo. Es el error más fácil de cometer.
- No se puede generar sin pasar por su página. Cualquier intento de "construir"
  el token es tiempo perdido.

### La respuesta

```json
{
  "color": "blue", "title": "", "category": "games",
  "count": 1, "pageCurrent": 1, "pageTotal": 1, "pageSize": 20,
  "data": [
    {
      "game_id": 2356,
      "game_name": "Deadly Towers",
      "game_alias": "",
      "game_type": "game",
      "game_image": "2356_Deadly_Towers.jpg",
      "comp_main": 13757,
      "comp_plus": 61200,
      "comp_100": 0
    }
  ]
}
```

**Los tiempos vienen en segundos**: divide por 3600 para horas. Un `0` significa
"no hay dato", no "cero horas" — trátalo como `null` o la interfaz dirá que un
juego se completa en 0 h.

---

## Cómo encontrar la ruta cuando la vuelvan a mover

Esto es lo que hay que leer primero la próxima vez. **No hace falta navegador ni
herramientas de desarrollador**, y son cuatro órdenes:

```bash
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

# 1. La portada
curl -s -A "$UA" https://howlongtobeat.com/ -o page.html

# 2. Qué fragmentos de JavaScript carga (es Next.js; los nombres son aleatorios)
grep -oE '/_next/static/chunks/[a-zA-Z0-9._/-]+\.js' page.html | sort -u > chunks.txt

# 3. Bajarlos (eran once, ~600 KB en total)
mkdir -p js && cd js
while read -r u; do curl -s -A "$UA" "https://howlongtobeat.com$u" -O; done < ../chunks.txt

# 4. Qué rutas de API menciona su propio código
grep -ohE '"/api/[a-zA-Z0-9_/-]*"' *.js | sort -u
```

El 28-08-2026 eso devolvió exactamente:

```
"/api/"
"/api/error"
"/api/logout"
"/api/search/site"      ← ésta
"/api/user"
```

**Cuál es la buena**: la que aparece dentro de un `fetch(..., { method: "POST" })`
que lleve los tres encabezados `x-auth-token`, `x-hp-key` y `x-hp-val`. Para
verlo:

```bash
grep -oE '.{600}"/api/search/site".{400}' *.js
```

Ese mismo fragmento enseña **la forma del cuerpo**, así que aprovéchalo para
compararla con la que construye tu librería. Hasta ahora nunca ha cambiado —sólo
la ruta— pero comprobarlo cuesta treinta segundos y evita el siguiente susto.

---

## La estrategia: copiar la petición, no imitarla

Como el token va atado a IP y user-agent, y el cuerpo lleva un campo de nombre
variable, lo único robusto es:

1. Abrir la búsqueda de HowLongToBeat en un **navegador sin ventana**.
2. **Interceptar** la petición que hace la propia página.
3. Quedarse con `x-auth-token`, `x-hp-key` y `x-hp-val`.
4. A partir de ahí, **HTTP normal** reutilizando esas credenciales, cambiando
   sólo `searchTerms`.
5. Cachear las credenciales (30 minutos va bien; el token lleva marca de tiempo)
   y volver a capturarlas cuando la búsqueda falle con 401/403/404.

El navegador se abre **una vez cada 30 minutos**, no en cada búsqueda.

---

## Lo que falta en casi todas las librerías: el corte tras un fallo

Esto es lo más caro que aprendimos, y merece su propia sección porque **no es
evidente hasta que se mide**.

Cuando su sitio cambia, la captura falla. Si el código simplemente devuelve
`null` y no recuerda que acaba de fallar, la siguiente búsqueda **relanza el
navegador en el mismo segundo**. Y eso se multiplica sin que nadie lo vea:

- `searchGame` prueba con credenciales cacheadas y otra vez forzando → **2
  navegadores**.
- Una ficha de juego suele probar varias variantes del título (el nombre local,
  el japonés, el alternativo) → **×3**.

Resultado medido en producción con su sitio caído: **seis Chromium de nueve
segundos por cada juego que alguien abriera**, casi un minuto, todos para acabar
en el mismo `null`. En un servidor pequeño eso es lo que tira la máquina, no la
función que falta.

La cura es una caché negativa:

```js
let failureUntil = null;
const FAILURE_COOLDOWN_MINUTES = 30;   // lo mismo que dura una credencial buena

async function getCredentials(force = false) {
  const valid = credentials && credentialsExpiry && Date.now() < credentialsExpiry;
  if (valid && !force) return credentials;

  // Lo que acaba de fallar no va a funcionar dos segundos después, y
  // averiguarlo cuesta un navegador entero
  if (failureUntil && Date.now() < failureUntil) return null;

  const captured = await captureSearchRequest();

  if (captured) {
    credentials = captured;
    credentialsExpiry = Date.now() + CACHE_MINUTES * 60 * 1000;
    failureUntil = null;
  } else {
    credentials = null;
    credentialsExpiry = null;
    failureUntil = Date.now() + FAILURE_COOLDOWN_MINUTES * 60 * 1000;
    console.warn('[HLTB] Captura fallida; no se reintenta hasta '
      + new Date(failureUntil).toLocaleTimeString());
  }

  return credentials;
}
```

Medido con el mismo caso de antes: **de 6 navegadores a 1** en la primera ficha,
y **0** en las siguientes durante media hora.

Que el corte dure lo mismo que una credencial válida no es casualidad: si su web
vuelve, se nota en el mismo plazo que si simplemente hubiera caducado un token.
Y el aviso se escribe **una vez al abrir el corte**, no en cada búsqueda que lo
encuentra cerrado — si no, el registro se llena y se deja de leer, que es
justamente cómo estas roturas pasan desapercibidas durante semanas.

---

## Implementación de referencia

Probada en producción con Node 24 y puppeteer 25.

```js
const axios = require('axios');
const puppeteer = require('puppeteer');

const BASE_URL = 'https://howlongtobeat.com';
const SEARCH_PATH = '/api/search/site';   // ← cambia cada pocos meses

// El mismo string que se manda al capturar y al reutilizar: va dentro del token
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let credentials = null;      // { authToken, hpKey, hpValue }
let credentialsExpiry = null;
let failureUntil = null;
const CACHE_MINUTES = 30;
const FAILURE_COOLDOWN_MINUTES = 30;

/** Captura una petición de búsqueda real y se queda con sus credenciales */
async function captureSearchRequest() {
  let browser = null;

  try {
    browser = await puppeteer.launch({
      // OJO: desde puppeteer 22, `true` ES el headless nuevo.
      // El string 'new' quedó obsoleto y luego se eliminó.
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    let captured = null;

    page.on('request', request => {
      if (captured) return;
      if (request.method() !== 'POST') return;
      if (!request.url().startsWith(`${BASE_URL}${SEARCH_PATH}`)) return;

      const headers = request.headers();
      const authToken = headers['x-auth-token'];
      const hpKey = headers['x-hp-key'];
      if (!authToken || !hpKey) return;

      // El mismo valor viaja como cabecera y como campo del cuerpo
      let hpValue = headers['x-hp-val'] || null;
      if (!hpValue) {
        try {
          hpValue = JSON.parse(request.postData() || '{}')[hpKey] || null;
        } catch (error) {
          hpValue = null;
        }
      }

      if (hpValue) captured = { authToken, hpKey, hpValue };
    });

    // Cualquier término sirve: lo que importa es la petición que provoca
    await page.goto(`${BASE_URL}/?q=zelda`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (!captured) {
      console.warn('[HLTB] No se vio ninguna petición de búsqueda; '
        + 'puede que hayan movido la ruta otra vez');
    }

    return captured;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Credenciales vigentes, capturándolas si hace falta y sin insistir si acaba de fallar */
async function getCredentials(force = false) {
  const valid = credentials && credentialsExpiry && Date.now() < credentialsExpiry;
  if (valid && !force) return credentials;

  if (failureUntil && Date.now() < failureUntil) return null;

  const captured = await captureSearchRequest();

  if (captured) {
    credentials = captured;
    credentialsExpiry = Date.now() + CACHE_MINUTES * 60 * 1000;
    failureUntil = null;
  } else {
    credentials = null;
    credentialsExpiry = null;
    failureUntil = Date.now() + FAILURE_COOLDOWN_MINUTES * 60 * 1000;
    console.warn('[HLTB] Captura fallida; no se reintenta hasta '
      + new Date(failureUntil).toLocaleTimeString());
  }

  return credentials;
}

function buildPayload(gameName, creds) {
  return {
    searchType: 'games',
    searchTerms: gameName.trim().toLowerCase().split(/\s+/),
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0, platform: '', sortCategory: 'popular', rangeCategory: 'main',
        rangeTime: { min: null, max: null },
        gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
        rangeYear: { min: '', max: '' }, modifier: ''
      },
      users: { sortCategory: 'postcount' },
      lists: { sortCategory: 'follows' },
      filter: '', sort: 0, randomizer: 0
    },
    useCache: true,
    [creds.hpKey]: creds.hpValue   // sin esto: 404
  };
}

function buildHeaders(creds) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,       // tiene que ser el del token
    Referer: `${BASE_URL}/`,
    Origin: BASE_URL,
    'x-auth-token': creds.authToken,
    'x-hp-key': creds.hpKey,
    'x-hp-val': creds.hpValue        // sin esto: 403
  };
}

/** Busca un juego. Un token caducado se reintenta una vez con credenciales nuevas. */
async function searchGame(gameName) {
  for (const force of [false, true]) {
    const creds = await getCredentials(force);
    if (!creds) {
      if (force) break;
      continue;
    }

    try {
      const response = await axios.post(
        `${BASE_URL}${SEARCH_PATH}`,
        buildPayload(gameName, creds),
        { headers: buildHeaders(creds), timeout: 15000 }
      );
      return response.data.data || [];
    } catch (error) {
      const status = error.response?.status;
      // Solo merece reintento un token caducado
      if (force || (status && ![401, 403, 404].includes(status))) throw error;
    }
  }

  throw new Error('No se pudieron obtener credenciales de HowLongToBeat');
}

/** Segundos a horas, con null cuando no hay dato */
function secondsToHours(seconds) {
  if (!seconds || seconds <= 0) return null;
  return Math.round((seconds / 3600) * 100) / 100;
}
```

---

## Trampas conocidas

**No hagas `platforms[0]`, ni nada parecido, con el nombre.** Si buscas por
título, `data` trae varios resultados; compara el nombre exacto en minúsculas
antes de dar por bueno uno, y ten en cuenta `game_alias`, donde HLTB guarda
títulos alternativos y regionales.

**`comp_100: 0` no es cero horas.** Ver arriba.

**No registres el nombre buscado dos veces.** Si la función pública y la interna
lo escriben las dos, cada búsqueda sale duplicada en el registro y parece que se
está llamando dos veces cuando no. Cuesta un rato descartarlo.

**Puppeteer y su Chrome:**

- `headless: 'new'` está eliminado. Usa `headless: true`.
- Desde **npm 11** los scripts de postinstalación están bloqueados por defecto,
  así que `npm install` **no descarga Chrome** y lo dice de pasada entre los
  avisos (`allow-scripts ... puppeteer (postinstall)`). La instalación acaba en
  segundos, parece correcta, y la librería falla al lanzar el navegador.
  Solución explícita, independiente de la versión de npm:

  ```bash
  npx puppeteer browsers install chrome
  npx puppeteer browsers list
  ```
- Puppeteer 25 exige **Node ≥ 22.12**. Con un Node anterior `npm install` solo
  avisa (`EBADENGINE`) e instala igual.
- En un servidor sin escritorio, a Chrome le faltan bibliotecas del sistema:

  ```bash
  sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2
  ```
- **Con poca RAM el síntoma es otro.** En una máquina de 1 GB salían
  `Navigation timeout of 30000 ms exceeded`: Chrome ni llegaba a cargar la
  página. Al subirla a 2 GB desaparecieron los tiempos de espera y apareció el
  fallo real, `no se vio ninguna petición de búsqueda`. Si ves lo primero,
  arregla la memoria antes de sospechar de su API.

**El token está atado a la IP.** Si la librería corre detrás de un proxy o de
salidas NAT que rotan, un token capturado puede dejar de valer al momento. El
reintento con recaptura lo cubre, pero conviene saberlo antes de investigar
403 intermitentes.

**Esto va a volver a romperse.** Es una API privada sin contrato y ya van cuatro
mudanzas. Que el fallo sea **ruidoso una vez** —y no silencioso ni repetido en
bucle— es la diferencia entre enterarse el mismo día o dentro de dos meses.

---

## Cómo verificarlo

Lo que puede probarse sin red, en pruebas unitarias:

- El cuerpo contiene el campo cuyo **nombre** es `hpKey` y cuyo valor es
  `hpValue` (sin él: 404).
- Las cabeceras llevan las **tres** (`x-auth-token`, `x-hp-key`, `x-hp-val`).
- El user-agent de las cabeceras es el mismo con el que se captura.
- `searchTerms` son las palabras del título en minúsculas.
- `secondsToHours(0)` devuelve `null`, no `0`.
- **Con la captura sustituida por una que siempre falla, diez búsquedas seguidas
  abren un solo navegador.** Es la prueba del corte, y es la que evita que la
  próxima rotura se lleve por delante la máquina.

Y una comprobación real contra el sitio, para lanzar a mano:

```js
const results = await searchGame('Deadly Towers');
// Debe traer 1 resultado: game_id 2356, comp_main ≈ 13757 (3.82 h)
```

Números de referencia **medidos el 28-08-2026**:

| Juego | `game_id` | Historia principal | Principal + extras |
| --- | --- | --- | --- |
| Deadly Towers | 2356 | 3.82 h | 17.00 h |
| Castlevania III: Dracula's Curse | 1573 | 4.18 h | 5.43 h |
| The Legend of Zelda: Link's Awakening | 66255 | 14.09 h | 16.46 h |

Si esos números bailan un poco, es normal: son medias de la comunidad y suben
con cada aportación. Si vienen a cero o vacío, es que algo del contrato ha vuelto
a cambiar — y entonces toca la sección *«Cómo encontrar la ruta»*.
