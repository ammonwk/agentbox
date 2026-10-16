import { Icon, type IconComponent } from "./components";
import { hrefOf, type Route } from "./route";

const SECTIONS: { label: string; icon: IconComponent; route: Route }[] = [
  { label: "General", icon: Icon.settings, route: { page: "settings" } },
  { label: "Accounts", icon: Icon.users, route: { page: "accounts", sub: "accounts" } },
  { label: "Skills", icon: Icon.folder, route: { page: "skills" } },
  { label: "MCP", icon: Icon.plugs, route: { page: "mcps" } },
];

export function SettingsNav({ route, accountAlerts }: { route: Route; accountAlerts: number }) {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {SECTIONS.map(({ label, icon: SectionIcon, route: to }) => (
        <a key={to.page} href={hrefOf(to)} aria-current={route.page === to.page ? "page" : undefined}>
          <SectionIcon size={16} />
          {label}
          {to.page === "accounts" && accountAlerts > 0 ? (
            <span className="settings-alert" aria-label={`${accountAlerts} accounts need a login`}>{accountAlerts}</span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}
