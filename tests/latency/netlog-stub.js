// A stand-in for games-guard's NetLog under wrangler dev, for
// tests/latency/rooms.test.mjs: the relay's NETLOG service binding reaches
// this worker (same name, same entrypoint) through wrangler's dev registry,
// and GET /records returns every record it was sent. The records live in one
// Durable Object, since the entrypoint and fetch may run in separate isolates.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Records extends DurableObject {
	list = [];
	add(entry) { this.list.push(entry); }
	all() { return this.list; }
}

export class NetLog extends WorkerEntrypoint {
	async record(game, record) {
		await this.env.RECORDS.getByName("all").add({ game, record });
		return { ok: true };
	}
}

export default {
	async fetch(request, env) {
		if (new URL(request.url).pathname === "/records") return Response.json(await env.RECORDS.getByName("all").all());
		return new Response("netlog stub\n");
	},
};
