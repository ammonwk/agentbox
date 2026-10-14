/** Closing the wrong worker or replaying a close can destroy live work. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store";
import { AgentConversations } from "./conversation";
import { Fleet } from "../fleet";
import { closeDb, getSessionRecord, insertAccount, insertSessionRecord, insertWait, updateWait } from "../db";

let home: string, previous: string | undefined, store: AgentStore, conversations: AgentConversations;
let runtime: any, worker: any, view: any, closed: number, resumed: number;
beforeEach(() => {
  previous = process.env.AGENTBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "agent-session-actions-"));
  process.env.AGENTBOX_HOME = home;
  store = new AgentStore(join(home, "runtime.db"));
  closed = resumed = 0;
  worker = {session:"worker",agent:{id:"local-vulcan"},rounds:[]};
  view = {id:"worker",status:"waiting",lastActivityAt:1,cacheWarmUntil:100,background:false};
  runtime = {
    store, cards: {list:()=>[]},
    works: {list:()=>[worker], forSession:(id:string)=>id === worker.session ? worker : null, restorable:()=>true},
    fleet: {
      serial: async (_id:string, fn:()=>any)=>fn(), now:()=>50, get:()=>view,
      tick: async()=>{}, workHeld:()=>new Map(), hasTranscript:()=>true,
      accountFor:()=>({id:"pinned-account"}), resumeCwd:()=>home,
      close:async()=>{closed++;return {closed:["worker"]};},
      resumeNow:async()=>{resumed++;return {id:"worker",accountId:"pinned-account"};},
    },
  };
  runtime.fleet.closeIfIdle = Fleet.prototype.closeIfIdle.bind(runtime.fleet);
  runtime.fleet.resumeCached = Fleet.prototype.resumeCached.bind(runtime.fleet);
  conversations = new AgentConversations(runtime);
  const a = conversations.local().find(a=>a.id === "local-vulcan")!;
  a.session = "coordinator"; a.previous = ["old-coordinator"];
  store.db.run("UPDATE local_agents SET body=? WHERE id=?",[JSON.stringify(a),a.id]);
  const transcript = join(home,"transcript.jsonl"); writeFileSync(transcript,"{}\n");
  insertAccount({id:"pinned-account",provider:"claude",label:"Fixture",email:null,plan:null,home,isDefault:true,enabled:true,createdAt:1});
  insertSessionRecord({id:"worker",provider:"claude",agentSessionId:"provider-worker",accountId:"pinned-account",cwd:home,worktree:null,label:null,claim:0,origin:"agentbox",tmux:null,transcriptPath:transcript,startedAt:1,lastActivityAt:1,archivedAt:null,facts:null,createdAt:1});
});
afterEach(()=>{
  store.db.close();closeDb();
  if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME=previous;
  rmSync(home,{recursive:true,force:true});
});
const action = (kind:"close"|"restore"="close") => ({request:crypto.randomUUID(),action:kind,activity:1,reason:"Verified result; no outstanding work"});
const run = (p=action(), caller:string|null="coordinator", target="worker")=>conversations.sessionAction("local-vulcan",target,caller,p);

test("only the current coordinator or its worker can close; main chat and foreign/retired identities cannot",async()=>{
  for (const caller of ["unrelated","old-coordinator"]) await expect(run(action(),caller)).rejects.toThrow("Only this agent");
  await expect(run(action(),"coordinator","foreign")).rejects.toThrow("not the agent");
  await expect(run(action(),"coordinator","coordinator")).rejects.toThrow("main chat");
  expect(closed).toBe(0);
  expect((await run()).state).toBe("done"); expect(closed).toBe(1);
});
test("closing refuses a changed turn, live work, outstanding waits/PRs and pending decisions",async()=>{
  view.lastActivityAt=2; await expect(run()).rejects.toThrow("activity changed");
  view.lastActivityAt=1; view.status="running"; await expect(run()).rejects.toThrow("still working");
  view.status="waiting"; runtime.fleet.workHeld=()=>new Map([["worker",["PR #1"]]]);
  await expect(run()).rejects.toThrow("unfinished PRs or waits");
  runtime.fleet.workHeld=()=>new Map(); runtime.cards.list=()=>[{kind:"decision",state:"open",sessionId:"worker"}];
  await expect(run()).rejects.toThrow("waiting on a decision");
  runtime.cards.list=()=>[{kind:"decision",state:"later",sessionId:"worker"}];
  await expect(run()).rejects.toThrow("waiting on a decision");
  runtime.cards.list=()=>[];
  view.queued=[{text:"New work queued"}];
  await expect(run()).rejects.toThrow("still working");
  view.queued=[];view.question={text:"Unanswered"};
  await expect(run()).rejects.toThrow("still working");
  expect(closed).toBe(0);
});
test("a close retry never closes later work and uncertain actions are never replayed",async()=>{
  const p=action(); await run(p); view.status="running";
  expect((await run(p)).state).toBe("done");expect(closed).toBe(1);
  view.status="waiting";
  runtime.fleet.close=async()=>{closed++;throw Error("connection lost after stop");};
  const next=action(); await expect(run(next)).rejects.toThrow("connection lost");
  expect((await run(next)).state).toBe("uncertain");expect(closed).toBe(2);
});
test("a finished wait still awaiting delivery and open children prevent completion",async()=>{
  const w=insertWait({sessionId:"worker",spec:{kind:"time"},createdAt:1,deadline:2,memo:{}});
  updateWait(w.id,{ended:"happened",endedAt:2});
  await expect(run()).rejects.toThrow("unfinished PRs or waits");
  updateWait(w.id,{toldAt:3});
  insertSessionRecord({...getSessionRecord("worker")!,id:"child",agentSessionId:"provider-child",parent:"worker"});
  await expect(run()).rejects.toThrow("child sessions");expect(closed).toBe(0);
});
test("a lost transcript or resume directory is discovered before a process is stopped",async()=>{
  runtime.fleet.resumeCwd=()=>join(home,"missing");
  await expect(run()).rejects.toThrow("directory is missing");
  runtime.fleet.resumeCwd=()=>home;rmSync(join(home,"transcript.jsonl"));
  await expect(run()).rejects.toThrow("transcript and account");expect(closed).toBe(0);
});
test("warm restore retains the target, refuses revoked work, and rechecks expiry inside the serialized operation",async()=>{
  expect((await run(action("restore"))).state).toBe("done");expect(resumed).toBe(1);
  runtime.works.restorable=()=>false;
  await expect(run(action("restore"))).rejects.toThrow("authority");expect(resumed).toBe(1);
  runtime.works.restorable=()=>true;
  runtime.fleet.serial=async(_id:string,fn:()=>any)=>{view.cacheWarmUntil=50;return fn();};
  await expect(run(action("restore"))).rejects.toThrow("cache has expired");expect(resumed).toBe(1);
});
test("resume capability is rechecked after waiting for an in-flight send",async()=>{
  runtime.fleet.serial=async(_id:string,fn:()=>any)=>{runtime.works.restorable=()=>false;return fn();};
  await expect(run(action("restore"))).rejects.toThrow("authority");expect(resumed).toBe(0);
});
