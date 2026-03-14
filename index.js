import fs from "fs";

const API_KEY = process.env.TUMBLR_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const TAGS = (process.env.TAGS || "")
  .split(",")
  .map(tag => tag.trim())
  .filter(Boolean);

const DELAY_MS = Number(process.env.DELAY_MS || 2000);
const STATE_FILE = "state.json";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      last_run_timestamp: 0,
      seen_post_ids: []
    };
  }

  const raw = fs.readFileSync(STATE_FILE, "utf8");
  const parsed = JSON.parse(raw);

  return {
    last_run_timestamp: Number(parsed.last_run_timestamp || 0),
    seen_post_ids: parsed.seen_post_ids || []
  };
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2),
    "utf8"
  );
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
    throw new Error(`Tumblr API error for tag "${tag}": ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.response || [];
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
    throw new Error(`Discord webhook error: ${response.status} ${text}`);
  }
}

function dedupePosts(posts) {
  const map = new Map();

  for (const post of posts) {
    if (!post?.id_string || !post?.timestamp) continue;

    map.set(post.id_string, post);
  }

  return Array.from(map.values());
}

function filterNewPosts(posts, lastRunTimestamp, seenIds) {
  const seenSet = new Set(seenIds);

  return posts.filter(post =>
    Number(post.timestamp) > lastRunTimestamp &&
    !seenSet.has(post.id_string)
  );
}

function sortOldestFirst(posts) {
  return posts.sort((a, b) => a.timestamp - b.timestamp);
}

async function main() {

  if (!API_KEY) throw new Error("Missing TUMBLR_API_KEY");
  if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");
  if (TAGS.length === 0) throw new Error("Missing TAGS");

  const state = loadState();
  const nowTimestamp = Math.floor(Date.now() / 1000);

  console.log("Starting run");
  console.log("Tags:", TAGS);
  console.log("Last run:", state.last_run_timestamp);

  let allPosts = [];

  for (const tag of TAGS) {

    console.log(`Fetching tag: ${tag}`);

    const posts = await fetchTagPosts(tag);

    console.log(`Fetched ${posts.length}`);

    allPosts = allPosts.concat(posts);
  }

  const deduped = dedupePosts(allPosts);

  const newPosts = filterNewPosts(
    deduped,
    state.last_run_timestamp,
    state.seen_post_ids
  );

  const postsToSend = sortOldestFirst(newPosts);

  console.log("Total fetched:", allPosts.length);
  console.log("Deduped:", deduped.length);
  console.log("To send:", postsToSend.length);

  const isFirstRun = state.last_run_timestamp === 0;

  if (isFirstRun) {

    console.log("First run: initializing state");

    const seen = new Set(state.seen_post_ids);

    for (const p of deduped) {
      seen.add(p.id_string);
    }

    saveState({
      last_run_timestamp: nowTimestamp,
      seen_post_ids: Array.from(seen)
    });

    return;
  }

  let sent = 0;

  for (const post of postsToSend) {

    console.log("Sending:", post.post_url);

    await sendToDiscord(post);

    state.seen_post_ids.push(post.id_string);

    sent++;

    if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  saveState({
    last_run_timestamp: nowTimestamp,
    seen_post_ids: state.seen_post_ids
  });

  console.log("Done. Sent:", sent);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
