import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { cleanupAll } from "../e2e/runtime-scope/cleanup.mjs";
import { listenServer } from "../e2e/openclaw-host-plugin/server-lifecycle.mjs";
import { createSyntheticOcto } from "../e2e/runtime-scope/synthetic-octo.mjs";

it("account rejection and secondary cleanup failures cannot skip server/instance/directory cleanup or replace the first error",async()=>{
  const original=new Error("account rejected"),order:string[]=[];const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  try {
    await expect(cleanupAll([
      ()=>{order.push("abort");},
      ()=>{order.push("running");return Promise.reject(original);},
      ()=>{order.push("server");throw new Error("server close failed");},
      ()=>{order.push("candidate");throw new Error("dispose failed");},
      ()=>{order.push("live");},()=>{order.push("directory");},
    ],original)).rejects.toBe(original);
    expect(order).toEqual(["abort","running","server","candidate","live","directory"]);
    expect(log).toHaveBeenCalledTimes(2);
  } finally{log.mockRestore();}
});
it("a shutdown rejection after a successful run still closes all remaining resources",async()=>{
  const error=new Error("shutdown rejected"),close=vi.fn();
  await expect(cleanupAll([()=>Promise.reject(error),close])).rejects.toBe(error);expect(close).toHaveBeenCalledOnce();
});
it("an explicitly undefined rejection cannot become a successful probe after cleanup",async()=>{
  const close=vi.fn();await expect(cleanupAll([close],undefined)).rejects.toBeUndefined();expect(close).toHaveBeenCalledOnce();
});
it("server errors remain observed after readiness and repeated error events cannot become uncaught",async()=>{
  const server=createServer(),reported=vi.fn(),lifecycle=listenServer(server,0,reported);
  try {
    await lifecycle.ready;const error=new Error("late server fault");
    expect(()=>server.emit("error",error)).not.toThrow();await expect(lifecycle.failed).rejects.toBe(error);
    expect(()=>server.emit("error",new Error("second fault"))).not.toThrow();expect(()=>lifecycle.check()).toThrow(error);
    expect(reported).toHaveBeenCalledOnce();
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it("a bind error rejects readiness as well as the lifetime failure channel",async()=>{
  const first=createServer(),one=listenServer(first,0);await one.ready;
  const second=createServer(),two=listenServer(second,(first.address() as {port:number}).port);
  try{await expect(two.ready).rejects.toMatchObject({code:"EADDRINUSE"});await expect(two.failed).rejects.toMatchObject({code:"EADDRINUSE"});}
  finally{await new Promise<void>(resolve=>first.close(()=>resolve()));await new Promise<void>(resolve=>second.close(()=>resolve()));}
});
it("malformed synthetic HTTP input is observable without an unhandled rejection",async()=>{
  const peer=await createSyntheticOcto();
  try{const response=await fetch(peer.baseUrl+"/v1/chat/completions",{method:"POST",body:"{"});expect(response.status).toBe(400);await expect(peer.failed).rejects.toThrow();}
  finally{await peer.close();}
});
