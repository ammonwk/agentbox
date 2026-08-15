import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, HostClient, serveHost, type HostHandlers, type HostStatus } from "../hostproto";
import { sessionDirFor } from "../paths";

/**
 * The decoder is the one piece here that fails intermittently rather than
 * loudly: a transcript-sized payload straddling a chunk boundary is the
 * difference between "works on my machine" and "drops a permission reply
 * once an hour", so the boundaries are asserted rather than sampled.
 */
describe("LineDecoder", () => {
  test("returns whole lines and holds the partial tail", () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(d.push(Buffer.from('2}\n'))).toEqual(['{"b":2}']);
  });

  test("reassembles a value split across many chunks", () => {
    const d = new LineDecoder();
    const line = JSON.stringify({ text: "x".repeat(5000) });
    const chunks = (line + "\n").match(/[\s\S]{1,97}/g)!;
    const out = chunks.flatMap((c) => d.push(Buffer.from(c)));
    expect(out).toEqual([line]);
  });

  test("splits several values arriving in one chunk", () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n'))).toHaveLength(3);
  });

  test("ignores keepalive blank lines", () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from("\n\n"))).toEqual([]);
  });
});

describe("host control channel", () => {
  let home: string;
  const id = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentbox-proto-"));
    process.env.AGENTBOX_HOME = home;
    mkdirSync(sessionDirFor(id), { recursive: true });
  });

  afterEach(() => {
    delete process.env.AGENTBOX_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const status: HostStatus = {
    protocol: 1,
    sessionId: id,
    hostPid: 4242,
    agentPid: 4243,
    ompSessionId: "omp-1",
    alive: true,
    permission: null,
  };

  function handlers(over: Partial<HostHandlers> = {}): { h: HostHandlers; calls: string[] } {
    const calls: string[] = [];
    const h: HostHandlers = {
      status: () => status,
      send: (t) => void calls.push(`send:${t}`),
      interrupt: () => void calls.push("interrupt"),
      permission: (p, a) => void calls.push(`perm:${p}:${a}`),
      kill: () => void calls.push("kill"),
      ...over,
    };
    return { h, calls };
  }

  test("round-trips commands and status", async () => {
    const { h, calls } = handlers();
    const server = serveHost(id, h, () => {});
    const client = await HostClient.connect(id, () => {}, () => {});

    expect(await client.status()).toMatchObject({ sessionId: id, agentPid: 4243 });
    await client.send("hello");
    await client.interrupt();
    await client.replyPermission("perm-9", true);

    expect(calls).toEqual(["send:hello", "interrupt", "perm:perm-9:true"]);
    client.detach();
    server.shutdown();
  });

  test("a handler that throws fails one request without killing the host", async () => {
    const { h } = handlers({
      send: () => {
        throw new Error("agent is wedged");
      },
    });
    const server = serveHost(id, h, () => {});
    const client = await HostClient.connect(id, () => {}, () => {});

    await expect(client.send("boom")).rejects.toThrow("agent is wedged");
    // The connection survives, so the next command still lands.
    expect(await client.status()).toMatchObject({ sessionId: id });

    client.detach();
    server.shutdown();
  });

  test("a changed push tells the server to re-read", async () => {
    const { h } = handlers();
    const server = serveHost(id, h, () => {});
    let changed = 0;
    const client = await HostClient.connect(id, () => void changed++, () => {});

    server.broadcastChanged();
    server.broadcastChanged();
    await Bun.sleep(50);

    expect(changed).toBe(2);
    client.detach();
    server.shutdown();
  });

  test("connecting to a session with no host rejects", async () => {
    await expect(HostClient.connect(id, () => {}, () => {})).rejects.toThrow();
  });

  test("a host that goes away reports gone and rejects later commands", async () => {
    const { h } = handlers();
    const server = serveHost(id, h, () => {});
    let gone = 0;
    const client = await HostClient.connect(id, () => {}, () => void gone++);

    server.shutdown();
    await Bun.sleep(50);

    expect(gone).toBe(1);
    expect(client.alive).toBe(false);
    await expect(client.send("anyone there")).rejects.toThrow("host is gone");
  });

  test("a stale socket file left by a crashed host does not block the next one", async () => {
    const first = serveHost(id, handlers().h, () => {});
    // Simulate a crash: the process dies without unlinking its socket.
    first.shutdown();
    mkdirSync(sessionDirFor(id), { recursive: true });
    await Bun.write(join(sessionDirFor(id), "ctl.sock"), "");

    const second = serveHost(id, handlers().h, () => {});
    const client = await HostClient.connect(id, () => {}, () => {});
    expect(await client.status()).toMatchObject({ sessionId: id });

    client.detach();
    second.shutdown();
  });
});
