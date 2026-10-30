// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationComposer } from "./conversation-composer";
import type { Contact } from "@/types/contacts";
import type { EmailMessageDoc } from "@/types/email";
vi.mock("@/context/sub-account-context",()=>({useSubAccount:()=>({subAccount:{}})}));
const warning=vi.hoisted(()=>vi.fn());
vi.mock("sonner",()=>({toast:{warning,error:vi.fn()}}));
const fetchMock=vi.fn();let container:HTMLDivElement;let root:Root;
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.stubGlobal("fetch",fetchMock);fetchMock.mockReset().mockResolvedValue({ok:true,json:async()=>({ok:true,sent:true,saved:false,warning:"Email sent. Do not resend."})});warning.mockClear();container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
it("sends selected email headers and clears accepted mail even if persistence fails",async()=>{
 const contact={id:"c1",email:"customer@example.com",whatsappOptedOut:true} as Contact;
 const emailReply={subject:"Question",messageId:"<one@example.com>",references:["<root@example.com>"]} as EmailMessageDoc;
 await act(async()=>root.render(createElement(ConversationComposer,{contact,availableChannels:["email"],defaultChannel:"email",emailReply})));
 const textarea=container.querySelector("textarea")!;
 expect(textarea.disabled).toBe(false);
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"Answer");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(fetchMock.mock.calls[0][0]).toBe("/api/comms/email/send");
 expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({contactId:"c1",body:"Answer",subject:"Re: Question",inReplyTo:"<one@example.com>",references:["<root@example.com>","<one@example.com>"]});
 expect(textarea.value).toBe("");expect(warning).toHaveBeenCalledWith("Email sent. Do not resend.");
});
