/** What /proc says on Linux, read from the kernel on macOS.
 *
 * macOS has no /proc. Its kernel answers the same questions through libproc
 * (`proc_pidinfo`, `proc_pidpath`, `proc_pidfdinfo`) and `sysctl`
 * (KERN_PROCARGS2 for argv and environment, kern.boottime). These are the
 * calls `ps` and `lsof` make, made here directly through bun:ffi: one spawn of
 * `ps` a poll would cost more than the whole Linux read, and `ps` cannot say
 * where one argv entry ends and the next begins.
 *
 * Every reader returns null (or an empty list) rather than throwing, like the
 * /proc readers it stands in for: a process can exit between any two calls,
 * and one that is not ours cannot be read.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

export const isDarwin = process.platform === "darwin";

const PROC_PIDLISTFDS = 1;
const PROC_PIDTASKALLINFO = 2;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDVNODEPATHINFO = 9;
const PROC_PIDFDVNODEPATHINFO = 2;
const PROX_FDTYPE_VNODE = 1;

/** sizeof(struct proc_bsdinfo); proc_taskinfo follows it in proc_taskallinfo. */
const BSDINFO = 136;
const TASKALLINFO = BSDINFO + 96;
/** sizeof(struct vnode_info): the path of a vnode_info_path follows it. */
const VNODE_INFO = 152;
const MAXPATHLEN = 1024;
/** sizeof(struct proc_fileinfo), ahead of the vnode_info_path in vnode_fdinfowithpath. */
const FILEINFO = 24;

type Lib = ReturnType<typeof open>;

function open() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidfdinfo: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
    mach_host_self: { args: [], returns: FFIType.u32 },
    host_statistics64: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

/** Lazy: an import must not do I/O, and Linux never opens it. */
let lib: Lib | null = null;
function sys(): Lib {
  return (lib ??= open());
}

function cstr(buf: Uint8Array, at: number, max: number): string {
  const end = buf.indexOf(0, at);
  return new TextDecoder().decode(buf.subarray(at, end < 0 || end > at + max ? at + max : end));
}

/** Every pid on the machine. */
export function listPids(): number[] {
  const n = sys().proc_listallpids(null, 0);
  if (n <= 0) return [];
  // Room for processes started between the two calls.
  const buf = new Int32Array(n + 64);
  const got = sys().proc_listallpids(ptr(buf), buf.byteLength);
  return got > 0 ? [...buf.subarray(0, got)].filter((p) => p > 0) : [];
}

export interface DarwinProc {
  pid: number;
  ppid: number;
  uid: number;
  /** The accounting name, capped at 16 bytes like Linux's comm at 15. */
  comm: string;
  /** Epoch ms, to the microsecond the kernel keeps. */
  startMs: number;
  /** User+system CPU, ns; null when the process is not ours to read. */
  cpuNs: number | null;
  rssBytes: number;
}

let timebase: number | null = null;
/** Task times are in mach absolute units: ns on Intel, 125/3 ns on Apple silicon. */
function machToNs(): number {
  if (timebase !== null) return timebase;
  const tb = new Uint32Array(2);
  timebase = sys().mach_timebase_info(ptr(tb)) === 0 && tb[1] ? tb[0]! / tb[1]! : 1;
  return timebase;
}

/** One process, as `ps` would list it; null when it is gone. */
export function procInfo(pid: number): DarwinProc | null {
  const buf = new Uint8Array(TASKALLINFO);
  const view = new DataView(buf.buffer);
  // The task half is refused for other users' processes; the BSD half is not.
  let full = sys().proc_pidinfo(pid, PROC_PIDTASKALLINFO, 0, ptr(buf), TASKALLINFO) === TASKALLINFO;
  if (!full && sys().proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(buf), BSDINFO) !== BSDINFO) return null;
  const t = BSDINFO;
  return {
    pid,
    ppid: view.getUint32(16, true),
    uid: view.getUint32(20, true),
    comm: cstr(buf, 48, 16),
    startMs: Number(view.getBigUint64(120, true)) * 1000 + Number(view.getBigUint64(128, true)) / 1000,
    cpuNs: full ? (Number(view.getBigUint64(t + 16, true)) + Number(view.getBigUint64(t + 24, true))) * machToNs() : null,
    rssBytes: full ? Number(view.getBigUint64(t + 8, true)) : 0,
  };
}

let argMax = 0;

/** argv and environment, exact: KERN_PROCARGS2 keeps the NULs between entries. */
export function procArgs(pid: number): { argv: string[]; env: Map<string, string> } | null {
  const s = sys();
  if (!argMax) {
    const mib = new Int32Array([1 /* CTL_KERN */, 8 /* KERN_ARGMAX */]);
    const out = new Int32Array(1);
    const len = new BigUint64Array([4n]);
    argMax = s.sysctl(ptr(mib), 2, ptr(out), ptr(len), null, 0) === 0 ? out[0]! : 1 << 20;
  }
  const mib = new Int32Array([1 /* CTL_KERN */, 49 /* KERN_PROCARGS2 */, pid]);
  const buf = new Uint8Array(argMax);
  const len = new BigUint64Array([BigInt(argMax)]);
  if (s.sysctl(ptr(mib), 3, ptr(buf), ptr(len), null, 0) !== 0) return null;
  const size = Number(len[0]);
  if (size < 4) return null;
  const argc = new DataView(buf.buffer).getInt32(0, true);
  // argc, the exec path, NUL padding, then argc strings and the environment.
  let at = buf.indexOf(0, 4);
  if (at < 0) return null;
  while (at < size && buf[at] === 0) at++;
  const strings: string[] = [];
  const dec = new TextDecoder();
  while (at < size) {
    const end = buf.indexOf(0, at);
    const stop = end < 0 || end > size ? size : end;
    if (stop === at) break; // the environment ends at an empty string
    strings.push(dec.decode(buf.subarray(at, stop)));
    at = stop + 1;
  }
  const env = new Map<string, string>();
  for (const kv of strings.slice(argc)) {
    const eq = kv.indexOf("=");
    if (eq > 0) env.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return { argv: strings.slice(0, argc), env };
}

/** The executable's path, as /proc/<pid>/exe resolves on Linux. */
export function exePath(pid: number): string | null {
  const buf = new Uint8Array(4 * MAXPATHLEN);
  const n = sys().proc_pidpath(pid, ptr(buf), buf.byteLength);
  return n > 0 ? new TextDecoder().decode(buf.subarray(0, n)) : null;
}

export function cwdPath(pid: number): string | null {
  const size = 2 * (VNODE_INFO + MAXPATHLEN);
  const buf = new Uint8Array(size);
  if (sys().proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, ptr(buf), size) !== size) return null;
  return cstr(buf, VNODE_INFO, MAXPATHLEN) || null;
}

/** Paths of the files a process holds open; sockets and pipes are skipped. */
export function openFiles(pid: number): string[] {
  const s = sys();
  const need = s.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, null, 0);
  if (need <= 0) return [];
  const fds = new Uint8Array(need + 64 * 8);
  const got = s.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, ptr(fds), fds.byteLength);
  if (got <= 0) return [];
  const view = new DataView(fds.buffer);
  const size = FILEINFO + VNODE_INFO + MAXPATHLEN;
  const info = new Uint8Array(size);
  const out: string[] = [];
  for (let i = 0; i + 8 <= got; i += 8) {
    if (view.getUint32(i + 4, true) !== PROX_FDTYPE_VNODE) continue;
    if (s.proc_pidfdinfo(pid, view.getInt32(i, true), PROC_PIDFDVNODEPATHINFO, ptr(info), size) !== size) continue;
    const path = cstr(info, FILEINFO + VNODE_INFO, MAXPATHLEN);
    if (path) out.push(path);
  }
  return out;
}

function sysctlBytes(name: string, size: number): DataView | null {
  const buf = new Uint8Array(size);
  const len = new BigUint64Array([BigInt(size)]);
  if (sys().sysctlbyname(ptr(Buffer.from(`${name}\0`)), ptr(buf), ptr(len), null, 0) !== 0) return null;
  return new DataView(buf.buffer, 0, Number(len[0]));
}

export interface VmState {
  total: number;
  /** What Activity Monitor counts as not in use: total less app, wired and compressed. */
  available: number;
  /** File-backed and purgeable pages: reclaimable, like Linux's page cache. */
  cache: number;
  swapTotal: number;
  swapUsed: number;
}

/** Memory and swap, in bytes, from host_statistics64 and sysctl. */
export function vmState(): VmState | null {
  const page = sysctlBytes("hw.pagesize", 8);
  const total = sysctlBytes("hw.memsize", 8);
  if (!page || !total) return null;
  const pageSize = page.byteLength === 8 ? Number(page.getBigUint64(0, true)) : page.getUint32(0, true);
  const memsize = Number(total.getBigUint64(0, true));
  // struct vm_statistics64: 38 natural_t long.
  const buf = new Uint8Array(152);
  const count = new Uint32Array([38]);
  if (sys().host_statistics64(sys().mach_host_self(), 4 /* HOST_VM_INFO64 */, ptr(buf), ptr(count)) !== 0) return null;
  const v = new DataView(buf.buffer);
  const wired = v.getUint32(12, true);
  const purgeable = v.getUint32(88, true);
  const compressor = v.getUint32(128, true);
  const external = v.getUint32(136, true);
  const internal = v.getUint32(140, true);
  const used = (internal - purgeable + wired + compressor) * pageSize;
  // struct xsw_usage: total, avail, used, then the page size and a flag.
  const swap = sysctlBytes("vm.swapusage", 32);
  return {
    total: memsize,
    available: Math.max(0, memsize - used),
    cache: (external + purgeable) * pageSize,
    swapTotal: swap ? Number(swap.getBigUint64(0, true)) : 0,
    swapUsed: swap ? Number(swap.getBigUint64(16, true)) : 0,
  };
}

let bootMs: number | null = null;

/** When the machine booted, epoch ms. */
export function bootTimeMs(): number {
  if (bootMs !== null) return bootMs;
  // struct timeval: seconds, then microseconds in the low half of the next word.
  const tv = sysctlBytes("kern.boottime", 16);
  bootMs = tv ? Number(tv.getBigInt64(0, true)) * 1000 + tv.getInt32(8, true) / 1000 : 0;
  return bootMs;
}

/** The pids whose parent is `pid`. */
export function childPids(pid: number): number[] {
  return listPids().filter((p) => procInfo(p)?.ppid === pid);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A start time as `ps -o lstart` prints it: "Thu Oct  8 02:57:54 2026". Claude
 * Code records its own start this way on macOS (`procStart` in its
 * sessions/<pid>.json), where Linux gets /proc's start ticks. The versions
 * seen write UTC; both readings are offered, since `ps` itself prints local.
 */
export function lstarts(ms: number): string[] {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const utc = `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
  const local = `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`;
  return [utc, local];
}
