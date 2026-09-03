// SCRAP AND STEEL — worker/registry.js
// Lobby Registry DO: room-code allocation, public summaries, cleanup. No combat data.

export class LobbyRegistry {
  constructor(state) {
    this.state = state;
    this.rooms = new Map(); // code -> { hostName, players, status, budgetSp, buildTimeSec, createdAt }
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.state.storage.get("rooms");
    if (stored) this.rooms = new Map(Object.entries(stored));
    this.loaded = true;
  }

  async save() {
    await this.state.storage.put("rooms", Object.fromEntries(this.rooms));
  }

  makeCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return code;
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.load();

    if (url.pathname === "/lobbies" && request.method === "GET") {
      const now = Date.now();
      const list = [];
      for (const [code, r] of this.rooms) {
        if (now - r.createdAt > 2 * 60 * 60 * 1000) continue; // stale
        if (r.players >= 2) continue;
        if (r.status !== "lobby") continue;
        list.push({ code, ...r });
      }
      list.sort((a, b) => b.createdAt - a.createdAt);
      return new Response(JSON.stringify({ lobbies: list.slice(0, 50) }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/allocate" && request.method === "POST") {
      let code = this.makeCode();
      let tries = 0;
      while (this.rooms.has(code) && tries++ < 20) code = this.makeCode();
      this.rooms.set(code, {
        hostName: "Player",
        players: 0,
        status: "lobby",
        budgetSp: 1000,
        buildTimeSec: 420,
        createdAt: Date.now(),
      });
      await this.save();
      return new Response(JSON.stringify({ code }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/update" && request.method === "POST") {
      const body = await request.json();
      const { code, ...patch } = body;
      const cur = this.rooms.get(code);
      if (cur) {
        this.rooms.set(code, { ...cur, ...patch });
        await this.save();
      }
      return new Response("ok");
    }

    if (url.pathname === "/remove" && request.method === "POST") {
      const { code } = await request.json();
      this.rooms.delete(code);
      await this.save();
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
