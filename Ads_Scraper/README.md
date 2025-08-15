<h1 align="center">🕵️‍♂️ REAL SCRAPER™ - Siêu Công Cụ Cào Dữ Liệu Facebook Ads Library</h1>

<p align="center">
  <img src="https://img.shields.io/badge/made%20with-love-red?style=for-the-badge" />
  <img src="https://img.shields.io/badge/fb%20ads%20scraper-🔥%20Real%20AF-orange?style=for-the-badge" />
</p>

---

## 🚀 Giới thiệu

**REAL SCRAPER™** là một tool cào dữ liệu từ **Facebook Ads Library**. Dành cho các chiến thần marketing, giám sát đối thủ, clone idea, và... nghiên cứu học thuật 🤡.

> #dcmfbadslibrili

---

## 🧪 Cài đặt cho các cháu

```bash
# 1. Cài thư viện phụ thuộc
npm install

# 2. Chạy tool
node ./scraper.js
```

> **💡 Nếu lỗi thiếu thư viện:**
> 
> ```bash
> npm install puppeteer-extra puppeteer-extra-plugin-stealth
> ```

---

## ⚙️ Công nghệ sử dụng

- 🕸️ `puppeteer-extra`: trình duyệt tự động giả người thật
- 🥷 `puppeteer-extra-plugin-stealth`: né tránh hệ thống phát hiện bot của Facebook
- 📦 `fs`: để lưu dữ liệu ra file JSON
- 🧠 `readline`: để nhập URL thủ công nếu không truyền qua CLI

---

## 📦 Output

Sau khi chạy, tool sẽ tạo ra file:

```
📁 data.json
```

Chứa toàn bộ dữ liệu ads bạn vừa cào. Ngon lành.

---

## 🎯 Cách dùng nâng cao

Chạy bằng URL trực tiếp:

```bash
node ./scraper.js "https://www.facebook.com/ads/library/?q=suzuki"
```

Hoặc để tool hỏi:

```bash
node ./scraper.js
```

Dán link → Enter → cào → xong.

---

## 💣 Cảnh báo nhẹ

> Tool chỉ dùng cho mục đích học tập, phân tích kỹ thuật, hoặc yêu nước.
> 
> **Không khuyến khích dùng phá hoại.**

> #dcmfbadslibrili

---

## 🧼 Tips xử lý lỗi

| Vấn đề                        | Giải pháp                                           |
|------------------------------|------------------------------------------------------|
| `ERR_MODULE_NOT_FOUND`       | Cài thiếu package → `npm install puppeteer-extra`   |
| Không thấy data.json         | Kiểm tra quyền ghi file hoặc URL đã hợp lệ chưa     |
| Bị Facebook chặn             | Dùng Stealth Plugin → đỡ bị phát hiện               |

---

## 🧙‍♂️ Tâm sự cuối

Chúc các cháu:

- Cào mạnh tay không run
- Chạy êm không lỗi
- Thông tin ads chất như nước cất

> **#dcmfbadslibrili**  
> Tool này là để **clone hoặc phá**. Không có ở giữa.

---

<p align="center"><i>Made by người viết tool trong đêm lạnh, với một nỗi buồn mang tên CPM tăng</i></p>
<p align="center"><b>💻 Code by <span style='color:#f40;'>minhmice</span> - Người viết tool không bao giờ ngủ</b></p>
<p align="center"><i>Hãy nhớ, đây không phải là script... đây là nghệ thuật.</i></p>
