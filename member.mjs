// A session's tools, served on this device as a MEMBER — with nothing installed
// but the public crypto.
//
// A session publishes its tools at <origin>/p/<kind>/<owner>/<id>/mcp. The host
// runs every kind's routes and knows every record shape; this device holds the
// member's key and nothing else. So the host dispatches and the device seals and
// signs:
//
//   tools/list   the host says, per tool, which fields a member seals
//                (`epistery.seal`) and where an opened record's text lands
//                (`epistery.contentField`) — the kind's own declaration.
//   tools/call   this device seals the declared fields under the session key K
//                (its own TreeKEM leaf, @epistery/client-lib), calls the host as
//                itself (the request-bound Bot header), and gets back the route's
//                answer as stored — ciphertext — plus the records the route built
//                and the events it would have broadcast. The device opens the
//                answer, signs and writes each record to the relay, then announces.
//
// The host sees ciphertext and signatures only. There is no kind code here and
// none is needed: a hundredth kind costs this device nothing.
//
// Dependencies: `epistery` (the rivet, the wire, the chain reader) and
// `@epistery/client-lib` (the group, the sealing module, the relay client, the
// key request). Nothing private, nothing per kind.

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { Config, chainReader } from 'epistery';
import { DsGroup } from '@epistery/client-lib/ds-group';
import { cryptoStack } from '@epistery/client-lib/treekem-kdf';
import { sealedKeys, openDeep } from '@epistery/client-lib/sealed';
import * as cipher from '@epistery/client-lib/cipher';
import { relayClient } from '@epistery/client-lib/relay';
import { keyRequest } from '@epistery/client-lib/session-keys';

// The tree crypto reads globalThis.ethers so it stays browser-servable; a Node
// process sets it once.
globalThis.ethers ??= ethers;

const SESSION_PATH = /^\/p\/([a-z0-9-]+)\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{40})(?:\/mcp)?\/?$/;

/** A session URL → { origin, kind, owner, id }, or null when it is not one. */
export function parseSessionUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = SESSION_PATH.exec(u.pathname);
  return m ? { origin: u.origin, kind: m[1], owner: m[2], id: m[3] } : null;
}

// The chain this device reads for itself to judge the Welcome that seats it: the
// owned attestation nodes the host names in its server identity — the same
// endpoints a browser at that origin reads, asserted k-of-n at its quorum. Never
// through the host it is talking to, and never a public fallback.
async function chainFor(origin) {
  const r = await fetch(`${origin}/`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${origin} did not answer its identity (HTTP ${r.status})`);
  const s = (await r.json())?.server;
  const rpcs = s?.attest?.rpcs || [];
  if (!rpcs.length) throw new Error(`${origin} names no attestation nodes — this device cannot judge a seat on the host's word alone`);
  return chainReader({ rpcs, quorum: s.attest.quorum ?? 1, chainId: s.chainId, ethers });
}

// Where this device keeps its own tree state for a session, beside the wallet it
// belongs to: <config>/<domain>/trees/<owner>-<session>.json, 0700/0600 as the
// rest of that tree is. A participant that commits cannot do without it.
function treeStoreFor(domain, session) {
  const dir = path.join(new Config().configDir, domain, 'trees');
  const file = path.join(dir, `${session.owner}-${session.id}.json`.toLowerCase());
  return {
    async load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } },
    async save(state) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); },
  };
}

/** Serve one session over stdio (newline-delimited JSON-RPC) as `wallet`. */
export async function serve({ url, wallet, input = process.stdin, output = process.stdout, log = (m) => process.stderr.write(m + '\n') }) {
  const ref = parseSessionUrl(url);
  if (!ref) throw new Error(`not a session URL: ${url} (expected <origin>/p/<kind>/<owner>/<id>)`);
  const session = { owner: ref.owner, id: ref.id, kind: ref.kind };
  const mcpUrl = `${ref.origin}/p/${ref.kind}/${ref.owner}/${ref.id}/mcp`;

  // The relay is same-origin with the host; this rivet signs its own writes.
  const relay = relayClient({
    baseUrl: ref.origin,
    checksum: (a) => ethers.utils.getAddress(a),
    signer: { address: wallet.address, sign: (m) => wallet.signMessage(m), identity: wallet.address },
  });
  const chain = await chainFor(ref.origin);
  const group = new DsGroup({
    relayUrl: ref.origin, contract: ref.owner, session: ref.id,
    address: wallet.address, rivetPriv: null, rivetPub: wallet.publicKey,
    sign: relay.dsSign(ref.owner),
    leafDecap: (enc) => wallet.computeSharedSecret(enc, ethers),
    stack: cryptoStack(),
    store: treeStoreFor(wallet.getDomain ? wallet.getDomain() : new URL(ref.origin).hostname, session),
    chain,
  });

  // The key: this device's own leaf. No seat yet → the courier key-request goes
  // out signed by this rivet, to its own identity and the session owner; any of
  // their devices that is online and holds the key seats it. Reads meanwhile
  // report sealed content as unreadable; writes refuse. Presence is the grant.
  let keys = sealedKeys(null, cipher);
  let asked = false;
  async function loadKeys() {
    if (keys.ready) return keys;
    try { await group.load(); keys = sealedKeys(group, cipher); }
    catch (e) {
      if (e?.code !== 'NO_SEAT') throw e;
      if (!asked) {
        asked = true;
        const ask = keyRequest({ owner: ref.owner, id: ref.id, rivet: wallet.address, pubkey: wallet.publicKey });
        for (const to of new Set([wallet.address, ref.owner])) { try { await relay.inboxSend(to, ask); } catch { /* best effort */ } }
        log(`[epistery-mcp] ${wallet.address} holds no key for this session yet — a key request was sent; a key-holder that is online will seat it`);
      }
    }
    return keys;
  }
  await loadKeys();

  // Every call to the host is signed as this rivet, bound to the exact bytes sent.
  async function call(msg) {
    const body = JSON.stringify(msg);
    const authorization = await wallet.createBotAuthHeader({ method: 'POST', url: mcpUrl, body });
    const r = await fetch(mcpUrl, { method: 'POST', headers: { authorization, 'content-type': 'application/json', accept: 'application/json' }, body });
    if (r.status === 204) return null;
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  // What each tool asks this device to seal — learned from the host's tools/list.
  const seal = new Map();   // tool name → { fields, contentField }
  let contentField = 'text';

  async function handle(msg) {
    if (msg.method === 'tools/list') {
      const res = await call(msg);
      for (const t of res?.result?.tools || []) {
        seal.set(t.name, { fields: t.epistery?.seal || [], contentField: t.epistery?.contentField || 'text' });
        if (t.epistery?.contentField) contentField = t.epistery.contentField;
        delete t.epistery;
      }
      return res;
    }
    if (msg.method !== 'tools/call') return call(msg);

    const name = msg.params?.name;
    const spec = seal.get(name) || { fields: [], contentField };
    const args = { ...(msg.params?.arguments || {}) };
    if (spec.fields.some((f) => typeof args[f] === 'string')) {
      await loadKeys();
      if (!keys.ready) throw new Error(`cannot seal for ${name}: this device holds no key for the session yet`);
      for (const f of spec.fields) {
        if (typeof args[f] !== 'string') continue;
        const enc = await keys.seal(args[f]);
        delete args[f];
        args.iv = enc.iv; args.ciphertext = enc.ciphertext; args.epoch = enc.epoch;
      }
    }
    const res = await call({ ...msg, params: { ...msg.params, arguments: args } });
    const meta = res?.result?._meta?.epistery;
    if (!meta) return res;

    // The records the route built, signed and written by this device; then the
    // events it would have broadcast, announced once the records are there.
    for (const w of meta.writes || []) {
      if (w.op === 'put') await relay.storagePut(ref.owner, w.path, w.value);
      else if (w.op === 'delete') await relay.storageDelete(ref.owner, w.path);
    }
    if (meta.events?.length) await call({ jsonrpc: '2.0', method: 'epistery/announce', params: { events: meta.events } });

    // The answer, opened here with this device's key.
    await loadKeys();
    const clear = await openDeep(keys, meta.body, spec.contentField);
    const { _meta, ...rest } = res.result;
    return { ...res, result: { ...rest, content: [{ type: 'text', text: typeof clear === 'string' ? clear : JSON.stringify(clear, null, 2) }] } };
  }

  log(`[epistery-mcp] ${wallet.address} as a member of ${ref.kind} ${ref.id} at ${ref.origin} (own key; the host sees ciphertext)`);
  const write = (obj) => output.write(JSON.stringify(obj) + '\n');
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const id = msg.id ?? null;
    try {
      const res = await handle(msg);
      if (res !== null && res !== undefined) write(res);
    } catch (e) {
      if (id !== null) write({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id });
      log(`[epistery-mcp] ${e.message}`);
    }
  }
}
