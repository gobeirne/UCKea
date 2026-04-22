const CACHE_NAME = "kea-cache-v2";
const FILES_TO_CACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/script.js",
  "/manifest.json",
  "/UClogo.png",
  "/sounds/correction_factors.csv",
  "/sounds/calib.wav",
  "/sounds/0000_2_AP_-5.4dB.wav",
  "/sounds/0005_AP_+0.4dB.wav",
  "/sounds/0008_W_+5.5dB.wav",
  "/sounds/0016_W_+7.5dB.wav",
  "/sounds/0019_AP_+2.7dB.wav",
  "/sounds/0040_W_-2.0dB.wav",
  "/sounds/0056_1_W_-9.3dB.wav",
  "/sounds/0058_W_-9.2dB.wav",
  "/sounds/0100_W_-0.7dB.wav",
  "/sounds/0127_W_-3.4dB.wav",
  "/sounds/27_0141_W_-8.3dB.wav",
  "/sounds/29_0011_W_-2.9dB.wav",
  "/sounds/35_0253_W_-1.5dB.wav",
  "/sounds/35_0336_W_-3.5dB.wav",
  "/sounds/42_0001_W_+3.1dB.wav",
  "/sounds/42_0004_W_+5.6dB.wav",
  "/sounds/42_0007_W_+2.8dB.wav",
  "/sounds/44_0003_W_-4.7dB.wav",
  "/sounds/44_0014_W_+2.2dB.wav",
  "/sounds/44_0017_W_+1.3dB.wav",
  "/sounds/44_0018_W_+4.7dB.wav",
  "/sounds/44_0029_W_+6.5dB.wav",
  "/sounds/44_0031_W_+6.2dB.wav",
  "/sounds/44_0053_W_+7.9dB.wav",
  "/sounds/44_0057_W_+5.6dB.wav",
  "/sounds/warble_U_-11.0dB.wav"
];

self.addEventListener("install", evt => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(FILES_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", evt => {
  evt.waitUntil(
    caches.keys().then(keyList =>
      Promise.all(
        keyList.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", evt => {
  evt.respondWith(
    caches.match(evt.request).then(response => {
      return response || fetch(evt.request);
    })
  );
});
