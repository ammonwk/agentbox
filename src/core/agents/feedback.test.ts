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
