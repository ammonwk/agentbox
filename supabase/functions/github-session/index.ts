// A GitHub CLI login is a sign-in (docs/cloud.md "Humans"). The desktop app
// sends the token `gh auth token` prints:
//
//   link   — with the signed-in human's JWT: this GitHub user is that human.
//   signin — without one: a session for the human this GitHub user is linked to.
//
// GitHub itself says whom the token is for and that the GitHub CLI was given
// it, so a token handed to any other app, or a personal access token, signs
// in nobody. The link is the human's app_metadata, which only this secret key
// can write; nothing is matched by email or login, which can change hands.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";

// The GitHub CLI's OAuth app. Its secret is public (it ships in gh); GitHub
// wants it only to ask which app a token belongs to.
const GH_CLI = { id: "178c6fc778ccc68e1d6a", secret: "34ddeff2b558a23d38fba8a6de74f086ede1cc0b" };

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SECRET = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUBLIC = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** The GitHub user a GitHub CLI token is for, or null. */
async function githubUser(token: unknown): Promise<{ id: number; login: string } | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 255) return null;
  const r = await fetch(`https://api.github.com/applications/${GH_CLI.id}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${GH_CLI.id}:${GH_CLI.secret}`)}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "agentbox-github-session",
    },
    body: JSON.stringify({ access_token: token }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return typeof d?.user?.id === "number" ? { id: d.user.id, login: String(d.user.login) } : null;
}

/** The human linked to a GitHub user id. */
async function linkedHuman(githubId: number) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.app_metadata?.github_id === githubId);
    if (hit || data.users.length < 1000) return hit ?? null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  let body: { action?: string; githubToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "a JSON body is needed" });
  }
  const gh = await githubUser(body.githubToken);
  if (!gh) return reply(401, { error: "that is not a GitHub CLI login GitHub knows" });

  if (body.action === "link") {
    const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data.user || data.user.is_anonymous) return reply(401, { error: "sign in first" });
    const other = await linkedHuman(gh.id);
    if (other && other.id !== data.user.id) return reply(409, { error: `GitHub user ${gh.login} is linked to another agentbox account` });
    if (!other) {
      const { error: e } = await admin.auth.admin.updateUserById(data.user.id, {
        app_metadata: { ...data.user.app_metadata, github_id: gh.id, github_login: gh.login },
      });
      if (e) return reply(500, { error: e.message });
    }
    return reply(200, { linked: gh.login });
  }

  if (body.action === "signin") {
    const human = await linkedHuman(gh.id);
    if (!human?.email) return reply(404, { error: `GitHub user ${gh.login} is not linked to an agentbox account; sign in with your email once` });
    // A magic link's token, used here at once: no email is sent.
    const { data: link, error: e1 } = await admin.auth.admin.generateLink({ type: "magiclink", email: human.email });
    if (e1) return reply(500, { error: e1.message });
    const anon = createClient(URL_, PUBLIC, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error: e2 } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
    if (e2 || !data.session) return reply(500, { error: e2?.message ?? "no session" });
    return reply(200, { access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  }

  return reply(400, { error: "action is link or signin" });
});
