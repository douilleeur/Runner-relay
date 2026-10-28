// Serveur relais du jeu Runner : chaque « salle » est un Durable Object qui fait suivre
// les messages entre les joueurs connectés (WebSocket). Il ne stocke rien et ne contient
// aucune logique de jeu : c'est un simple facteur.
import { DurableObject } from "cloudflare:workers";

const MAX_PEERS = 40;          // joueurs max par salle (le salon public peut en accueillir plusieurs)
const MAX_MSG = 32 * 1024;     // taille max d'un message (32 Ko)
const RATE = 40, BURST = 90;   // messages par seconde (moyenne) et rafale tolérées par joueur
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

function originOk(req, env) {
  const list = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const o = req.headers.get("Origin");
  return !!o && list.includes(o);
}

// Développe une adresse IPv6 en 8 groupes (pour comparer les préfixes sans erreur)
function expandV6(ip) {
  let [a, b] = ip.split("::");
  const A = a ? a.split(":") : [], B = b ? b.split(":") : [];
  const miss = 8 - A.length - B.length;
  return [...A, ...(b !== undefined ? Array(Math.max(0, miss)).fill("0") : []), ...B].map((x) => x || "0");
}

// Clé « même Wi‑Fi » : empreinte de l'adresse publique vue par le serveur
// (IPv4 entière, ou préfixe /64 pour l'IPv6). Les appareils d'une même box ont la même clé.
async function wifiKey(req) {
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const base = ip.includes(":") ? expandV6(ip).slice(0, 4).join(":") : ip;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("runner-wifi|" + base));
  return [...new Uint8Array(buf)].slice(0, 7).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/ip") {
      return new Response(JSON.stringify({ k: await wifiKey(req) }), {
        headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket")
        return new Response("WebSocket attendu", { status: 426, headers: CORS });
      if (!originOk(req, env)) return new Response("Origine refusée", { status: 403, headers: CORS });
      const room = url.searchParams.get("room") || "";
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(room)) return new Response("Salle invalide", { status: 400, headers: CORS });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
    }

    return new Response("Runner relay : OK", { headers: CORS });
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.bucket = new Map(); // limite de débit par connexion (en mémoire)
    // Les « ping » des clients reçoivent « pong » sans réveiller l'objet
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  idOf(ws) {
    const a = ws.deserializeAttachment();
    return a && a.id;
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    const others = this.ctx.getWebSockets(); // les joueurs déjà présents (avant d'accepter le nouveau)
    this.ctx.acceptWebSocket(server);
    if (others.length >= MAX_PEERS) {
      server.send(JSON.stringify({ t: "full" }));
      server.close(1013, "salle pleine");
      return new Response(null, { status: 101, webSocket: client });
    }
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    server.serializeAttachment({ id });
    server.send(JSON.stringify({ t: "hello", id, peers: others.map((w) => this.idOf(w)).filter(Boolean) }));
    const j = JSON.stringify({ t: "join", id });
    for (const w of others) { try { w.send(j); } catch (e) {} }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > MAX_MSG) return;
    const me = this.idOf(ws);
    if (!me) return;
    // limite de débit : on jette l'excédent plutôt que de couper le joueur
    const now = Date.now(); let b = this.bucket.get(me);
    if (!b) { b = { n: BURST, t: now }; this.bucket.set(me, b); }
    b.n = Math.min(BURST, b.n + ((now - b.t) / 1000) * RATE); b.t = now;
    if (b.n < 1) return; b.n -= 1;
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    if (!m || m.t !== "m") return;
    const out = JSON.stringify({ t: "m", f: me, d: m.d });
    for (const w of this.ctx.getWebSockets()) {
      const o = this.idOf(w);
      if (!o || o === me || w.readyState !== 1) continue;
      if (m.to && o !== m.to) continue;
      try { w.send(out); } catch (e) {}
    }
  }

  webSocketClose(ws, code) {
    const id = this.idOf(ws);
    try { ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000); } catch (e) {}
    this.bye(ws, id);
  }

  webSocketError(ws) {
    this.bye(ws, this.idOf(ws));
  }

  bye(ws, id) {
    if (!id) return;
    this.bucket.delete(id);
    const l = JSON.stringify({ t: "leave", id });
    for (const w of this.ctx.getWebSockets()) {
      const o = this.idOf(w);
      if (!o || o === id || w.readyState !== 1) continue;
      try { w.send(l); } catch (e) {}
    }
  }
}
