import { useRef, useState } from "react";
import type { AppState } from "../../../src/core/types";
import type { ProfileResult } from "../../../src/core/profile";
import { request } from "../api";
import { Button, Icon } from "../components";
import { useLoad } from "../lib/cloud";
import "./profile.css";

const LEVELS = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"];
const date = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
function safeLink(value: string | null): string | undefined {
  if (!value) return;
  try { const url = new URL(value.includes("://") ? value : `https://${value}`); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return; }
}

export function Profile({ identity }: { identity: AppState["onboarding"]["identity"] }) {
  const forceRefresh = useRef(false);
  const data = useLoad(() => {
    const force = forceRefresh.current;
    forceRefresh.current = false;
    return request<ProfileResult>("GET", `/api/profile${force ? "?refresh=1" : ""}`);
  }, [identity.github]);
  const p = data.data?.profile;
  const [imageFailed, setImageFailed] = useState(false);
  const name = p?.name || identity.name || p?.login || "Your profile";
  const github = p?.login || identity.github;
  const contributions = p?.contributionsCollection;
  const calendar = contributions?.contributionCalendar;
  const activity = [
    ...(p?.pullRequests.nodes ?? []).map((item) => ({ ...item, kind: "Pull request" })),
    ...(p?.issues.nodes ?? []).map((item) => ({ ...item, kind: "Issue" })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12);
  const error = data.error || data.data?.error;
  const website = safeLink(p?.websiteUrl ?? null);
  return <div className="profile-page">
    <aside className="profile-identity">
      <div className="profile-picture">{github && !imageFailed ? <img src={p?.avatarUrl || `https://github.com/${encodeURIComponent(github)}.png?size=256`} alt={`${name}'s profile`} onError={() => setImageFailed(true)} /> : <span>{name.split(/\s+/).slice(0, 2).map((v) => v[0]).join("")}</span>}</div>
      <h1>{name}</h1>
      {github && <p className="profile-login">@{github}</p>}
      {p?.bio && <p className="profile-bio">{p.bio}</p>}
      {github && <a className="profile-github" href={`https://github.com/${encodeURIComponent(github)}`} target="_blank" rel="noreferrer">View on GitHub <span aria-hidden="true">↗</span></a>}
      {p && <>
        <p className="profile-follow"><strong>{p.followers.totalCount.toLocaleString()}</strong> followers · <strong>{p.following.totalCount.toLocaleString()}</strong> following</p>
        <ul className="profile-facts">
          {p.company && <li>{p.company}</li>}
          {p.location && <li>{p.location}</li>}
          {website && <li><a href={website} target="_blank" rel="noreferrer">{p.websiteUrl}</a></li>}
          {identity.timezone && <li>{identity.timezone.replaceAll("_", " ")}</li>}
          <li>Joined {date(p.createdAt)}</li>
          <li>{p.repositories.totalCount.toLocaleString()} repositories</li>
        </ul>
      </>}
    </aside>
    <div className="profile-main">
      <header className="profile-heading"><div><span className="profile-eyebrow">YOUR GITHUB</span><h2>Overview</h2></div><Button onClick={() => { forceRefresh.current = true; void data.reload(); }} disabled={data.loading}><Icon.refresh size={14} /> Refresh</Button></header>
      {error ? <div className="profile-message" role="status"><h3>Profile unavailable</h3><p>{error}</p></div> : !p ? <p className="hint" role="status">Loading your GitHub profile…</p> : <>
        {calendar && contributions && <section className="profile-section" aria-label="Contribution history">
          <div className="profile-section-heading"><h3>{calendar.totalContributions.toLocaleString()} contributions in the last year</h3><span>Last 12 months</span></div>
          <div className="contribution-scroll" tabIndex={0} aria-label="Contribution calendar; scroll horizontally for the full year">
            <div className="contribution-months">{calendar.weeks.map((week, i) => {
              const first = week.contributionDays.find((d) => d.date.endsWith("-01"));
              return <span key={i}>{first ? new Date(`${first.date}T12:00:00`).toLocaleDateString(undefined, { month: "short" }) : ""}</span>;
            })}</div>
            <div className="contribution-grid" role="img" aria-label={`${calendar.totalContributions} contributions over the last year. Individual days are listed below.`}>
              {calendar.weeks.map((week, i) => <div className="contribution-week" key={i}>{week.contributionDays.map((day) => <span key={day.date} data-level={Math.max(0, LEVELS.indexOf(day.contributionLevel))} style={{ gridRow: day.weekday + 1 }} title={`${day.contributionCount} contributions on ${date(day.date)}`} />)}</div>)}
            </div>
          </div>
          <div className="contribution-legend"><a href={`https://github.com/${encodeURIComponent(github)}?tab=overview`} target="_blank" rel="noreferrer">Contribution details on GitHub ↗</a><span>Less</span>{LEVELS.map((_, i) => <i key={i} data-level={i} />)}<span>More</span></div>
          <details className="contribution-details"><summary>Daily contribution counts</summary><ul>{calendar.weeks.flatMap((w) => w.contributionDays).slice().reverse().map((d) => <li key={d.date}>{date(d.date)}: {d.contributionCount} contributions</li>)}</ul></details>
          <div className="profile-stats">{[[contributions.totalCommitContributions, "Commits"], [contributions.totalPullRequestContributions, "Pull requests"], [contributions.totalIssueContributions, "Issues"], [contributions.totalPullRequestReviewContributions, "Reviews"]].map(([count, label]) => <div key={label}><strong>{Number(count).toLocaleString()}</strong><span>{label}</span></div>)}</div>
          {contributions.restrictedContributionsCount > 0 && <p className="profile-private">The calendar also includes {contributions.restrictedContributionsCount.toLocaleString()} private contributions whose details GitHub keeps hidden.</p>}
        </section>}
        {p.pinnedItems.nodes.length > 0 && <section className="profile-section"><h3>Pinned repositories</h3><div className="profile-repositories">{p.pinnedItems.nodes.map((repo) => <a href={repo.url} key={repo.nameWithOwner} target="_blank" rel="noreferrer"><div><strong>{repo.nameWithOwner}</strong><span>{repo.isPrivate ? "Private" : "Public"}</span></div><p>{repo.description || "No description provided."}</p><small>{repo.primaryLanguage?.name}{repo.primaryLanguage ? " · " : ""}☆ {repo.stargazerCount.toLocaleString()} · {repo.forkCount.toLocaleString()} forks</small></a>)}</div></section>}
        <section className="profile-section"><h3>Recent pull requests & issues</h3>{activity.length ? <div className="profile-activity">{activity.map((item) => <a href={item.url} key={item.url} target="_blank" rel="noreferrer"><span className="activity-mark" data-state={item.state}><Icon.branch size={17} /></span><div><strong>{item.title}</strong><small>{item.repository.nameWithOwner} #{item.number} · {item.kind} · {item.state.toLowerCase()}</small></div><time dateTime={item.createdAt}>{date(item.createdAt)}</time></a>)}</div> : <p className="hint">No recent pull requests or issues to show.</p>}</section>
        <p className="profile-updated">From GitHub · Updated {new Date(data.data!.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Cached for 5 minutes</p>
      </>}
    </div>
  </div>;
}
