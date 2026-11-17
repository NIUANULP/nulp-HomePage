/*
 * Learnathon 2.0 winners: video streaming helper (service worker, scope /learnathon).
 *
 * Why this exists: NULP's Azure storage account answers open-ended range
 * requests ("Range: bytes=N-") with "200 OK" and the whole file, and only honours
 * bounded ranges ("bytes=N-M"). Browsers ask for video data with open-ended
 * ranges. For MP4s whose index ("moov" box) sits at the end of the file, the
 * browser then has to download the entire video (hundreds of MB) before it can
 * start playing.
 *
 * What it does: for video requests to the storage account that carry the
 * "lw2stream=1" marker (added by index.html to those videos only), it turns
 * open-ended ranges into bounded ones and answers with a proper
 * "206 Partial Content". Everything else passes through untouched.
 *
 * Removing it later (after DefaultServiceVersion is set on the storage account,
 * or the three videos are re-uploaded with "ffmpeg -movflags +faststart"):
 * deleting this file is NOT enough, because browsers that already installed it
 * keep running it. Instead:
 *   1. Replace this file's contents with the kill switch below and deploy it.
 *        self.addEventListener('install', function () { self.skipWaiting(); });
 *        self.addEventListener('activate', function (event) {
 *          event.waitUntil(self.registration.unregister());
 *        });
 *   2. Remove the register() block and the data-needs-sw / lw2stream markers
 *      from index.html.
 *   3. After a few months, delete this file.
 */

var STORAGE_HOST = 'nulpstorage.blob.core.windows.net';
var MARKER = 'lw2stream';
// Bytes per bounded request. Responses stream, so a larger chunk doesn't delay the
// start; it cuts round trips for high-bitrate videos (Skywalk is ~21 Mbit/s).
var CHUNK = 8 * 1024 * 1024;
var RETRIES = 2; // extra attempts per chunk before giving up
var sizes = new Map(); // url -> Promise<total size in bytes>

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

// A page loaded with a hard reload (Ctrl/Cmd+Shift+R) starts without a service
// worker even though this one is installed. The page asks us to take it over.
self.addEventListener('message', function (event) {
  if (event.data === 'claim') event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (url.hostname !== STORAGE_HOST || !url.searchParams.has(MARKER)) return;
  if (event.request.method !== 'GET') return;
  var range = event.request.headers.get('range');
  var m = range && /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  // Media elements always send a single "bytes=N-" or "bytes=N-M" range; anything
  // else (no range, multi-range) goes to the network unchanged.
  if (!m) return;
  url.searchParams.delete(MARKER);
  var start = Number(m[1]);
  var end = m[2] === '' ? null : Number(m[2]);
  // Every range for a marked video is answered here, bounded ones included.
  // Once this worker answers part of a video it must answer every part: mixing
  // its responses with the original (opaque) network responses within one media
  // resource makes Chrome abort playback. For the same reason, repeated failures
  // become a network error rather than a fallback to the original request.
  event.respondWith(
    boundedRange(url.toString(), start, end).catch(function () {
      return Response.error();
    })
  );
});

function totalSize(url) {
  if (!sizes.has(url)) {
    // Cache the in-flight promise so concurrent requests share one HEAD.
    var p = withRetry(function () {
      return fetch(url, { method: 'HEAD', mode: 'cors', credentials: 'omit' }).then(function (res) {
        var len = Number(res.headers.get('content-length'));
        if (!res.ok || !len) throw new Error('size unavailable');
        return len;
      });
    });
    // Don't cache failures: a later request can try again.
    p.catch(function () { sizes.delete(url); });
    sizes.set(url, p);
  }
  return sizes.get(url);
}

function boundedRange(url, start, requestedEnd) {
  return totalSize(url).then(function (total) {
    // Out of range, or an end before the start: answer like the origin would.
    if (start >= total || (requestedEnd !== null && requestedEnd < start)) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': 'bytes */' + total }
      });
    }
    var end = Math.min(requestedEnd === null ? Infinity : requestedEnd, start + CHUNK - 1, total - 1);
    return withRetry(function () {
      return fetch(url, {
        mode: 'cors',
        credentials: 'omit',
        headers: { Range: 'bytes=' + start + '-' + end }
      }).then(function (res) {
        if (res.status !== 206) throw new Error('range not honoured: ' + res.status);
        return res;
      });
    }).then(function (res) {
      return new Response(res.body, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'Content-Type': res.headers.get('content-type') || 'video/mp4',
          'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes'
        }
      });
    });
  });
}

function withRetry(fn) {
  var attempt = 0;
  function run() {
    return fn().catch(function (err) {
      if (attempt++ >= RETRIES) throw err;
      return new Promise(function (resolve) { setTimeout(resolve, 400 * attempt); }).then(run);
    });
  }
  return run();
}
