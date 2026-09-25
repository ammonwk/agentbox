import { createContext } from "react";

/** The GitHub repo URL this session's `#1234`s link into, or null for none.
 *  A context so the timeline's markdown rows do not each take it as a prop. */
export const PrBase = createContext<string | null>(null);
