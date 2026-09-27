/**
 * When a scheduled session starts: "in 4 hours", "tomorrow at 9am", "every
 * weekday at 8:30". Plain words in, a rule out, and the rule said back in
 * words so what was understood is visible before it is saved.
 *
 * Pure — no Node, no DOM — because the new-session dialog previews with the
 * same parser the server saves with. Times of day are the machine's local
 * time: agentbox runs on the machine you sit at.
 */

export type ScheduleRule =
  /** Once, at `at`. */
  | { kind: "once"; at: number }
  /** On these weekdays (0 = Sunday) at `minute` past local midnight. */
  | { kind: "weekly"; days: number[]; minute: number }
  /** Every `minutes`, counted from `from`. */
  | { kind: "every"; minutes: number; from: number }
  /** Once, when pull request `pr` merges: of `repo` (owner/name), or — while
   *  null, before the server has filled it in — of the repo it runs in. */
  | { kind: "merge"; pr: number; repo: string | null; title?: string };

export type ParsedWhen = { rule: ScheduleRule } | { error: string };

const MIN = 60_000;
/** Shorter than this, a recurring session is a loop, not a schedule. */
const MIN_EVERY = 5;

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parts of the day, for "tomorrow morning" and "every evening". */
const PARTS: Record<string, number> = { morning: 9 * 60, afternoon: 14 * 60, evening: 19 * 60, night: 21 * 60, tonight: 21 * 60 };

/** Starts a new session each time; the others start once, under their own id. */
export function isRecurring(rule: ScheduleRule): boolean {
  return rule.kind === "weekly" || rule.kind === "every";
}

/** Read what was typed, as of `now`. */
export function parseWhen(input: string, now: number = Date.now()): ParsedWhen {
  let t = input
    .toLowerCase()
    .replace(/[.!]+$/, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(start|run|launch|schedule|begin)( it)? /, "")
    .trim();
  if (!t) return { error: "Say when: “in 4 hours”, “tomorrow at 9am”, “every weekday at 8:30”." };
  if (t === "now" || t === "right now") return { error: "That is now: use Start instead." };

  // ---- when a PR merges
  const merge = mergeOf(t);
  if (merge) return { rule: merge };

  // ---- recurring
  const every = /^(?:every|each) (.+)$/.exec(t);
  if (every || /^(hourly|daily|weekdays|weekends|nightly)\b/.test(t) || /^weekly /.test(t)) {
    return recurring(every ? every[1]! : t, now);
  }

  // ---- once, relative
  if (/^in /.test(t)) {
    const ms = duration(t.slice(3));
    if (ms === null) return { error: `Could not read “${t.slice(3)}” as a length of time.` };
    if (ms < MIN) return { error: "That is less than a minute from now: use Start instead." };
    return { rule: { kind: "once", at: now + ms } };
  }

  // ---- once, absolute: [day] [at time]
  const at = absolute(t, now);
  if ("error" in at) return at;
  if (at.at <= now + 30_000) return { error: "That time has passed." };
  return { rule: { kind: "once", at: at.at } };
}

/** The first run strictly after `after`, or null when there is none. */
export function nextRun(rule: ScheduleRule, after: number): number | null {
  switch (rule.kind) {
    case "once":
      return rule.at > after ? rule.at : null;
    case "merge":
      // Not a time: the scheduler watches the PR.
      return null;
    case "every": {
      const step = rule.minutes * MIN;
      if (after < rule.from) return rule.from;
      return rule.from + (Math.floor((after - rule.from) / step) + 1) * step;
    }
    case "weekly": {
      if (!rule.days.length) return null;
      const d = new Date(after);
      for (let i = 0; i <= 7; i++) {
        const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, Math.floor(rule.minute / 60), rule.minute % 60, 0, 0);
        if (rule.days.includes(c.getDay()) && c.getTime() > after) return c.getTime();
      }
      return null;
    }
  }
}

/** The rule in words: "Every weekday at 9:00 AM", "Tomorrow at 7:30 PM". */
export function describeRule(rule: ScheduleRule, now: number = Date.now()): string {
  switch (rule.kind) {
    case "once":
      return describeAt(rule.at, now);
    case "merge":
      return `When ${rule.repo ? `${rule.repo}#` : "PR #"}${rule.pr} merges`;
    case "every":
      if (rule.minutes % (24 * 60) === 0) return rule.minutes === 24 * 60 ? "Every day" : `Every ${rule.minutes / (24 * 60)} days`;
      if (rule.minutes % 60 === 0) return rule.minutes === 60 ? "Every hour" : `Every ${rule.minutes / 60} hours`;
      return `Every ${rule.minutes} minutes`;
    case "weekly": {
      const days = [...rule.days].sort();
      const time = clock(rule.minute);
      if (days.length === 7) return `Every day at ${time}`;
      if (days.join() === "1,2,3,4,5") return `Every weekday at ${time}`;
      if (days.join() === "0,6") return `Weekends at ${time}`;
      const names = days.map((d) => DAY_SHORT[d]!);
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      return `Every ${list} at ${time}`;
    }
  }
}

/** A moment in words, near ones by name: "Today at 4:00 PM", "Fri, Oct 3 at 9:00 AM". */
export function describeAt(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(at) - startOfDay(now)) / (24 * 60 * MIN));
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  const date = d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date} at ${time}`;
}

/** "in 4h", "in 12m", "in 2d"; "due" once it has come. */
export function until(at: number, now: number = Date.now()): string {
  const s = (at - now) / 1000;
  if (s <= 30) return "due";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  if (s < 84_600) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86_400)}d`;
}

// ---------------------------------------------------------------- helpers

/** "when PR 6644 merges", "once #6644 is merged", "after owner/repo#12 lands", "on merge of 6644". */
function mergeOf(t: string): ScheduleRule | null {
  const ref = String.raw`(?:(?:the )?(?:pr|pull request|pull) ?#?|#)?(?:([\w.-]+\/[\w.-]+)#)?(\d+)`;
  const m =
    new RegExp(String.raw`^(?:when|once|after|as soon as) ${ref} (?:is |gets |has |has been )?(?:merges|merged|merge|lands|landed|is in)$`).exec(t) ??
    new RegExp(String.raw`^(?:on|after) (?:the )?merge of ${ref}$`).exec(t);
  if (!m) return null;
  return { kind: "merge", pr: Number(m[2]), repo: m[1] ?? null };
}

function recurring(t: string, now: number): ParsedWhen {
  // Every N minutes / hours / days.
  const n = /^(?:(\d+|an?|other|half an?) )?(minutes?|mins?|m|hours?|hrs?|h|days?|d)$/.exec(t);
  if (n || t === "hourly") {
    const unit = t === "hourly" ? "h" : n![2]!;
    const count = !n?.[1] || /^an?$/.test(n[1]) ? 1 : n[1] === "other" ? 2 : /^half/.test(n[1]) ? 0.5 : Number(n[1]);
    const minutes = Math.round(count * (unit.startsWith("m") ? 1 : unit.startsWith("h") ? 60 : 24 * 60));
    if (minutes < MIN_EVERY) return { error: `Not more often than every ${MIN_EVERY} minutes.` };
    // A whole number of days is a time of day: every day at this time.
    if (minutes % (24 * 60) === 0 && minutes === 24 * 60) {
      const d = new Date(now);
      return { rule: { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], minute: d.getHours() * 60 + d.getMinutes() } };
    }
    return { rule: { kind: "every", minutes, from: now } };
  }
  if (t === "half hour") return { rule: { kind: "every", minutes: 30, from: now } };

  // The days, then an optional time.
  const m = /^(.*?)(?: (?:at|@) (.+)| (\d{1,2}(?::\d{2})? ?(?:am|pm|a|p)?|noon|midnight))?$/.exec(t);
  let dayPart = m?.[1] ?? t;
  let timeText = m?.[2] ?? m?.[3] ?? null;
  let minute: number | null = null;
  // "every morning", "every weekday evening".
  const part = / ?(morning|afternoon|evening|night)$/.exec(dayPart);
  if (part) {
    dayPart = dayPart.slice(0, part.index).trim() || "day";
    minute = PARTS[part[1]!]!;
  }
  if (timeText) {
    minute = parseTime(timeText, part ? part[1]! : null);
    if (minute === null) return { error: `Could not read “${timeText}” as a time of day.` };
  }
  const days = parseDays(dayPart);
  if (!days) return { error: `Could not read “${dayPart}”. Try “every day at 9am”, “every weekday at 8:30”, “every Monday and Thursday at 5pm” or “every 2 hours”.` };
  return { rule: { kind: "weekly", days, minute: minute ?? 9 * 60 } };
}

function parseDays(s: string): number[] | null {
  s = s.replace(/^weekly on /, "").replace(/^on /, "").trim();
  if (/^(day|daily|nightly|night|single day|day of the week)$/.test(s) || s === "") return [0, 1, 2, 3, 4, 5, 6];
  if (/^(weekday|weekdays|work ?day|work ?days|business day|business days)$/.test(s)) return [1, 2, 3, 4, 5];
  if (/^(weekend|weekends|weekend day|weekend days)$/.test(s)) return [0, 6];
  const out = new Set<number>();
  for (const w of s.split(/ and | & | |\/|\+/)) {
    if (!w || w === "and") continue;
    const d = dayOf(w);
    if (d === null) return null;
    out.add(d);
  }
  return out.size ? [...out].sort() : null;
}

function dayOf(w: string): number | null {
  w = w.replace(/s$/, "");
  if (w.length < 2) return null;
  const i = DAY_NAMES.findIndex((d) => d.startsWith(w));
  return i === -1 ? null : i;
}

/** "4 hours", "1h30m", "an hour and a half", "90 min", "2 days". */
function duration(s: string): number | null {
  s = s.replace(/ and a half$/, " +half").replace(/^half an? /, "0.5 ").replace(/^an? /, "1 ").trim();
  const re = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wk|w)(?![a-z])|\+half/g;
  let total = 0;
  let last = 0;
  let consumed = "";
  for (let r = re.exec(s); r; r = re.exec(s)) {
    consumed += r[0];
    if (r[0] === "+half") {
      total += last / 2;
      continue;
    }
    const u = r[2]!;
    const unit = /^s/.test(u) ? 1000 : /^m/.test(u) ? MIN : /^h/.test(u) ? 60 * MIN : /^d/.test(u) ? 24 * 60 * MIN : 7 * 24 * 60 * MIN;
    last = Number(r[1]) * unit;
    total += last;
  }
  // Everything must have been read: "4 hours give or take" is not 4 hours.
  if (!consumed || s.replace(re, "").replace(/\band\b/g, "").trim()) return null;
  return total;
}

/** "9am", "9:30 pm", "21:00", "noon"; a bare 1–7 is afternoon. Minutes past midnight. */
function parseTime(s: string, part: string | null = null): number | null {
  s = s.trim().replace(/\./g, "");
  if (s === "noon" || s === "midday") return 12 * 60;
  if (s === "midnight") return 0;
  const m = /^(\d{1,2})(?::?(\d{2}))? ?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  const ap = m[3]?.[0];
  if (ap) {
    if (h > 12 || h === 0) return null;
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
  } else if (h >= 1 && h <= 11 && (part === "afternoon" || part === "evening" || part === "night" || part === "tonight" || (part === null && h <= 7))) {
    // Nobody schedules work for 5 in the morning by saying "5".
    h += 12;
  }
  return h * 60 + min;
}

/** "tomorrow at 9am", "friday 5pm", "sep 30", "9/30 14:00", "at noon", "tonight". */
function absolute(t: string, now: number): { at: number } | { error: string } {
  const today = new Date(now);
  // Split off the time: " at X", or a trailing time-looking word.
  let dayPart = t;
  let timeText: string | null = null;
  const at = /^(.*?) ?(?:\bat\b|@) ?(.+)$/.exec(t);
  if (at) {
    dayPart = at[1]!.trim();
    timeText = at[2]!.trim();
  } else {
    const tail = /^(.*?) ?(\d{1,2}(?::\d{2})? ?(?:am|pm|a|p)|\d{1,2}:\d{2}|noon|midnight)$/.exec(t);
    if (tail) {
      dayPart = tail[1]!.trim();
      timeText = tail[2]!;
    } else if (/^\d{1,2}$/.test(t)) {
      dayPart = "";
      timeText = t;
    }
  }
  let part: string | null = null;
  const p = /^(.*?) ?(?:this )?(morning|afternoon|evening|night|tonight)$/.exec(dayPart);
  if (p) {
    part = p[2]!;
    dayPart = p[1]!.trim() || (part === "tonight" ? "today" : "");
  }
  let minute: number | null = null;
  if (timeText) {
    minute = parseTime(timeText, part);
    if (minute === null) return { error: `Could not read “${timeText}” as a time of day.` };
  } else if (part) minute = PARTS[part]!;

  const time = minute ?? 9 * 60;
  const on = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(time / 60), time % 60, 0, 0).getTime();
  const plusDays = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);

  if (dayPart === "" || dayPart === "today") {
    if (minute === null) return { error: `Could not read “${t}”. Try “in 4 hours”, “tomorrow at 9am”, “friday 5pm” or “every day at 9am”.` };
    const c = on(today);
    // A bare time already past today means tomorrow's.
    return { at: c > now || dayPart === "today" ? c : on(plusDays(1)) };
  }
  if (dayPart === "tomorrow" || dayPart === "tmrw" || dayPart === "tmr") return { at: on(plusDays(1)) };
  if (dayPart === "day after tomorrow") return { at: on(plusDays(2)) };

  const wd = /^(next |this |on )?([a-z]+)$/.exec(dayPart);
  const d = wd ? dayOf(wd[2]!) : null;
  if (wd && d !== null) {
    let ahead = (d - today.getDay() + 7) % 7;
    if (ahead === 0 && (wd[1] === "next " || on(today) <= now)) ahead = 7;
    return { at: on(plusDays(ahead)) };
  }

  const date = parseDate(dayPart, today);
  if (date) {
    let c = on(date);
    if (c <= now && !/\d{4}/.test(dayPart)) c = on(new Date(date.getFullYear() + 1, date.getMonth(), date.getDate()));
    return { at: c };
  }
  return { error: `Could not read “${t}”. Try “in 4 hours”, “tomorrow at 9am”, “friday 5pm” or “every day at 9am”.` };
}

/** "sep 30", "30 september", "9/30", "2026-09-30". */
function parseDate(s: string, today: Date): Date | null {
  // "Fri, Oct 2" — the weekday is what describeAt adds, and says nothing more.
  s = s.replace(/^on /, "").replace(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]* (?=[a-z]+ \d|\d)/, "").replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (m) return valid(m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : today.getFullYear(), Number(m[1]) - 1, Number(m[2]));
  m = /^([a-z]+) (\d{1,2})(?: (\d{4}))?$/.exec(s);
  if (m && month(m[1]!) !== null) return valid(m[3] ? Number(m[3]) : today.getFullYear(), month(m[1]!)!, Number(m[2]));
  m = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(s);
  if (m && month(m[2]!) !== null) return valid(m[3] ? Number(m[3]) : today.getFullYear(), month(m[2]!)!, Number(m[1]));
  return null;
}

function month(w: string): number | null {
  if (w.length < 3) return null;
  const i = MONTHS.indexOf(w.slice(0, 3));
  return i === -1 ? null : i;
}

function valid(y: number, mo: number, d: number): Date | null {
  const date = new Date(y, mo, d);
  return date.getMonth() === mo && date.getDate() === d ? date : null;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function clock(minute: number): string {
  return new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
