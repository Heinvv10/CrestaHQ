// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
const state=vi.hoisted(()=>({paths:[] as string[],unsub:vi.fn()}));
vi.mock("@/lib/firebase/client",()=>({getFirebaseDb:()=>({})}));
vi.mock("firebase/firestore",()=>({collection:(_db:unknown,path:string)=>path,orderBy:()=>null,limit:()=>null,query:(path:string)=>path,onSnapshot:(path:string,receive:(snap:unknown)=>void)=>{state.paths.push(path);receive({docs:path.endsWith("emailMessages")?[{id:"m1",data:()=>({direction:"inbound",subject:"Question",body:"<script>alert(1)</script>",from:"customer@example.com",to:["owner@example.com"],status:"received",createdAt:null,attachments:[{filename:"invoice.pdf",contentType:"application/pdf",size:42}]})}]:path.includes("webChatSessions")?[{id:"v1",data:()=>({direction:"outbound",body:"Spoken answer",status:"sent",createdAt:null,via:"voice"})}]:[]});return state.unsub;}}));
it("subscribes to email and renders unsafe markup as text with attachment metadata",async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);state.paths=[];state.unsub.mockClear();const container=document.createElement("div");const root=createRoot(container);const reply=vi.fn();
 try {
 await act(async()=>root.render(createElement(ConversationThread,{contactId:"c1",onEmailReply:reply})));
 expect(state.paths).toContain("contacts/c1/emailMessages");expect(container.textContent).toContain("Question");expect(container.textContent).toContain("<script>alert(1)</script>");expect(container.querySelector("script")).toBeNull();expect(container.textContent).toContain("metadata only");expect(container.textContent).toContain("received");
 await act(async()=>container.querySelector("button")!.click());expect(reply).toHaveBeenCalledWith(expect.objectContaining({id:"m1",subject:"Question"}));
 } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
 expect(state.unsub).toHaveBeenCalledTimes(5);
});
it("marks Web Voice turns in the unified conversation thread",async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);state.paths=[];const container=document.createElement("div");const root=createRoot(container);
 try {
 await act(async()=>root.render(createElement(ConversationThread,{contactId:"",subAccountId:"sa1",sessionId:"abcdefghijklmnop"})));
 expect(container.textContent).toContain("Spoken answer");expect(container.querySelector('[aria-label="Spoken (voice)"]')?.textContent).toContain("voice");
 } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
});
