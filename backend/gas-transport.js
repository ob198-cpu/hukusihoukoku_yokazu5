(function (root) {
  'use strict';
  function trustedOrigin(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' && (url.hostname === 'script.googleusercontent.com'
        || url.hostname.endsWith('-script.googleusercontent.com'));
    } catch (_) { return false; }
  }
  function belongsToFrame(source, frame) {
    try {
      for (let depth = 0; source && depth < 4; depth += 1) {
        if (source === frame) return true;
        if (source.parent === source) break;
        source = source.parent;
      }
    } catch (_) { return false; }
    return false;
  }
  function create(options) {
    const win = options.window, doc = options.document;
    const connections = new Map();
    function connect(endpoint, systemKey) {
      const url = new URL(endpoint);
      if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname)) {
        throw new Error('INVALID_BRIDGE_ENDPOINT');
      }
      if (typeof systemKey !== 'string' || !/^(hukusihoukoku|yokazu[2-8]?)$/.test(systemKey)) throw new Error('INVALID_BRIDGE_TARGET');
      const connectionKey = endpoint + '\n' + systemKey;
      if (connections.has(connectionKey)) return connections.get(connectionKey);
      const token = Array.from(win.crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');
      const frame = doc.createElement('iframe');
      frame.hidden = true;
      frame.title = 'Sheet connection';
      frame.setAttribute('aria-hidden', 'true');
      const pending = new Map();
      let peer, peerOrigin, counter = 0, readyTimer, closed = false;
      let resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      function close(reason) {
        if (closed) return;
        closed = true;
        win.clearTimeout(readyTimer);
        win.removeEventListener('message', receive);
        frame.remove();
        connections.delete(connectionKey);
        rejectReady(reason);
        pending.forEach(p => { win.clearTimeout(p.timer); p.reject(reason); });
        pending.clear();
      }
      function receive(event) {
        const message = event.data;
        if (!message || message.channel !== 'sns-sheet-v1' || message.token !== token
          || !trustedOrigin(event.origin) || !belongsToFrame(event.source, frame.contentWindow)) return;
        if (message.type === 'ready' && !peer) {
          peer = event.source;
          peerOrigin = event.origin;
          win.clearTimeout(readyTimer);
          resolveReady();
        } else if (message.type === 'result' && event.source === peer && event.origin === peerOrigin) {
          const p = pending.get(message.id);
          if (!p) return;
          pending.delete(message.id);
          win.clearTimeout(p.timer);
          if (typeof message.result !== 'string') p.reject(new Error('INVALID_BRIDGE_RESPONSE'));
          else p.resolve(message.result);
        }
      }
      win.addEventListener('message', receive);
      readyTimer = win.setTimeout(() => close(new Error('シートとの接続を確認できません。未送信内容を残して再接続します。')), options.readyTimeoutMs || 45000);
      url.searchParams.set('transport', 'sheet-bridge-v1');
      url.searchParams.set('systemKey', systemKey);
      url.searchParams.set('parentOrigin', win.location.origin);
      url.searchParams.set('channelToken', token);
      frame.src = url.href;
      const connection = {
        async request(payload) {
          await ready;
          if (closed) throw new Error('BRIDGE_CLOSED');
          const id = String(++counter);
          return new Promise((resolve, reject) => {
            // A Sheets write may keep running after a shorter browser timeout.
            const timer = win.setTimeout(() => close(new Error('シートから保存結果を受け取れませんでした。未送信内容は削除しません。')), options.requestTimeoutMs || 390000);
            pending.set(id, { resolve, reject, timer });
            try {
              peer.postMessage({channel:'sns-sheet-v1',token,type:'request',id,payload:JSON.stringify(payload)}, peerOrigin);
            } catch (error) { close(error); }
          });
        },
        close
      };
      connections.set(connectionKey, connection);
      doc.body.appendChild(frame);
      return connection;
    }
    return {
      request(endpoint, payload) { return connect(endpoint, payload && payload.systemKey).request(payload); },
      close() { Array.from(connections.values()).forEach(c => c.close(new Error('BRIDGE_CLOSED'))); }
    };
  }
  let client;
  const api = { create, trustedOrigin, belongsToFrame,
    request(endpoint, payload) {
      if (!client) client = create({window:root, document:root.document});
      return client.request(endpoint, payload);
    }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnsGasTransport = api;
})(typeof window !== 'undefined' ? window : globalThis);
