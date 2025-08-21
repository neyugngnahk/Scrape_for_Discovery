const express = require('express');
const pool = require('./database'); // Đảm bảo file database.js cấu hình đúng kết nối Postgres
const cors = require("cors");
const app = express();
app.use(express.json());

// Cho phép request từ mọi nguồn gốc, bạn có thể giới hạn lại nếu cần
app.use(cors());

// Đảm bảo bảng có các cột cần thiết
(async () => {
  try {
    await pool.query("ALTER TABLE discovery_ads ADD COLUMN IF NOT EXISTS brand_logo_url TEXT");
    // THÊM: Thêm cột ad_id và quan trọng là đặt nó là UNIQUE
    await pool.query("ALTER TABLE discovery_ads ADD COLUMN IF NOT EXISTS ad_id TEXT UNIQUE");
  } catch (e) {
    console.error('DB init error:', e?.message || e);
  }
})();

// Puppeteer để scrape
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const port = 5000;

app.post('/scrape_ads', async (req, res) => {
  const { data } = req.body;
  
  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ hoặc không phải là một mảng' });
  }

  console.log(`Nhận được yêu cầu insert ${data.length} records.`);
  
  try {
    const results = [];
    const today = new Date();

    // Insert từng record trong mảng data
    for (const item of data) {
      // Tính time_running (số ngày)
      let time_running = null;
      if (item.start_date) {
        const startDate = new Date(item.start_date);
        const diffMs = today - startDate;
        const diffDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
        time_running = diffDays; // kiểu int
      }
      // Gán lại vào item
      item.time_running = time_running;

      const { query, values } = scrape_data(item);
      const result = await pool.query(query, values);
      results.push(result.rowCount);
    }
    
    const totalInserted = results.reduce((sum, count) => sum + count, 0);
    
    res.json({ 
      success: true, 
      message: `Đã xử lý xong ${results.length} records.`,
      insertedCount: totalInserted
    });
    
  } catch (err) {
    console.error('Lỗi khi insert data:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

app.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});

// ===== Helper: sleep
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===== Helper: Random delay between URLs
const randomDelay = (minMs = 3000, maxMs = 7000) => {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(delay);
};

// ===== Helper: Random User-Agent
const getRandomUserAgent = () => {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// ===== Helper: scrape 1 URL bằng Puppeteer (stealth)
const scrapeFacebookAdsFromUrl = async (url, browser) => {
  const page = await browser.newPage();

  // Set random User-Agent
  await page.setUserAgent(getRandomUserAgent());
  
  // Set additional headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
  });

  const xhrRequests = [];
  page.on('response', async (res) => {
    try {
      const rurl = res.url();
      if (
        rurl.includes('https://www.facebook.com/api/graphql/') &&
        res.request().resourceType() === 'xhr'
      ) {
        const body = await res.json();
        xhrRequests.push({ url: rurl, body });
      }
    } catch {}
  });

  // Load trang với timeout dài hơn
  console.log(`🔄 Đang load: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  // Auto scroll để tải hết nội dung
  let prevHeight = await page.evaluate(() => document.body.scrollHeight);
  let scrollCount = 0;
  while (true) {
    await page.evaluate(() => window.scrollBy(0, 10000));
    await sleep(2000 + Math.random() * 2000); // Random 2-4s
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break;
    prevHeight = newHeight;
    scrollCount++;
    if (scrollCount % 5 === 0) {
      console.log(`📜 Scrolled ${scrollCount} times, height: ${newHeight}`);
    }
  }

  // Lấy các JSON embedded
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

  // Từ embedded + XHR, gom tất cả ads
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
    if (!obj || typeof obj !== 'object') return;
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
      if (v && typeof v === 'object') dig(v);
    }
  };
  for (const req of xhrRequests) {
    const body = req?.body;
    if (Array.isArray(body)) body.forEach(d => dig(d?.data ?? d));
    else dig(body?.data ?? body);
  }

  const allAdsRaw = [...adsFromEmbed, ...adsFromXHR];

  // Khử trùng lặp theo id/snapshot.id/...
  const seen = new Set();
  const uniqueAdsRaw = [];
  for (const ad of allAdsRaw) {
    const key =
      ad?.ad_archive_id || ad?.id || ad?.adid || ad?.snapshot?.id || ad?.snapshot?.adid ||
      (ad?.page_id && (ad?.snapshot?.body?.text || ad?.best_description?.text)
        ? `${ad.page_id}:${(ad?.snapshot?.body?.text || ad?.best_description?.text).slice(0,120)}`
        : null);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    uniqueAdsRaw.push(ad);
  }

  // Map sang định dạng lưu DB
  const processedDataForDB = uniqueAdsRaw.map((ad) => {
    const snapshot = ad?.snapshot || ad;
    
    // ĐÃ SỬA LỖI: Lấy ad_id từ trường mới "ad_archive_id"
    const adId = ad?.ad_archive_id || ad?.id || ad?.adid || snapshot?.id || snapshot?.adid || null;

    const brand =
      snapshot?.page_name ||
      ad?.page?.name ||
      ad?.page_name ||
      null;

    const startTs = ad?.start_date || snapshot?.start_date || null;
    const startDate = startTs ? new Date(startTs * 1000).toISOString().split('T')[0] : null;

    const adFormat = () => {
      if (snapshot?.videos?.length > 0) return 'video';
      if (snapshot?.images?.length > 0) return 'image';
      if (snapshot?.cards?.length > 0) return 'carousel';
      return 'unknown';
    };

    const platformsArr =
      (Array.isArray(ad?.publisher_platform) && ad.publisher_platform) ||
      (Array.isArray(snapshot?.publisher_platform) && snapshot.publisher_platform) ||
      null;

    const caption =
      snapshot?.body?.text ||
      snapshot?.caption?.text ||
      ad?.best_description?.text ||
      (Array.isArray(ad?.ad_creative_bodies) && ad.ad_creative_bodies[0]?.text) ||
      null;

    const imageUrl = snapshot?.images?.[0]?.original_image_url || null;
    const videoUrl = snapshot?.videos?.[0]?.video_hd_url || snapshot?.videos?.[0]?.video_sd_url || null;
    const brandLogoUrl =
      snapshot?.page_profile_picture_url ||
      snapshot?.page_profile_image_url ||
      snapshot?.page?.profile_picture_url ||
      snapshot?.page?.profile_picture?.uri ||
      snapshot?.page?.profile_picture?.url ||
      ad?.page_profile_picture_url ||
      ad?.page_profile_image_url ||
      ad?.page?.profile_picture_url ||
      ad?.page?.profile_picture?.uri ||
      ad?.page?.profile_picture?.url ||
      null;

    return {
      ad_id: adId,
      brand: brand,
      status: ad?.is_active ? 'Active' : 'Inactive',
      start_date: startDate,
      time_running: ad?.total_active_time || null,
      ads_format: adFormat(),
      ads_platforms: platformsArr ? platformsArr.join(', ') : null,
      image_url: imageUrl,
      video_url: videoUrl,
      brand_logo_url: brandLogoUrl,
      caption: caption,
    };
  }).filter(r => r.brand || r.caption || r.image_url || r.video_url);

  await page.close();
  return processedDataForDB;
};

// ===== Helper: Retry với backoff theo lũy thừa cho 1 URL
const scrapeUrlWithRetry = async (url, browser, maxRetries = 3, baseDelayMs = 2000) => {
  let attemptIndex = 0;
  let lastError = null;
  while (attemptIndex < maxRetries) {
    try {
      return await scrapeFacebookAdsFromUrl(url, browser);
    } catch (err) {
      lastError = err;
      attemptIndex += 1;
      const isFinal = attemptIndex >= maxRetries;
      const backoffMs = baseDelayMs * Math.pow(2, attemptIndex - 1);
      console.error(`🔄 Lỗi scrape URL (lần ${attemptIndex}/${maxRetries}):`, url, err?.message || err);
      if (isFinal) break;
      console.log(`⏳ Đợi backoff ~${Math.round(backoffMs / 1000)}s rồi thử lại...`);
      await sleep(backoffMs);
    }
  }
  throw lastError;
};

// ===== Endpoint: Lấy URL từ bảng links, scrape tuần tự và lưu về discovery_ads
app.post('/scrape_from_links', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT url FROM links2 WHERE url IS NOT NULL');
    const urls = rows.map(r => r.url).filter(Boolean);

    if (!urls.length) {
      return res.json({ success: true, message: 'Không có URL hợp lệ trong bảng links2.', totalUrls: 0, totalAds: 0, insertedCount: 0 });
    }

    puppeteer.use(StealthPlugin());
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: null,
    });

    const summary = { totalUrls: urls.length, totalAds: 0, insertedCount: 0 };
    const today = new Date();

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`\n🌐 [${i + 1}/${urls.length}] Đang xử lý: ${url}`);
      try {
        const data = await scrapeUrlWithRetry(url, browser);
        console.log(`✅ Đã scrape xong URL ${i + 1}/${urls.length}: ${data.length} ads từ ${url}`);
        summary.totalAds += data.length;

        for (const item of data) {
          // Tính lại time_running từ start_date (giữ nguyên logic cũ)
          let time_running = null;
          if (item.start_date) {
            const startDate = new Date(item.start_date);
            const diffMs = today - startDate;
            const diffDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
            time_running = diffDays;
          }
          item.time_running = time_running;

          const { query, values } = scrape_data(item);
          const result = await pool.query(query, values);
          summary.insertedCount += result.rowCount;
        }

        // Nghỉ ngẫu nhiên giữa các URL (3-7 giây)
        const delay = Math.floor(Math.random() * 4000) + 3000;
        console.log(`⏳ Nghỉ ${Math.round(delay/1000)}s trước URL tiếp theo...`);
        await randomDelay(3000, 7000);
      } catch (errUrl) {
        console.error(`❌ Bỏ qua URL ${i + 1}/${urls.length} sau 3 lần thử: ${url}`);
        console.error(`   Lỗi cuối: ${errUrl?.message || errUrl}`);
      }
    }

    await browser.close();

    console.log(`\n🎯 HOÀN THÀNH SCRAPE!`);
    console.log(`📊 Tổng kết: ${summary.totalUrls} URLs, ${summary.totalAds} ads, ${summary.insertedCount} records đã insert`);
    
    return res.json({ success: true, ...summary });
  } catch (err) {
    console.error('Lỗi khi scrape_from_links:', err);
    return res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// Hàm này tạo câu lệnh SQL và các giá trị từ một object item
const scrape_data = (data) => {
  const query = `
    INSERT INTO discovery_ads (
      ad_id,
      brand, 
      status, 
      start_date, 
      time_running, 
      ads_format, 
      ads_platforms, 
      image_url, 
      video_url, 
      caption,
      brand_logo_url
    ) 
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
    )
    -- TỐI ƯU: Chỉ định rõ ràng cột để kiểm tra xung đột
    ON CONFLICT (ad_id) DO NOTHING;
  `;
  
  const values = [
    data.ad_id || null,
    data.brand || null,
    data.status || null,
    data.start_date || null,
    data.time_running || null,
    data.ads_format || null,
    data.ads_platforms || null,
    data.image_url || null,
    data.video_url || null,
    data.caption || null,
    data.brand_logo_url || null
  ];

  return { query, values };
};