import { createContext, useContext } from "react";

/** Where the open session puts its facts: a slot at the start of the system
 *  bar along the bottom. Null while that bar is not there, and then the
 *  facts stay in the session's header. */
export const SysbarSlot = createContext<HTMLElement | null>(null);

export const useSysbarSlot = () => useContext(SysbarSlot);
