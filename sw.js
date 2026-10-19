// Полка: один сервис-воркер на все книги.
// 1) установка — сама полка; 2) по команде полки — «лёгкие» файлы всех книг (тексты, фото);
// 3) по кнопке — видео книги; 4) всё, что открывалось, тоже остаётся. Запросы видео кусками (Range, так делает Safari)
//    отдаются из кеша нарезкой 206 — иначе на iPhone видео офлайн не играет.
const C = "polka-v2";
const SHELF = ["./", "index.html", "manifest.webmanifest", "files.json", "img/icon-192.png", "img/icon-512.png", "img/logo.png"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(SHELF))); });
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== C) await caches.delete(k);
  await self.clients.claim();
})()));

const tell = async m => { for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(m); };
async function save(urls, tag) {   // качаем по очереди, сообщаем прогресс
  const c = await caches.open(C); let done = 0;
  for (const u of urls) {
    if (!(await c.match(u))) { try { const r = await fetch(u); if (r.ok) await c.put(u, r); } catch (_) {} }
    done++; if (tag && (done % 5 === 0 || done === urls.length)) tell({ type: "progress", tag, done, total: urls.length });
  }
}
async function missing(urls) { const c = await caches.open(C); let n = 0; for (const u of urls) if (!(await c.match(u))) n++; return n; }
self.addEventListener("message", e => {
  const m = e.data || {};
  if (m.type === "lite") e.waitUntil(save(m.urls, "lite"));
  if (m.type === "video") e.waitUntil(save(m.urls, m.slug));
  if (m.type === "status") e.waitUntil((async () => { const out = {}; for (const [s, u] of Object.entries(m.books)) out[s] = await missing(u); tell({ type: "status", missing: out }); })());
});

async function ranged(req, full) {   // ответ 206 на Range из полного файла в кеше
  const buf = await full.arrayBuffer(); const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  const start = m && m[1] ? +m[1] : 0, end = m && m[2] ? +m[2] : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), { status: 206, headers: {
    "Content-Type": full.headers.get("Content-Type") || "video/mp4", "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
    "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes" } });
}
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = req.url.split("#")[0];
  if (req.headers.has("range")) {   // видео: из кеша нарезкой; нет в кеше — скачать целиком, положить и нарезать
    e.respondWith((async () => {
      const c = await caches.open(C); let full = await c.match(url);
      if (!full) { try { const r = await fetch(url); if (r.ok) { await c.put(url, r.clone()); full = r; } } catch (_) {} }
      return full ? ranged(req, full) : fetch(req);
    })());
    return;
  }
  if (req.mode === "navigate") {   // страницы: сначала сеть (свежая версия), без сети — кеш
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(url, cp)); return r; })
      .catch(async () => (await caches.match(url, { ignoreSearch: true })) || caches.match(url.replace(/\/?$/, "/index.html")) || caches.match("index.html")));
    return;
  }
  e.respondWith(caches.match(url).then(hit => hit || fetch(req).then(r => {   // остальное: кеш, иначе сеть (шрифты тоже, в т.ч. «непрозрачные»)
    if (r.ok || r.type === "opaque") { const cp = r.clone(); caches.open(C).then(c => c.put(url, cp)); } return r; })));
});
