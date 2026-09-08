'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { approvedMarkup } from './markup';
import { mountMessenger,prepareV1Markup,prepareWelcomeMarkup } from './runtime';
import type { RuntimeOptions } from './types';
import { livePollInterval } from '@/domain/runs';
export function ApprovedMessenger(props:RuntimeOptions){
 const host=useRef<HTMLDivElement>(null);
 const runtime=useRef<ReturnType<typeof mountMessenger>|null>(null);
 const latest=useRef(props);latest.current=props;
 const router=useRouter();
 const renderedMarkup=prepareV1Markup(prepareWelcomeMarkup(approvedMarkup,Boolean(props.live)));
 useEffect(()=>{
  if(!host.current)return;
  // The controller owns this static subtree; React never reconciles its descendants.
  host.current.innerHTML=renderedMarkup;
  runtime.current=mountMessenger(host.current,{...latest.current,refresh:()=>router.refresh()});
  return()=>{runtime.current?.destroy();runtime.current=null;};
 },[router]);
 useEffect(()=>{runtime.current?.update({...props,refresh:()=>router.refresh()});},[props,router]);
 useEffect(()=>{
  if(!props.live)return;
  const refresh=()=>{if(document.visibilityState!=='hidden')router.refresh();};
  const timer=window.setInterval(refresh,livePollInterval(props.runs));
  const visible=()=>{if(document.visibilityState==='visible')router.refresh();};
  window.addEventListener('online',refresh);
  window.addEventListener('focus',refresh);
  document.addEventListener('visibilitychange',visible);
  return()=>{window.clearInterval(timer);window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible);};
 },[props.live,props.runs,router]);
 return <div ref={host} style={{display:'contents'}} dangerouslySetInnerHTML={{__html:renderedMarkup}} suppressHydrationWarning/>;
}
