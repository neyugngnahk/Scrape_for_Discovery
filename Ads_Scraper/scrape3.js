// Trigger backend to scrape from DB links and insert into discovery_ads
// Usage:
//   node Ads_Scraper/scrape3.js               -> POST to http://localhost:5000/scrape_from_links
//   node Ads_Scraper/scrape3.js http://host:port

const argBase = process.argv[2];
const BASE_URL = argBase || process.env.API_BASE_URL || 'http://localhost:5000';
const ENDPOINT = `${BASE_URL.replace(/\/$/, '')}/scrape_from_links`;

async function main() {
  try {
    console.log(`▶️  Gọi backend: POST ${ENDPOINT}`);
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      console.error('❌ Backend trả lỗi:', res.status, data?.error || res.statusText);
      process.exit(1);
    }

    console.log('✅ Hoàn tất:');
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ Lỗi gọi API:', err?.message || err);
    console.error('🔎 Gợi ý kiểm tra: Server đã chạy chưa? Có đúng URL không?', ENDPOINT);
    console.error('🔧 Nếu server chạy cổng khác, hãy chạy: node Ads_Scraper/scrape3.js http://localhost:5000');
    process.exit(1);
  }
}

main();


