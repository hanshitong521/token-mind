import { spawn } from "node:child_process";

const SERVER = "E:/workA/shejiuPro/.cursor/contextmind/mcp-server.mjs";
const p = spawn(process.execPath, [SERVER], {
	env: { ...process.env, CONTEXTMIND_PROJECT_DIR: "E:/workA/shejiuPro" },
	stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = new Map();
let nextId = 1;
p.stdout.on("data", (d) => {
	buf += d;
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		const f = JSON.parse(line);
		if (f.id && pending.has(f.id)) {
			pending.get(f.id)(f);
			pending.delete(f.id);
		}
	}
});
const call = (name, args) =>
	new Promise((res) => {
		const id = nextId++;
		pending.set(id, res);
		p.stdin.write(
			JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n",
		);
	});
const ok = (r) => r && !r.error && !r.result?.isError;
const text = (r) => r?.result?.content?.[0]?.text ?? "";

// IG-C07 orient: real shejiuPro call chain through the live server install
const orient = await call("context_orient", { query: "TBuyinOrderServiceImpl" });
const footer = text(orient).match(/\[contextmind\] (\d+) -> (\d+) tok/);
console.log("IG-C07 orient:", ok(orient), "| exit 0:", /exit_code=0/.test(text(orient)),
	"| gate footer:", !!footer, footer ? `${footer[1]} -> ${footer[2]}` : "");
const handle = (text(orient).match(/handle=(h_\w+)/) || [])[1];
console.log("  handle:", handle);

// IG-C08 find
const find = await call("context_find", { symbol: "isoDateOnly" });
console.log("IG-C08 find:", ok(find), "| file:line hit:", /\.java:\d+/.test(text(find)));

// IG-C09 impact
const impact = await call("context_impact", { symbol: "isoDateOnly" });
console.log("IG-C09 impact:", ok(impact), "| blast radius:", /(Impact|callers|callees)/i.test(text(impact)));

// IG-C10 fetch the orient handle
const fetch = handle ? await call("context_fetch", { handle, selector: { pattern: "OrderServiceImpl", flags: "i" } }) : null;
console.log("IG-C10 fetch:", ok(fetch), "| handle:", handle, "| matched lines:", text(fetch).split("\n").length);

// IG-C11 run a safe command
const run = await call("context_run", { command: 'node -e "console.log(42)"' });
console.log("IG-C11 run:", ok(run), "| exit 0 + 42:", /exit_code=0/.test(text(run)) && /42/.test(text(run)));

// IG-C12 the sixth tool: context_get with a real anchor
const get = await call("context_get", {
	task: "product order stats call chain",
	anchors: ["shejiu-modules/shejiu-product/src/main/java/com/shejiu/product/service/impl/TBuyinOrderServiceImpl.java"],
	budget_tokens: 600,
});
console.log("IG-C12 get:", ok(get), "| provenance:", /### TBuyinOrderServiceImpl\.java/.test(text(get)), "| budget footer:", /budget=600 tok/.test(text(get)));

p.kill();
process.exit(0);
