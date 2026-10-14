/** On-demand GitHub profile for this machine's human. Credentials stay in gh;
 * the fleet's polling loop never performs this network request. */
import { readUserIdentity } from "./user";

export interface ProfileRepository {
  nameWithOwner: string; url: string; description: string | null;
  stargazerCount: number; forkCount: number; isPrivate: boolean;
  primaryLanguage: { name: string } | null;
}
export interface ProfileActivity {
  title: string; url: string; number: number; state: string; createdAt: string;
  repository: { nameWithOwner: string };
}
export interface GitHubProfile {
  login: string; name: string | null; avatarUrl: string; url: string;
  bio: string | null; company: string | null; location: string | null;
  websiteUrl: string | null; createdAt: string;
  followers: { totalCount: number }; following: { totalCount: number };
  repositories: { totalCount: number };
  pinnedItems: { nodes: ProfileRepository[] };
  pullRequests: { nodes: ProfileActivity[] };
  issues: { nodes: ProfileActivity[] };
  contributionsCollection: {
    restrictedContributionsCount: number;
    totalCommitContributions: number; totalPullRequestContributions: number;
    totalIssueContributions: number; totalPullRequestReviewContributions: number;
    contributionCalendar: {
      totalContributions: number;
      weeks: { contributionDays: { date: string; weekday: number; contributionCount: number; contributionLevel: string }[] }[];
    };
  };
}
export interface ProfileResult { profile: GitHubProfile | null; fetchedAt: number; error: string | null }

const QUERY = `query($login: String!) {
  user(login: $login) {
    login name avatarUrl(size: 256) url bio company location websiteUrl createdAt
    followers { totalCount } following { totalCount } repositories(ownerAffiliations: OWNER) { totalCount }
    pinnedItems(first: 6, types: REPOSITORY) { nodes { ... on Repository {
      nameWithOwner url description stargazerCount forkCount isPrivate primaryLanguage { name }
    } } }
    pullRequests(first: 8, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { title url number state createdAt repository { nameWithOwner } }
    }
    issues(first: 8, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { title url number state createdAt repository { nameWithOwner } }
    }
    contributionsCollection {
      restrictedContributionsCount
      totalCommitContributions totalPullRequestContributions totalIssueContributions totalPullRequestReviewContributions
      contributionCalendar { totalContributions weeks { contributionDays { date weekday contributionCount contributionLevel } } }
    }
  }
}`;
let cached: { login: string; value: ProfileResult } | null = null;
let pending: { login: string; value: Promise<ProfileResult> } | null = null;

export async function githubProfile(refresh = false): Promise<ProfileResult> {
  const login = readUserIdentity().github;
  if (!login) return { profile: null, fetchedAt: Date.now(), error: "No GitHub account was found. Sign in with gh auth login, then run agentbox onboard." };
  if (cached?.login === login && !refresh && Date.now() - cached.value.fetchedAt < (cached.value.error ? 30_000 : 300_000)) return cached.value;
  if (pending?.login === login) return pending.value;
  const value = load(login).then((value) => { cached = { login, value }; return value; }).finally(() => { if (pending?.value === value) pending = null; });
  pending = { login, value };
  return value;
}
async function load(login: string): Promise<ProfileResult> {
  try {
    if (!Bun.which("gh")) throw new Error("Install GitHub CLI and sign in with gh auth login to load your profile.");
    const proc = Bun.spawn(["gh", "api", "--hostname", "github.com", "graphql", "-f", `query=${QUERY}`, "-f", `login=${login}`], {
      stdout: "pipe", stderr: "ignore", env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 15_000);
    try {
      const [raw, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (timedOut) throw new Error("GitHub took too long to respond. Try again shortly.");
      if (code !== 0) throw new Error("GitHub profile unavailable. Check your connection and gh auth status, then try again.");
      const result = JSON.parse(raw) as { data?: { user?: GitHubProfile }; errors?: unknown[] };
      if (result.errors?.length || !result.data?.user) throw new Error("GitHub could not load this profile. Check the GitHub login in agentbox's user settings.");
      return { profile: result.data.user, fetchedAt: Date.now(), error: null };
    } finally { clearTimeout(timer); }
  } catch (error) {
    return { profile: null, fetchedAt: Date.now(), error: error instanceof Error ? error.message : "GitHub profile unavailable." };
  }
}
