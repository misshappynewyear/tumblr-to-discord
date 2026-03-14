import fs from "fs";

const API_KEY = process.env.TUMBLR_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const TAGS = (process.env.TAGS || "")
  .split(",")
  .map((tag) => tag.trim())
  .filter(Boolean);

const DELAY_MS = Number(process.env.DELAY_MS || 2000);
const STATE_FILE = "state.json";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      last_run_timestamp: 0,
      seen_post_ids: []
    };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      last_run_timestamp: Number(parsed.last_run_timestamp || 0),
      seen_post_ids: Array.isArray(parsed.seen_post_ids) ? parsed.seen_post_ids : []
    };
  } catch (error) {
    console.warn("Could not read state.json, using default state.", error);
    return {
      last_run_timestamp: 0,
      seen_post_ids: []
    };
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2),
    "utf8"
  );
}

async function fetchTagPosts(tag) {
  const url = `https://api.tumblr.com/v2/tagged?tag=${encodeURIComponent(tag)}&api_key=${API_KEY}`;

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
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: post.post_url
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook error: ${response.status} - ${text}`);
  }
}

function dedupePosts(posts) {
  const byId = new Map();

  for (const post of posts) {
    if (!post?.id_string || !post?.post_url || !post?.timestamp) {
      continue;
    }

    if (!byId.has(post.id_string)) {
      byId.set(post.id_string, post);
      continue;
    }

    const existing = byId.get(post.id_string);

    if ((post.timestamp || 0) > (existing.timestamp || 0)) {
      byId.set(post.id_string, post);
    }
  }

  return Array.from(byId.values());
}

function keepOnlyNewerThan(posts, lastRunTimestamp) {
  return posts.filter((post) => Number(post.timestamp) > Number(lastRunTimestamp));
}

function keepOnlyUnseen(posts, seenPostIdsSet) {
  return posts.filter((post) => !seenPostIdsSet.has(post.id_string));
}

function sortOldestFirst(posts) {
  return [...posts].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
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

  const nowTimestamp = Math.floor(Date.now() / 1000);
  const state = loadState();
  const seenPostIdsSet = new Set(state.seen_post_ids);

  console.log("Starting run...");
  console.log("Tags:", TAGS);
  console.log("Last run timestamp:", state.last_run_timestamp);

  let allPosts = [];

  for (const tag of TAGS) {
    console.log(`Fetching tag: ${tag}`);
    const posts = await fetchTagPosts(tag);
    console.log(`Fetched ${posts.length} posts for tag: ${tag}`);
    allPosts = allPosts.concat(posts);
  }

  const dedupedPosts = dedupePosts(allPosts);
  const newerPosts = keepOnlyNewerThan(dedupedPosts, state.last_run_timestamp);
  const unseenPosts = keepOnlyUnseen(newerPosts, seenPostIdsSet);
  const postsToSend = sortOldestFirst(unseenPosts);

  console.log(`Total fetched: ${allPosts.length}`);
  console.log(`Deduped: ${dedupedPosts.length}`);
  console.log(`Newer than last run: ${newerPosts.length}`);
  console.log(`Unseen: ${unseenPosts.length}`);

  const isFirstRun = state.last_run_timestamp === 0;

  if (isFirstRun) {
    console.log("First run detected. Initializing state without posting.");

    const newSeenIds = new Set(seenPostIdsSet);
    for (const post of dedupedPosts) {
      newSeenIds.add(post.id_string);
    }

    saveState({
      last_run_timestamp: nowTimestamp,
      seen_post_ids: Array.from(newSeenIds)
    });

    console.log(`Initialized state with ${newSeenIds.size} seen posts.`);
    return;
  }

  let sentCount = 0;

  for (const post of postsToSend) {
    console.log(`Sending post ${post.id_string}: ${post.post_url}`);
    await sendToDiscord(post);
    seenPostIdsSet.add(post.id_string);
    sentCount++;

    if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  saveState({
    last_run_timestamp: nowTimestamp,
    seen_post_ids: Array.from(seenPostIdsSet)
  });

  console.log(`Done. Sent ${sentCount} new posts.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
