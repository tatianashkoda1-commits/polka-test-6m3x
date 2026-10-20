// Полка: один сервис-воркер на все книги.
// 1) установка — сама полка; 2) по команде полки — «лёгкие» файлы всех книг (тексты, фото);
// 3) по кнопке — видео книги; 4) всё, что открывалось, тоже остаётся. Запросы видео кусками (Range, так делает Safari)
//    отдаются из кеша нарезкой 206 — иначе на iPhone видео офлайн не играет.
const C = "polka-v3";  // v3 20.10: новая обложка «Ленивой», мягкое затемнение, «Шеф(ы)» — старый кеш сносится
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
// одна очередь на всё: сначала тексты и фото, потом видео книг по очереди; общий счётчик и счётчик каждой книги
let running = null;
async function all(jobs, dry) {
  // что уже в телефоне — одним списком (сотни отдельных c.match на iPhone занимают секунды и задерживают открытие книги)
  const c = await caches.open(C); const books = {}; let done = 0, total = 0; const todo = [];
  const have = new Set((await c.keys()).map(r => r.url));
  for (const j of jobs) { let d = 0;
    for (const u of j.urls) { if (have.has(new URL(u, self.registration.scope).href)) d++; else todo.push([j.tag, u]); }
    books[j.tag] = [d, j.urls.length]; done += d; total += j.urls.length; }
  const report = () => { const b = { ...books }; delete b.lite; tell({ type: "all", done, total, books: b }); };
  report(); if (dry) return;
  // 6 загрузок одновременно: файлов сотни, мелких — медленно не из-за объёма, а из-за ожидания ответа на каждый
  let n = 0, i = 0;
  const worker = async () => { while (i < todo.length) { const [tag, u] = todo[i++];
    try { const r = await fetch(u); if (r.ok) { await c.put(u, r); done++; books[tag][0]++; } } catch (_) {}
    if (++n % 6 === 0) report(); } };
  await Promise.all(Array.from({ length: 6 }, worker));
  report();
}
self.addEventListener("message", e => {
  const m = e.data || {};
  if (m.type === "all") e.waitUntil(running && !m.dry ? running.then(() => all(m.jobs, true)) : (m.dry ? all(m.jobs, true) : (running = all(m.jobs).finally(() => { running = null; }))));
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
  if (req.mode === "navigate") {   // страницы: сразу из телефона, если есть (не ждём сеть, пока качаются видео); свежую версию тянем в фоне
    const fresh = fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(url, cp)); } return r; });
    e.respondWith((async () => {
      const hit = (await caches.match(url, { ignoreSearch: true })) || (await caches.match(url.replace(/\/?$/, "/index.html")));
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      try { return await fresh; } catch (_) { return (await caches.match("index.html")) || Response.error(); }
    })());
    return;
  }
  e.respondWith(caches.match(url).then(hit => hit || fetch(req).then(r => {   // остальное: кеш, иначе сеть (шрифты тоже, в т.ч. «непрозрачные»)
    if (r.ok || r.type === "opaque") { const cp = r.clone(); caches.open(C).then(c => c.put(url, cp)); } return r; })));
});
