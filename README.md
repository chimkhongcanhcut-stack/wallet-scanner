# 🛰 Solana Wallet Scanner (Discord Bot)

Bot Discord dùng để **scan ví Solana** theo điều kiện:
- Ví “trắng / white-ish” (1–2 tx đầu là transfer)
- Được **fund từ 1 source wallet xác định**
- Trong **time window** (giờ)
- Với **min SOL** tối thiểu
- Hỗ trợ **scan 1 ví hoặc scan list nhiều ví (.txt / paste)**

Bot được thiết kế để:
- Không bị `The application did not respond`
- Không block event loop
- Scan nặng chạy trong **Worker Thread**
- Có **heartbeat (đang scan…)** + **timeout cứng**

---

## ✨ Features

- Slash commands (Discord)
- Config **per-channel** (mỗi channel 1 source / min / time riêng)
- Scan 1 ví (`/scan`)
- Scan nhiều ví (`/scanlist`)
  - Paste list nhiều dòng
  - Upload file `message.txt` / `.txt`
- Embed kết quả đẹp + link Solscan
- Ping `@everyone` khi có match
- Worker thread (không lag bot)
- Heartbeat mỗi 15s khi scan lâu
- Hard-timeout nếu RPC quá chậm

---

## 🧩 Điều kiện scan (logic cốt lõi)

Một ví được coi là **MATCH** khi:

1. Ví có:
   - 1 tx đầu là transfer **hoặc**
   - 2 tx đầu đều là transfer
2. Trong 2 tx cũ nhất:
   - Có transfer **từ source wallet → ví**
   - Số SOL ≥ `min SOL`
3. Thời gian của 2 tx cũ nhất:
   - Nằm trong `time window` (giờ)

---

## 📦 Yêu cầu

- Node.js **>= 18**
- Discord Bot Token
- Solana RPC (Helius / Triton / QuickNode / v.v.)
- Quyền bot trong channel:
  - View Channel
  - Send Messages
  - Embed Links
  - Use Application Commands

---

