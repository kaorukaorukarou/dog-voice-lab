// v0.3: Network-first avoids stale GitHub Pages updates; old IndexedDB is left intact.
const CACHE = 'canine-vocalization-lab-shell-v03';
const ASSETS = ['./','./index.html','./styles.css','./app.js?v=03','./pretrained-ai.js?v=03','./analysis-worker.js','./manifest.webmanifest','./icon-180.png','./icon-512.png','./icon.svg'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('canine-vocalization-lab-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 if(event.request.method!=='GET'||new URL(event.request.url).origin!==location.origin)return;
 event.respondWith(fetch(event.request).then(response=>{
   if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{});}
   return response;
 }).catch(()=>caches.match(event.request)));
});
