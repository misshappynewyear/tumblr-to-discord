import fs from "fs";
import fetch from "node-fetch";

const API_KEY = process.env.TUMBLR_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TAGS = (process.env.TAGS || "")
  .split(",")
  .map((tag) => tag.trim())
  .filter(Boolean);

const DELAY_MS = Number(process.env.DELAY_MS || 2000);
const FRESHNESS_HOURS = Number(process.env.FRESHNESS_HOURS || 48);
const RECENT_IDS_LIMIT = Number(process.env.RECENT_IDS_LIMIT || 200);
const STATE_FILE = "state.json";

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
    (post) => !seenIds.has(String(post.id_string))
  );

  console.log("Total fetched:", allPosts.length);
  console.log("Deduped:", dedupedPosts.length);
  console.log("Fresh posts:", freshPosts.length);
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

  console.log("Saved recent posts:", nextState.recent_posts.length);
  console.log(`Done. Sent: ${sentCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
