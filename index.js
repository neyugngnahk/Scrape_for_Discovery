const express = require('express');
const pool = require('./database'); // Đảm bảo file database.js cấu hình đúng kết nối Postgres
const cors = require("cors");
const app = express();
app.use(express.json());
app.use(cors());

// Tự động tạo bảng Brands và Ads nếu chưa tồn tại
(async () => {
  try {
    console.log('Đang kiểm tra và khởi tạo database schema...');
    // 1. Tạo bảng "brands"
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY,
        name TEXT,
        logo_url TEXT,
        platform TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(name, platform)
      );
    `);
    
    // 2. Tạo bảng "ads" với khóa ngoại tham chiếu đến "brands"
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ads (
        id SERIAL PRIMARY KEY,
        brand_id INTEGER REFERENCES brands(id),
        start_date DATE,
        status TEXT,
        time_running INTEGER,
        ad_format TEXT,
        ad_platform TEXT,
        image_url TEXT,
        video_url TEXT,
        caption TEXT,
        provider_ad_id TEXT UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Database schema đã sẵn sàng.');
  } catch (e) {
    console.error('❌ Lỗi khởi tạo DB:', e?.message || e);
  }
})();


// Puppeteer để scrape
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const port = 5000;

//  Hàm "Get or Create" cho Brands
/**
 * Tìm một brand theo name và platform. Nếu không có, tạo mới và trả về id.
 * @param {object} brandData - Chứa { name, logo_url, platform }
 * @returns {Promise<number>} ID của brand
 */
async function getOrCreateBrandId(brandData) {
  const { name, logo_url } = brandData;
  const platform = brandData.platform || 'Facebook/Instagram'; // Mặc định là Facebook/Instagram nếu không có platform  

  if (!name) {
    // Nếu không có tên brand, không thể tạo hoặc tìm kiếm
    return null;
  }

  // Bước 1: Kiểm tra brand đã tồn tại chưa
  const selectQuery = 'SELECT id FROM brands WHERE name = $1 AND platform = $2';
  const selectResult = await pool.query(selectQuery, [name, platform]);

  if (selectResult.rows.length > 0) {
    // Nếu đã tồn tại, trả về id
    return selectResult.rows[0].id;
  } else {
    // Nếu chưa, tạo mới và trả về id
    const insertQuery = 'INSERT INTO brands (name, logo_url, platform) VALUES ($1, $2, $3) RETURNING id';
    const insertResult = await pool.query(insertQuery, [name, logo_url, platform]);
    return insertResult.rows[0].id;
  }
}

// Endpoint chính để bắt đầu scrape
app.post('/scrape_from_links', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT url FROM links WHERE url IS NOT NULL');
    const urls = rows.map(r => r.url).filter(Boolean);

    if (!urls.length) {
      return res.json({ success: true, message: 'Không có URL hợp lệ trong bảng links.', totalUrls: 0, totalAds: 0, insertedCount: 0 });
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
        const scrapedAds = await scrapeUrlWithRetry(url, browser);
        console.log(`✅ Đã scrape xong URL ${i + 1}/${urls.length}: ${scrapedAds.length} ads từ ${url}`);
        summary.totalAds += scrapedAds.length;

        for (const adItem of scrapedAds) {
          // 1. Lấy hoặc tạo brand_id
          const brandId = await getOrCreateBrandId({
            name: adItem.brand,
            logo_url: adItem.brand_logo_url,
            platform: adItem.ads_platforms, // Truyền thêm platform từ dữ liệu scrape
          });

          // 2. Gắn brand_id vào dữ liệu quảng cáo
          adItem.brand_id = brandId;

          // 3. Tính toán time_running
          let time_running = null;
          if (adItem.start_date) {
            const startDate = new Date(adItem.start_date);
            const diffMs = today - startDate;
            time_running = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
          }
          adItem.time_running = time_running;

          // 4. Chuẩn bị và thực thi câu lệnh INSERT vào bảng "ads"
          const { query, values } = createAdInsertQuery(adItem);
          const result = await pool.query(query, values);
          summary.insertedCount += result.rowCount;
        }

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


// Tạo câu lệnh INSERT cho bảng "ads"
const createAdInsertQuery = (data) => {
  const query = `
    INSERT INTO ads (
      brand_id,
      provider_ad_id,
      start_date,
      status,
      time_running,
      ad_format,
      ad_platform,
      image_url,
      video_url,
      caption
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (provider_ad_id) DO NOTHING;
  `;
  
  const values = [
    data.brand_id,
    data.ad_id || null, // ad_id từ scraper giờ là provider_ad_id
    data.start_date || null,
    data.status || null,
    data.time_running || null,
    data.ads_format || null,
    data.ads_platforms || null,
    data.image_url || null,
    data.video_url || null,
    data.caption || null,
  ];

  return { query, values };
};

app.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});


const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (minMs = 3000, maxMs = 7000) => sleep(Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs);
const getRandomUserAgent = () => {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};



const scrapeFacebookAdsFromUrl = async (url, browser) => {
  const page = await browser.newPage();

  await page.setUserAgent(getRandomUserAgent());
  
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

  console.log(`🔄 Đang load: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  let prevHeight = await page.evaluate(() => document.body.scrollHeight);
  let scrollCount = 0;
  while (true) {
    await page.evaluate(() => window.scrollBy(0, 10000));
    await sleep(2000 + Math.random() * 2000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break;
    prevHeight = newHeight;
    scrollCount++;
    if (scrollCount % 5 === 0) {
      console.log(`📜 Scrolled ${scrollCount} times, height: ${newHeight}`);
    }
  }

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

  const processedDataForDB = uniqueAdsRaw.map((ad) => {
    const snapshot = ad?.snapshot || ad;
    
    const adId = ad?.ad_archive_id || ad?.id || ad?.adid || snapshot?.id || snapshot?.adid || null;
    const brand = snapshot?.page_name || ad?.page?.name || ad?.page_name || null;
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