import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import CryptoJS from "crypto-js";
import { WKSocket } from "./socket.js";
import type { BotMessage } from "./types.js";
import { createSocketPeer } from "../e2e/openclaw-host-plugin/socket-peer.mjs";
import { createSyntheticOcto, BOT_UID, HUMAN_UID } from "../e2e/runtime-scope/synthetic-octo.mjs";

for (const kind of ["card", "scope"]) it(`${kind} peer uses a 16-byte IV for a real handshake, decrypt and ACK`, async () => {
  const encrypt=vi.spyOn(CryptoJS.AES,"encrypt");
  let close: () => Promise<void> = async()=>{};
  let client: WKSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let wsUrl: string;
    let send: (() => Promise<unknown>) | undefined;
    let sent: Promise<unknown> | undefined;
    let acked: () => boolean = ()=>true;
    if(kind==="card") {
      const server=createServer();const peer=createSocketPeer(server,"/ws");
      close=async()=>{await peer.close();await new Promise<void>(resolve=>server.close(()=>resolve()));};
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      wsUrl=`ws://127.0.0.1:${(server.address() as {port:number}).port}/ws?account=scope`;
      send=()=>peer.send("scope",HUMAN_UID,"IV_ROUNDTRIP_OK");
    } else {
      const peer=await createSyntheticOcto();close=()=>peer.close();
      wsUrl=peer.baseUrl.replace("http:","ws:")+"/ws";acked=()=>peer.acked;
    }
    const received=new Promise<BotMessage>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error("synthetic peer message timeout")),5000);
      client=new WKSocket({wsUrl,uid:BOT_UID,token:"synthetic-only",onMessage:resolve,onError:reject,
        onConnected:()=>{if(send){sent=send();void sent.catch(reject);}}});
      client.connect();
    });
    const message=await received;
    expect(message.payload.content).toBe(kind==="card"?"IV_ROUNDTRIP_OK":"Reply with the scope test marker");
    if(kind==="card"){expect(sent).toBeDefined();await expect(sent).resolves.toMatchObject({messageId:message.message_id,messageSeq:message.message_seq});}
    await vi.waitFor(()=>expect(acked()).toBe(true));
    expect(encrypt).toHaveBeenCalled();
    for(const call of encrypt.mock.calls)expect(call[2]?.iv?.sigBytes).toBe(16);
  } finally {
    clearTimeout(timer);client?.disconnect();await close();encrypt.mockRestore();
  }
});
