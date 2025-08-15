// scrape2.js
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as readline from "readline";

// helper to prompt user if no CLI arg
function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(query, ans => { rl.close(); resolve(ans.trim()); })
  );
}

(async () => {
  // 0) decide URL
  let url = process.argv[2];
  if (!url) {
    url = await askQuestion("📥 Vui lòng nhập URL để scrape: ");
    if (!url) {
      console.error("❌ Không có URL, đang thoát.");
      process.exit(1);
    }
  }

  // 1) Apply stealth plugin
  puppeteer.use(StealthPlugin());

  // 2) Launch browser
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox"],
    defaultViewport: null
  });
  const page = await browser.newPage();

  // 3) Intercept XHR GraphQL responses
  const xhrRequests = [];
  page.on("response", async res => {
    try {
      const rurl = res.url();
      if (
        rurl.includes("https://www.facebook.com/api/graphql/") &&
        res.request().resourceType() === "xhr"
      ) {
        const body = await res.json();
        xhrRequests.push({ url: rurl, body });
      }
    } catch {}
  });

  console.log(`▶️  Loading ${url}`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

  // 4) Auto-scroll to load all content
  let prevHeight = await page.evaluate(() => document.body.scrollHeight);
  while (true) {
    await page.evaluate(() => window.scrollBy(0, 10000));
    await new Promise(r => setTimeout(r, 2000));
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) {
      console.log("✅ No more content to load.");
      break;
    }
    prevHeight = newHeight;
    console.log("🔄 Scrolled, new height:", newHeight);
  }

  // 5) Extract embedded JSON nodes + metadata
  const embedData = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('script[type="application/json"]').forEach(script => {
      let j;
      try { j = JSON.parse(script.textContent || ""); } catch { return; }
      if (!Array.isArray(j.require)) return;

      j.require.forEach(item => {
        const payloadArr = item[3];
        if (!Array.isArray(payloadArr)) return;

        payloadArr.forEach(block => {
          const bboxReq = block.__bbox?.require;
          if (!Array.isArray(bboxReq)) return;

          bboxReq.forEach(inner => {
            let dataBlk = inner[3];
            if (Array.isArray(dataBlk) && dataBlk.length > 1) dataBlk = dataBlk[1];

            const resultRoot = dataBlk?.__bbox?.result;
            const conn = resultRoot?.data?.ad_library_main?.search_results_connection;
            if (!conn || !Array.isArray(conn.edges)) return;

            conn.edges.forEach(edge => {
              if (edge.node) {
                out.push({
                  node: edge.node,
                  cursor: edge.cursor,
                });
              }
            });
          });
        });
      });
    });
    return out;
  });

  console.log(`✅ Extracted ${embedData.length} embedded items`);

  // 6) Build records for API
const adsFromEmbed = [];
for (const item of embedData) {
  const n = item?.node;
  if (!n) continue;
  if (Array.isArray(n.collated_results) && n.collated_results.length) {
    adsFromEmbed.push(...n.collated_results);
  } else if (n.snapshot) {
    adsFromEmbed.push(n);
  }
}

const adsFromXHR = [];
const dig = (obj) => {
  if (!obj || typeof obj !== "object") return;
  const conn =
    obj?.ad_library_main?.search_results_connection ||
    obj?.ad_library_main?.ad_search?.results?.search_results_connection ||
    obj?.ad_archive?.search_results_connection ||
    obj?.viewer?.ad_archive_search?.search_results_connection;
  if (conn?.edges?.length) {
    for (const e of conn.edges) {
      const n = e?.node;
      if (!n) continue;
      if (Array.isArray(n.collated_results) && n.collated_results.length) {
        adsFromXHR.push(...n.collated_results);
      } else {
        adsFromXHR.push(n);
      }
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") dig(v);
  }
};
for (const req of xhrRequests) {
  const body = req?.body;
  if (Array.isArray(body)) body.forEach(d => dig(d?.data ?? d));
  else dig(body?.data ?? body);
}

const allAdsRaw = [...adsFromEmbed, ...adsFromXHR];

// 7) Khử trùng lặp theo id/snapshot.id/... để tránh insert trùng
const seen = new Set();
const uniqueAdsRaw = [];
for (const ad of allAdsRaw) {
  const key =
    ad?.id || ad?.adid || ad?.snapshot?.id || ad?.snapshot?.adid ||
    (ad?.page_id && (ad?.snapshot?.body?.text || ad?.best_description?.text)
      ? `${ad.page_id}:${(ad?.snapshot?.body?.text || ad?.best_description?.text).slice(0,120)}`
      : null);
  if (key && seen.has(key)) continue;
  if (key) seen.add(key);
  uniqueAdsRaw.push(ad);
}

// 8) Map CHÍNH XÁC các trường như scraper.js + bổ sung fallback từ XHR
const processedDataForDB = uniqueAdsRaw.map((ad) => {
  const snapshot = ad?.snapshot || ad;

  // brand: snapshot.page_name || page.name (XHR)
  const brand =
    snapshot?.page_name ||
    ad?.page?.name ||
    ad?.page_name ||
    null;

  // start_date: ưu tiên ad.start_date nếu có
  const startTs = ad?.start_date || snapshot?.start_date || null;
  const startDate = startTs ? new Date(startTs * 1000).toISOString().split("T")[0] : null;

  // format
  const adFormat = () => {
    if (snapshot?.videos?.length > 0) return "video";
    if (snapshot?.images?.length > 0) return "image";
    if (snapshot?.cards?.length > 0) return "carousel";
    return "unknown";
  };

  // platforms
  const platformsArr =
    (Array.isArray(ad?.publisher_platform) && ad.publisher_platform) ||
    (Array.isArray(snapshot?.publisher_platform) && snapshot.publisher_platform) ||
    null;

  // caption: thêm fallback từ XHR: best_description.text, ad_creative_bodies[0].text, ...
  const caption =
    snapshot?.body?.text ||
    snapshot?.caption?.text ||
    ad?.best_description?.text ||
    (Array.isArray(ad?.ad_creative_bodies) && ad.ad_creative_bodies[0]?.text) ||
    null;

  // media
  const imageUrl = snapshot?.images?.[0]?.original_image_url || null;
  const videoUrl = snapshot?.videos?.[0]?.video_hd_url || snapshot?.videos?.[0]?.video_sd_url || null;

  return {
    brand: brand,
    status: ad?.is_active ? "Active" : "Inactive",
    start_date: startDate,
    time_running: ad?.total_active_time || null,
    ads_format: adFormat(),
    ads_platforms: platformsArr ? platformsArr.join(", ") : null,
    image_url: imageUrl,
    video_url: videoUrl,
    caption: caption,
    // (tuỳ chọn) gửi kèm ad_id để server dedup tốt hơn:
    // ad_id: ad?.id || ad?.adid || snapshot?.id || snapshot?.adid || null,
  };
}).filter(r => r.brand || r.caption || r.image_url || r.video_url);

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "25", 10); // chỉnh qua env nếu muốn
const SLEEP_MS = parseInt(process.env.BATCH_SLEEP || "300", 10);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (processedDataForDB.length > 0) {
  console.log(`🚀 Tổng ${processedDataForDB.length} records — gửi theo lô ${BATCH_SIZE}...`);
  let okTotal = 0, failTotal = 0;

  for (let i = 0; i < processedDataForDB.length; i += BATCH_SIZE) {
    const batch = processedDataForDB.slice(i, i + BATCH_SIZE);
    console.log(`➡️  Lô ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} records`);

    try {
      const response = await fetch("http://server-ads.aipencil.name.vn/scrape_ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: batch }),
      });

      const text = await response.text();
      let result; try { result = JSON.parse(text); } catch { result = { raw: text }; }

      if (response.ok) {
        const inserted = result?.insertedCount ?? batch.length;
        okTotal += inserted;
        console.log(`✅ OK: inserted ~${inserted}.`);
      } else {
        failTotal += batch.length;
        console.error(`❌ Lỗi API (status ${response.status}): ${result?.error || response.statusText}`);
        if (response.status === 413) {
          console.error("👉 Gợi ý: giảm BATCH_SIZE (vd 10) hoặc tăng limit server.");
        }
      }
    } catch (err) {
      failTotal += batch.length;
      console.error("❌ Network/Fetch error:", err?.message || err);
    }

    await sleep(SLEEP_MS); // nghỉ 1 chút để nhẹ server
  }

  console.log(`🎯 Hoàn tất: OK ~${okTotal}, Fail ~${failTotal}`);
} else {
  console.log("🤷 Không có dữ liệu để gửi đi.");
}

  await browser.close();
})();
