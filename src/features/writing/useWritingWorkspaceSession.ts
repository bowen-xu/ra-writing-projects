import {useEffect,useState} from "react";
import {readWorkspaceState,writeWorkspaceState,workspaceBoolean,workspaceString} from "@research-assistant/workbench-sdk/workspace-state";
import {WritingProjectTabs} from "./tabs/WritingProjectTabs";
import {loadWritingTabs} from "./tabs/writingTabSession";
import {useWritingWorkbenchVisibility} from "./useWritingWorkbenchVisibility";
import type {useWritingLayout} from "./useWritingLayout";

/** Window presentation only. File bodies and checkpoints are not duplicated. */
export function useWritingWorkspaceSession(openId:string | undefined,layout:ReturnType<typeof useWritingLayout>,
  onVisibility:((visible:boolean)=>void) | undefined,onFocus:((focused:boolean)=>void) | undefined,visible=true) {
  const [savedId]=useState(()=>readWorkspaceState("writing-active","",workspaceString)||undefined);
  const [entered,setEntered]=useState(visible);
  const [isLibraryOpen,setIsLibraryOpen]=useState(()=>openId===undefined&&!readWorkspaceState("writing-visible",false,workspaceBoolean));
  const [activeManuscriptId,setActiveManuscriptId]=useState<string | undefined>(visible&&!isLibraryOpen&&!openId?savedId:undefined);
  const [projectTabs]=useState(()=>new WritingProjectTabs(loadWritingTabs()));
  const [catalogReady,setCatalogReady]=useState(false);
  useEffect(()=>{
    if(visible&&!entered){
      setEntered(true);
      if(!isLibraryOpen&&!openId)setActiveManuscriptId(current=>current??savedId);
    }
  },[visible,entered,savedId,isLibraryOpen,openId]);
  useWritingWorkbenchVisibility(isLibraryOpen,onVisibility);
  useEffect(()=>{layout.exitFocus();},[activeManuscriptId,isLibraryOpen,layout.exitFocus]);
  useEffect(()=>{onFocus?.(layout.focused);return()=>onFocus?.(false);},[layout.focused,onFocus]);
  useEffect(()=>{
    if(!catalogReady||!entered)return;
    writeWorkspaceState("writing-active",activeManuscriptId??"");
    writeWorkspaceState("writing-visible",!isLibraryOpen&&activeManuscriptId!==undefined);
    if(!activeManuscriptId)setIsLibraryOpen(true);
  },[catalogReady,entered,activeManuscriptId,isLibraryOpen]);
  return {activeManuscriptId,setActiveManuscriptId,projectTabs,isLibraryOpen,setIsLibraryOpen,catalogReady,setCatalogReady};
}
