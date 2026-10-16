/** A native login must never authenticate a different account home. */
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyClaudeNative } from "../accounts/identity";

test("native Claude status is scoped to the requested home and only accepts a proven subscription login",async()=>{
  const root=mkdtempSync(join(tmpdir(),"claude-native-identity-")), home=join(root,"account"), other=join(root,"other");
  mkdirSync(home);mkdirSync(other);
  const account={provider:"claude" as const,home,isDefault:false};
  const identity={loggedIn:true,authMethod:"claude.ai",configDirectory:home,email:"fixture@example.test",subscriptionType:"max"};
  let body:any=identity;
  const exec=async(argv:string[],opts:any)=>{
    expect(argv).toEqual(["claude","auth","status","--json"]);
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(home);
    return {code:0,stdout:JSON.stringify(body),stderr:"",timedOut:false};
  };
  try {
    expect(await identifyClaudeNative(account,exec)).toMatchObject({email:"fixture@example.test",auth:{state:"ok"}});
    body={...identity,configDirectory:other};expect((await identifyClaudeNative(account,exec)).auth.state).toBe("unknown");
    body={...identity,loggedIn:false};expect((await identifyClaudeNative(account,exec)).auth.state).toBe("missing");
    body={...identity,authMethod:"api_key"};expect((await identifyClaudeNative(account,exec)).auth.state).toBe("unknown");
  } finally {rmSync(root,{recursive:true,force:true});}
});
