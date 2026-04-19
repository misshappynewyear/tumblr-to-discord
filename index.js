import fs from "fs";
import fetch from "node-fetch";

const API_KEY = process.env.TUMBLR_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const COBY_WEBHOOK_URL = process.env.COBY_WEBHOOK_URL;
const TAGS = (process.env.TAGS || "")
  .split(",")
  .map((tag) => tag.trim())
  .filter(Boolean);
const EXCLUDED_TUMBLR_USERS = (
  process.env.EXCLUDED_TUMBLR_USERS || process.env.EXCLUDED_TUMBLR_USER || ""
)
  .split(",")
  .map((user) => user.trim().replace(/^@/, "").toLowerCase())
  .filter(Boolean);

const DELAY_MS = Number(process.env.DELAY_MS || 2000);
const FRESHNESS_HOURS = Number(process.env.FRESHNESS_HOURS || 48);
const RECENT_IDS_LIMIT = Number(process.env.RECENT_IDS_LIMIT || 200);
const STATE_FILE = "state.json";
const RUN_STATUS_FILE = "run_status.json";
const GITHUB_RUN_ID = String(process.env.GITHUB_RUN_ID || "").trim();
const GITHUB_RUN_ATTEMPT = Number(process.env.GITHUB_RUN_ATTEMPT || 0);
const FAILURE_ALERT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreshnessCutoffSeconds() {
  return Math.floor(Date.now() / 1000) - FRESHNESS_HOURS * 60 * 60;
}

function normalizeState(parsed) {
  const recent_posts = Array.isArray(parsed?.recent_posts)
    ? parsed.recent_posts
        .map((item) => ({
          id: String(item?.id || ""),
          timestamp: Number(item?.timestamp || 0),
        }))
        .filter((item) => item.id && item.timestamp > 0)
    : [];

  return { recent_posts };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { recent_posts: [] };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    console.warn("Could not read state.json, using default state.", error);
    return { recent_posts: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        recent_posts: state.recent_posts,
      },
      null,
      2
    ),
    "utf8"
  );
}

function saveRunStatus(status) {
  fs.writeFileSync(
    RUN_STATUS_FILE,
    JSON.stringify(status, null, 2),
    "utf8"
  );
}

function loadRunStatus() {
  if (!fs.existsSync(RUN_STATUS_FILE)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(RUN_STATUS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch (error) {
    console.warn("Could not read run_status.json, using default run status.", error);
    return null;
  }
}

function comparePostOrderAsc(a, b) {
  const aTimestamp = Number(a.timestamp || 0);
  const bTimestamp = Number(b.timestamp || 0);

  if (aTimestamp !== bTimestamp) {
    return aTimestamp - bTimestamp;
  }

  const aId = BigInt(String(a.id_string));
  const bId = BigInt(String(b.id_string));

  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

function dedupePosts(posts) {
  const byId = new Map();

  for (const post of posts) {
    if (!post?.id_string || !post?.post_url || !post?.timestamp) {
      continue;
    }

    byId.set(String(post.id_string), post);
  }

  return Array.from(byId.values());
}

function isFreshPost(post, cutoffSeconds) {
  return Number(post.timestamp || 0) >= cutoffSeconds;
}

function getPostBlogName(post) {
  return String(post?.blog_name || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function isExcludedPost(post) {
  const blogName = getPostBlogName(post);
  return blogName ? EXCLUDED_TUMBLR_USERS.includes(blogName) : false;
}

async function fetchTagPosts(tag) {
  const url =
    `https://api.tumblr.com/v2/tagged` +
    `?tag=${encodeURIComponent(tag)}` +
    `&limit=20` +
    `&api_key=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tumblr API error for tag "${tag}": ${response.status} - ${text}`);
  }

  const data = await response.json();

  if (!data?.response || !Array.isArray(data.response)) {
    return [];
  }

  return data.response;
}

async function sendToDiscord(post) {
  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: post.post_url,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook error: ${response.status} - ${text}`);
  }
}

async function sendCobyAlert(content) {
  if (!COBY_WEBHOOK_URL) {
    console.warn("Missing COBY_WEBHOOK_URL. Skipping Coby alert.");
    return;
  }

  const response = await fetch(COBY_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Coby webhook error: ${response.status} - ${text}`);
  }
}

function buildTumblrContinuousFailureAlert(errorMessage, startedAtIso) {
  const startedAt = String(startedAtIso || "").trim() || "an unknown time";
  const safeError = String(errorMessage || "Unknown error").trim() || "Unknown error";

  return [
    "Captains! The Tumblr to Discord service has been failing for over 24 hours now...",
    `It started failing around: ${startedAt}`,
    "It says:",
    `> ${safeError}`,
    "Well... I don't really know what that means, Captain... but it doesn't look good.",
    "You might want to check the workflow logs... because this doesn't feel like one of those errors that quietly fixes itself..."
  ].join("\n");
}

function buildFailureRunStatus(previousRunStatus, error) {
  const nowIso = new Date().toISOString();
  const previousFailed = previousRunStatus?.success === false;
  const failureStreakStartedAt = previousFailed && previousRunStatus?.failureStreakStartedAt
    ? String(previousRunStatus.failureStreakStartedAt)
    : nowIso;
  const failureAlertedAt = previousFailed && previousRunStatus?.failureAlertedAt
    ? String(previousRunStatus.failureAlertedAt)
    : "";

  return {
    runId: GITHUB_RUN_ID,
    runAttempt: GITHUB_RUN_ATTEMPT,
    finishedAt: nowIso,
    success: false,
    postedSomething: false,
    sentCount: 0,
    tags: TAGS,
    excludedUsers: EXCLUDED_TUMBLR_USERS,
    freshnessHours: FRESHNESS_HOURS,
    error: String(error?.message || error),
    failureStreakStartedAt,
    failureAlertedAt
  };
}

async function maybeAlertContinuousFailure(runStatus) {
  const startedAtValue = String(runStatus?.failureStreakStartedAt || "").trim();
  const alertedAtValue = String(runStatus?.failureAlertedAt || "").trim();

  if (!startedAtValue || alertedAtValue) {
    return runStatus;
  }

  const startedAtMs = Date.parse(startedAtValue);
  if (!Number.isFinite(startedAtMs)) {
    return runStatus;
  }

  const durationMs = Date.now() - startedAtMs;
  if (durationMs < FAILURE_ALERT_THRESHOLD_MS) {
    return runStatus;
  }

  await sendCobyAlert(
    buildTumblrContinuousFailureAlert(runStatus.error, runStatus.failureStreakStartedAt)
  );

  return {
    ...runStatus,
    failureAlertedAt: new Date().toISOString()
  };
}

function buildSeenIdsSet(state, cutoffSeconds) {
  const freshSaved = state.recent_posts.filter(
    (item) => Number(item.timestamp || 0) >= cutoffSeconds
  );

  return new Set(freshSaved.map((item) => String(item.id)));
}

function buildNextState(savedState, fetchedFreshPosts, cutoffSeconds) {
  const merged = new Map();

  for (const item of savedState.recent_posts) {
    if (Number(item.timestamp || 0) >= cutoffSeconds && item.id) {
      merged.set(String(item.id), {
        id: String(item.id),
        timestamp: Number(item.timestamp),
      });
    }
  }

  for (const post of fetchedFreshPosts) {
    merged.set(String(post.id_string), {
      id: String(post.id_string),
      timestamp: Number(post.timestamp),
    });
  }

  const recent_posts = Array.from(merged.values())
    .sort((a, b) => {
      if (b.timestamp !== a.timestamp) {
        return b.timestamp - a.timestamp;
      }

      const aId = BigInt(a.id);
      const bId = BigInt(b.id);

      if (bId > aId) return 1;
      if (bId < aId) return -1;
      return 0;
    })
    .slice(0, RECENT_IDS_LIMIT);

  return { recent_posts };
}

async function main() {
  if (!API_KEY) {
    throw new Error("Missing TUMBLR_API_KEY");
  }

  if (!DISCORD_WEBHOOK_URL) {
    throw new Error("Missing DISCORD_WEBHOOK_URL");
  }

  if (TAGS.length === 0) {
    throw new Error("Missing TAGS");
  }

  const state = loadState();
  const cutoffSeconds = getFreshnessCutoffSeconds();

  console.log("Starting run");
  console.log("Tags:", TAGS);
  console.log("Excluded Tumblr users:", EXCLUDED_TUMBLR_USERS);
  console.log("Freshness hours:", FRESHNESS_HOURS);
  console.log("Freshness cutoff:", cutoffSeconds);
  console.log("Saved recent posts:", state.recent_posts.length);

  let allPosts = [];

  for (const tag of TAGS) {
    console.log(`Fetching tag: ${tag}`);
    const posts = await fetchTagPosts(tag);
    console.log(`Fetched ${posts.length}`);
    allPosts = allPosts.concat(posts);
  }

  const dedupedPosts = dedupePosts(allPosts);
  const freshPosts = dedupedPosts
    .filter((post) => isFreshPost(post, cutoffSeconds))
    .sort(comparePostOrderAsc);
  const excludedFreshPosts = freshPosts.filter(isExcludedPost);

  const seenIds = buildSeenIdsSet(state, cutoffSeconds);

  console.log("Seen IDs count:", seenIds.size);

  if (dedupedPosts.length > 0) {
    const newestSeen = [...dedupedPosts].sort(comparePostOrderAsc).at(-1);
    console.log("Newest Tumblr post returned this run:", {
      id: newestSeen.id_string,
      timestamp: newestSeen.timestamp,
      url: newestSeen.post_url
    });
  }

  const postsToSend = freshPosts.filter(
    (post) =>
      !seenIds.has(String(post.id_string)) &&
      !isExcludedPost(post)
  );

  console.log("Total fetched:", allPosts.length);
  console.log("Deduped:", dedupedPosts.length);
  console.log("Fresh posts:", freshPosts.length);
  console.log("Excluded fresh posts:", excludedFreshPosts.length);
  console.log("To send:", postsToSend.length);

  let sentCount = 0;

  for (const post of postsToSend) {
    console.log("About to send post:", {
      id: post.id_string,
      timestamp: post.timestamp,
      url: post.post_url
    });

    await sendToDiscord(post);
    sentCount++;

    if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  const nextState = buildNextState(state, freshPosts, cutoffSeconds);
  saveState(nextState);

  saveRunStatus({
    runId: GITHUB_RUN_ID,
    runAttempt: GITHUB_RUN_ATTEMPT,
    finishedAt: new Date().toISOString(),
    success: true,
    postedSomething: sentCount > 0,
    sentCount,
    totalFetched: allPosts.length,
    dedupedCount: dedupedPosts.length,
    freshCount: freshPosts.length,
    excludedFreshCount: excludedFreshPosts.length,
    tags: TAGS,
    excludedUsers: EXCLUDED_TUMBLR_USERS,
    freshnessHours: FRESHNESS_HOURS,
    failureStreakStartedAt: "",
    failureAlertedAt: ""
  });

  console.log("Saved recent posts:", nextState.recent_posts.length);
  console.log(`Done. Sent: ${sentCount}`);
}

main().catch(async (error) => {
  const previousRunStatus = loadRunStatus();
  const failedRunStatus = buildFailureRunStatus(previousRunStatus, error);

  try {
    const finalRunStatus = await maybeAlertContinuousFailure(failedRunStatus);
    saveRunStatus(finalRunStatus);
  } catch (alertError) {
    console.error("Failed sending Tumblr continuous failure alert", alertError);
    saveRunStatus(failedRunStatus);
  }

  console.error(error);
  process.exit(1);
});
