import fs from "fs";
import { chromium } from "playwright";

const API_KEY = process.env.TUMBLR_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TAGS = (process.env.TAGS || "")
  .split(",")
  .map((tag) => tag.trim())
  .filter(Boolean);

const DELAY_MS = Number(process.env.DELAY_MS || 2000);
const STATE_FILE = "state.json";

// nuevo: activar prueba web sin romper el flujo actual
const ENABLE_WEB_CAPTURE = String(process.env.ENABLE_WEB_CAPTURE || "false").toLowerCase() === "true";
const WEB_CAPTURE_TIMEOUT_MS = Number(process.env.WEB_CAPTURE_TIMEOUT_MS || 30000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeState(parsed) {
  return {
    last_timestamp: Number(parsed?.last_timestamp || 0),
    last_id: String(parsed?.last_id || "0")
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { last_timestamp: 0, last_id: "0" };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    console.warn("Could not read state.json, using default state.", error);
    return { last_timestamp: 0, last_id: "0" };
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        last_timestamp: Number(state.last_timestamp || 0),
        last_id: String(state.last_id || "0")
      },
      null,
      2
    ),
    "utf8"
  );
}

function comparePostOrder(a, b) {
  const aTimestamp = Number(a.timestamp || 0);
  const bTimestamp = Number(b.timestamp || 0);

  if (aTimestamp !== bTimestamp) {
    return aTimestamp - bTimestamp;
  }

  const aId = BigInt(a.id_string);
  const bId = BigInt(b.id_string);

  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

function isAfterState(post, state) {
  const postTimestamp = Number(post.timestamp || 0);
  const stateTimestamp = Number(state.last_timestamp || 0);

  if (postTimestamp > stateTimestamp) {
    return true;
  }

  if (postTimestamp < stateTimestamp) {
    return false;
  }

  return BigInt(post.id_string) > BigInt(state.last_id || "0");
}

function dedupePosts(posts) {
  const byId = new Map();

  for (const post of posts) {
    if (!post?.id_string || !post?.post_url || !post?.timestamp) {
      continue;
    }

    byId.set(post.id_string, post);
  }

  return Array.from(byId.values());
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

/* =========================
   NUEVO: captura web Tumblr
   ========================= */

function findTimelineItems(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload?.response?.timeline?.elements)) {
    return payload.response.timeline.elements;
  }

  if (Array.isArray(payload?.response?.timeline?.items)) {
    return payload.response.timeline.items;
  }

  if (Array.isArray(payload?.response?.items)) {
    return payload.response.items;
  }

  if (Array.isArray(payload?.response)) {
    return payload.response;
  }

  if (Array.isArray(payload?.timeline?.elements)) {
    return payload.timeline.elements;
  }

  if (Array.isArray(payload?.timeline?.items)) {
    return payload.timeline.items;
  }

  return [];
}

function normalizeWebTags(item) {
  const raw =
    item?.tags ??
    item?.post?.tags ??
    item?.content?.tags ??
    item?.trail?.flatMap((entry) => entry?.tags || []) ??
    [];

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((tag) => {
      if (typeof tag === "string") return tag;
      if (tag && typeof tag === "object") {
        return tag.name ?? tag.tag ?? null;
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeWebPost(item) {
  const id =
    item?.id ??
    item?.id_string ??
    item?.post?.id ??
    item?.post?.id_string ??
    item?.post_id ??
    null;

  const timestamp =
    item?.timestamp ??
    item?.post?.timestamp ??
    item?.published_timestamp ??
    item?.date ??
    null;

  const url =
    item?.post_url ??
    item?.url ??
    item?.post?.post_url ??
    item?.post?.url ??
    item?.share_url ??
    null;

  const blog_name =
    item?.blog_name ??
    item?.blog?.name ??
    item?.post?.blog_name ??
    item?.post?.blog?.name ??
    item?.account?.name ??
    null;

  if (!id || !timestamp || !url || !blog_name) {
    return null;
  }

  return {
    id: String(id),
    timestamp: Number(timestamp),
    url,
    blog_name,
    tags: normalizeWebTags(item)
  };
}

function sortWebPosts(posts) {
  return posts.sort((a, b) => {
    if (b.timestamp !== a.timestamp) {
      return b.timestamp - a.timestamp;
    }

    const aId = BigInt(a.id);
    const bId = BigInt(b.id);

    if (bId > aId) return 1;
    if (bId < aId) return -1;
    return 0;
  });
}

function dedupeWebPosts(posts) {
  const byId = new Map();

  for (const post of posts) {
    if (!post?.id || !post?.url || !post?.timestamp) {
      continue;
    }

    byId.set(post.id, post);
  }

  return Array.from(byId.values());
}

async function captureWebTimelineForTag(tag) {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();
  const searchUrl = `https://www.tumblr.com/search/${encodeURIComponent(tag)}/recent`;

  try {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes("/api/v2/timeline/search") &&
        response.url().includes(`query=${encodeURIComponent(tag)}`),
      { timeout: WEB_CAPTURE_TIMEOUT_MS }
    );

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: WEB_CAPTURE_TIMEOUT_MS
    });

    const response = await responsePromise;
    const json = await response.json();

    const items = findTimelineItems(json);
    const normalized = items.map(normalizeWebPost).filter(Boolean);
    const deduped = dedupeWebPosts(normalized);
    const sorted = sortWebPosts(deduped);

    return sorted;
  } finally {
    await browser.close();
  }
}

async function logWebCaptureForTags(tags) {
  console.log("Web capture enabled. Capturing Tumblr web timeline...");

  for (const tag of tags) {
    try {
      console.log(`Capturing web timeline for tag: ${tag}`);
      const posts = await captureWebTimelineForTag(tag);

      console.log(`Web timeline posts for "${tag}" (${posts.length}):`);
      console.log(JSON.stringify(posts, null, 2));
    } catch (error) {
      console.error(`Web capture failed for tag "${tag}":`, error.message);
    }
  }
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

  console.log("Starting run");
  console.log("Tags:", TAGS);
  console.log("Last state:", state);

  // nuevo: prueba extra, no afecta el flujo viejo
  if (ENABLE_WEB_CAPTURE) {
    await logWebCaptureForTags(TAGS);
  }

  let allPosts = [];

  for (const tag of TAGS) {
    console.log(`Fetching tag: ${tag}`);
    const posts = await fetchTagPosts(tag);
    console.log(`Fetched ${posts.length}`);
    allPosts = allPosts.concat(posts);
  }

  const dedupedPosts = dedupePosts(allPosts);
  const sortedPosts = dedupedPosts.sort(comparePostOrder);
  const postsToSend = sortedPosts.filter((post) => isAfterState(post, state));

  console.log("Total fetched:", allPosts.length);
  console.log("Deduped:", dedupedPosts.length);
  console.log("To send:", postsToSend.length);

  const isFirstRun = state.last_timestamp === 0 && state.last_id === "0";

  if (isFirstRun) {
    console.log("First run: initializing state without posting.");
    const lastPost = sortedPosts.at(-1);

    if (!lastPost) {
      console.log("No posts found. Saving empty initial state.");
      saveState({ last_timestamp: 0, last_id: "0" });
      return;
    }

    saveState({
      last_timestamp: Number(lastPost.timestamp),
      last_id: String(lastPost.id_string)
    });

    console.log(
      `Initialized state with last_timestamp=${lastPost.timestamp}, last_id=${lastPost.id_string}`
    );
    return;
  }

  let sentCount = 0;
  let latestProcessedPost = null;

  for (const post of postsToSend) {
    console.log(`Sending: ${post.post_url}`);
    await sendToDiscord(post);
    sentCount++;
    latestProcessedPost = post;

    if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  if (latestProcessedPost) {
    saveState({
      last_timestamp: Number(latestProcessedPost.timestamp),
      last_id: String(latestProcessedPost.id_string)
    });
  } else {
    console.log("No new posts. State unchanged.");
  }

  console.log(`Done. Sent: ${sentCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
