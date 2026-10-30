/** Review comes with agentbox, as an extension like any other: its page is the cards sessions hand you (src/core/cards.ts). */
import { type Plugin, Icon } from "agentbox/client";
import { Review } from "./Review";

export default function review(p: Plugin) {
  p.page({
    id: "review",
    label: "Review",
    icon: Icon.cards,
    scoped: true,
    flush: true,
    // Kept for later is still yours, but you have seen it: it does not nag.
    badge: (state) => state.cards.filter((c) => c.state === "open").length,
    badgeTitle: (n) => `${n} card${n === 1 ? "" : "s"} to review`,
    keys: [
      ["→", "Answer the card"],
      ["↓", "Approve it"],
      ["←", "Later"],
      ["↑", "Read it whole"],
      ["u", "Undo"],
    ],
    render: ({ state }) => <Review state={state} />,
  });
}
