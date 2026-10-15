/** An uncertain external POST must never publish the user's report twice. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AgentFeedback } from "./feedback";

function fixture(gh: (path: string, body?: any) => Promise<any>) {
  const db = new Database(":memory:");
  const runtime: any = {store:{db},conversations:{threads:()=>["main","old","work"].map(id=>({id})),local:()=>[{id:"vulcan",name:"VULCAN",role:"Issue triage",session:"main",previous:["old"],workSessions:["work"]}]}};
  return {db,feedback:new AgentFeedback(runtime,gh),runtime};
}
test("feedback retries and concurrent submissions publish once, storing no report body",async()=>{
  let posts=0; let body:any;
  const f=fixture(async(path,payload)=>{expect(path).toBe("repos/ammonwk/agentbox/issues");posts++;body=payload;return {html_url:"https://github.com/ammonwk/agentbox/issues/123"};});
  try {
    const p={request:crypto.randomUUID(),text:"Keep already approved work moving",target:"work",uiRevision:{commit:"a".repeat(40),dirty:true}};
    const results=await Promise.all([f.feedback.submit("vulcan",p),f.feedback.submit("vulcan",p)]);
    expect(results.every(r=>r.state==="sent")).toBe(true);expect(posts).toBe(1);
    expect(body.body).toContain("Keep already approved work moving");expect(body.body).toContain("Session: work");expect(body.body).toContain(`UI revision: ${"a".repeat(40)} (local changes)`);expect(body.body).toContain("Server revision:");
    expect(JSON.stringify(f.db.query("SELECT * FROM agent_feedback").all())).not.toContain(p.text);
    await expect(f.feedback.submit("vulcan",{...p,text:"Changed report"})).rejects.toThrow("already used");
    expect((await f.feedback.submit("vulcan",p)).issue).toEndWith("/123");expect(posts).toBe(1);
    expect(await f.feedback.receipt("another-agent",p.request)).toBeNull();
  } finally {f.db.close();}
});
test("lost GitHub responses and restart reconcile an exact issue marker without another POST",async()=>{
  let posts=0,visible=false,body="";
  const gh=async(path:string,payload?:any)=>{
    if(payload){posts++;body=payload.body;throw Error("response lost after issue was created");}
    expect(path).toStartWith("search/issues?");
    return {items:visible ? [{html_url:"https://github.com/ammonwk/agentbox/issues/124",body}] : []};
  };
  const f=fixture(gh);
  try {
    const p={request:crypto.randomUUID(),text:"An improvement",target:"main"};
    expect((await f.feedback.submit("vulcan",p)).state).toBe("uncertain");
    const restarted=new AgentFeedback(f.runtime,gh);
    expect((await restarted.submit("vulcan",p)).state).toBe("uncertain");expect(posts).toBe(1);
    visible=true;
    expect((await restarted.receipt("vulcan",p.request))?.issue).toEndWith("/124");expect(posts).toBe(1);
    await expect(restarted.submit("vulcan",{...p,request:crypto.randomUUID(),target:"foreign"})).rejects.toThrow("does not belong");
    expect(posts).toBe(1);
  } finally {f.db.close();}
});
test("a public issue names no local home path or uploaded file path",async()=>{
  let body:any;
  const f=fixture(async(_path,payload)=>{body=payload;return {html_url:"https://github.com/ammonwk/agentbox/issues/125"};});
  try {
    const text="Avatar is wrong [Image #1: /Users/nate/.local/share/agentbox/uploads/a.png]\nSee /Users/nate/Desktop/Dev/agentbox/src/x.ts and /home/sam/repo and /opt/tools";
    await f.feedback.submit("vulcan",{request:crypto.randomUUID(),text,target:"main"});
    expect(body.body).not.toContain("/Users/");expect(body.body).not.toContain("/home/");expect(body.title).not.toContain("/Users/");
    expect(body.body).toContain("[Image #1: a.png, kept on the reporter's machine, not uploaded]");
    expect(body.body).toContain("~/Desktop/Dev/agentbox/src/x.ts");expect(body.body).toContain("~/repo");expect(body.body).toContain("/opt/tools");
  } finally {f.db.close();}
});
test("an agent files its own report as the agent's, at most three a day; another session cannot",async()=>{
  const bodies:any[]=[];
  const f=fixture(async(_path,payload)=>{bodies.push(payload);return {html_url:`https://github.com/ammonwk/agentbox/issues/${200+bodies.length}`};});
  f.runtime.conversations.registeredAgent=(s:string)=>["main","work"].includes(s)?{id:"vulcan"}:null;
  try {
    await expect(f.feedback.report("stranger",{request:crypto.randomUUID(),text:"Spam"})).rejects.toThrow("registered agent");
    const first={request:crypto.randomUUID(),text:"agent send needs a dry run\nDetails here"};
    expect((await f.feedback.report("work",first)).state).toBe("sent");
    expect(bodies[0].title).toBe("[Agent report] Vulcan: agent send needs a dry run");
    expect(bodies[0].body).toContain("Filed by the agent Vulcan itself, from session work");
    expect(bodies[0].body).toContain("No person reviewed it");
    expect((await f.feedback.report("work",first)).issue).toEndWith("/201");
    for (const n of [2,3]) expect((await f.feedback.report("main",{request:crypto.randomUUID(),text:`Finding ${n}`})).state).toBe("sent");
    const fourth=await f.feedback.report("main",{request:crypto.randomUUID(),text:"Finding 4"});
    expect(fourth.state).toBe("refused");expect(fourth.result).toContain("at most 3");
    expect(bodies).toHaveLength(3);
    // The person's /help is not counted against the agent.
    expect((await f.feedback.submit("vulcan",{request:crypto.randomUUID(),text:"From the user",target:"main"})).state).toBe("sent");
    expect(bodies[3].title).toStartWith("[Agent feedback]");
  } finally {f.db.close();}
});

/** Ticked /help images go to the public issue through `gh issue create --attach`;
 *  unticked ones, and all of them where gh cannot attach, stay on this machine. */
async function withUploads(run:(shot:(n:number)=>string)=>Promise<void>) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const previous=process.env.AGENTBOX_HOME, home=mkdtempSync(join(tmpdir(),"feedback-"));
  process.env.AGENTBOX_HOME=home; mkdirSync(join(home,"uploads"));
  const shot=(n:number)=>{const name=`20261015-${String(n).padStart(12,"0")}.png`,path=join(home,"uploads",name);writeFileSync(path,`png ${n}`);return path;};
  try { await run(shot); } finally { if(previous===undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME=previous; rmSync(home,{recursive:true,force:true}); }
}
function attaching(opts:{version?:string|null;push?:boolean;created?:{url:string|null;partial:boolean}}) {
  const db=new Database(":memory:"), posts:any[]=[], creates:any[]=[];
  const runtime:any={store:{db},conversations:{threads:()=>[{id:"main"}],local:()=>[{id:"vulcan",name:"VULCAN",role:"Issue triage"}]}};
  const gh=async(path:string,payload?:any)=>{
    if(path==="repos/ammonwk/agentbox") return {permissions:{pull:true,push:opts.push??true}};
    posts.push(payload);return {html_url:"https://github.com/ammonwk/agentbox/issues/300"};
  };
  const cli={version:async()=>opts.version===undefined?"2.102.0":opts.version,createIssue:async(issue:any)=>{creates.push(issue);return opts.created??{url:"https://github.com/ammonwk/agentbox/issues/301",partial:false};}};
  return {db,posts,creates,feedback:new AgentFeedback(runtime,gh,cli)};
}
test("only the images ticked for publication are attached, and no local path reaches the issue",async()=>{
  await withUploads(async(shot)=>{
    const one=shot(1),two=shot(2),f=attaching({});
    const r=await f.feedback.submit("vulcan",{request:crypto.randomUUID(),text:`Switch is off [Image #1: ${one}] and [Image #2: ${two}]`,target:"main",publish:[1]});
    expect(r).toMatchObject({state:"sent",issue:"https://github.com/ammonwk/agentbox/issues/301"});expect(r.note).toBeUndefined();
    expect(f.posts).toHaveLength(0);expect(f.creates).toHaveLength(1);
    expect(f.creates[0].attach).toEqual([{path:one,alt:"Image 1"}]);
    expect(f.creates[0].body).toContain("[Image #1: attached below]");
    expect(f.creates[0].body).toContain("[Image #2: 20261015-000000000002.png, kept on the reporter's machine, not uploaded]");
    expect(f.creates[0].body).not.toContain(process.env.AGENTBOX_HOME!);
    f.db.close();
  });
});
test("where gh is older than 2.99 or the account cannot write, images stay local and the issue says why",async()=>{
  await withUploads(async(shot)=>{
    const one=shot(1);
    for (const [opts,why] of [[{version:"2.85.0"},"the GitHub CLI here is 2.85.0; attaching images needs 2.99.0 or later"],[{push:false},"this GitHub account has no write access to ammonwk/agentbox"],[{version:null},"the GitHub CLI did not report its version"]] as const) {
      const f=attaching(opts);
      const r=await f.feedback.submit("vulcan",{request:crypto.randomUUID(),text:`Look [Image #1: ${one}]`,target:"main",publish:[1]});
      expect(r.state).toBe("sent");expect(r.note).toBe(`Images #1 were chosen for publication but not uploaded: ${why}.`);
      expect(f.creates).toHaveLength(0);expect(f.posts).toHaveLength(1);
      expect(f.posts[0].body).toContain("[Image #1: 20261015-000000000001.png, kept on the reporter's machine, not uploaded]");
      expect(f.posts[0].body).toContain(`not uploaded: ${why}.`);
      f.db.close();
    }
  });
});
test("a ticked image must be this machine's upload; a partial upload still files the issue once",async()=>{
  await withUploads(async(shot)=>{
    const one=shot(1),f=attaching({created:{url:"https://github.com/ammonwk/agentbox/issues/302",partial:true}});
    for (const text of ["No image here","[Image #1: /etc/passwd]","[Image #1: /tmp/../20261015-999999999999.png]"])
      expect((await f.feedback.submit("vulcan",{request:crypto.randomUUID(),text,target:"main",publish:[1]})).state).toBe("refused");
    expect(f.creates).toHaveLength(0);
    const p={request:crypto.randomUUID(),text:`Look [Image #1: ${one}]`,target:"main",publish:[1]};
    const r=await f.feedback.submit("vulcan",p);
    expect(r).toMatchObject({state:"sent",issue:"https://github.com/ammonwk/agentbox/issues/302",note:"Some of images #1 did not upload; check the issue."});
    expect((await f.feedback.submit("vulcan",p)).issue).toEndWith("/302");
    await expect(f.feedback.submit("vulcan",{...p,publish:[]})).rejects.toThrow("already used");
    expect(f.creates).toHaveLength(1);
    f.db.close();
  });
});
