import { expect, test } from 'bun:test';
import { relayIdentity, sealPage, openPage } from '../agent-conversation';
test('transcript relay authenticates the ephemeral host key and request; observers and tampering fail closed',async()=>{
 const host=await relayIdentity(),reader=await relayIdentity(),observer=await relayIdentity(),id=crypto.randomUUID();
 const page={events:[{id:'event',kind:'assistant' as const,at:1,text:'Private shared-agent reply'}],next:null,session:'linked',status:'waiting'};
 const sealed=await sealPage(host.pair,reader.key,id,page);
 expect(await openPage(reader.pair,host.key,id,sealed.iv,sealed.chunks)).toEqual(page);
 await expect(openPage(observer.pair,host.key,id,sealed.iv,sealed.chunks)).rejects.toThrow();
 await expect(openPage(reader.pair,observer.key,id,sealed.iv,sealed.chunks)).rejects.toThrow();
 await expect(openPage(reader.pair,host.key,crypto.randomUUID(),sealed.iv,sealed.chunks)).rejects.toThrow();
 const forged=[...sealed.chunks];forged[0]=(forged[0]![0]==='A'?'B':'A')+forged[0]!.slice(1);
 await expect(openPage(reader.pair,host.key,id,sealed.iv,forged)).rejects.toThrow();
});
