# zemo-lib 同步對照文件

此目錄包含從 **zemo-api** 複製出來的排程演算法核心檔案，供 scheduler-web-demo 和 slot-monitor 獨立使用，不再依賴外部 `zemo-api/` 資料夾。

## 來源資訊

| 項目 | 值 |
|------|-----|
| 來源 repo | zemo-api（私有 repo） |
| 複製時的 commit | `a09d0ad`（2026-03-12） |
| 複製日期 | 2026-04-03 |

---

## 檔案說明

### libs/（16 個）— 排程演算法核心

| 檔案 | 做什麼 | 有本地修改？ |
|------|--------|-------------|
| `proximity.js` | **排程主演算法**。依距離最近原則，逐筆預約分配給最合適的駕駛。包含班表檢查、到達時間判斷、電量檢查、充電機會分析 | 無 |
| `vehicle-routing.js` | **車型路由排程器**。五步流程：先排七人座專屬訂單 → gap-fill 一般訂單進七人座排程 → 五人座排剩餘訂單 | 無 |
| `gap-filling.js` | **空檔填充**。在既有排程的行程間隙中，嘗試塞入未分配的訂單。計算 gap 時間、到達可行性、電量可行性 | 無 |
| `geo.js` | **地理計算**。兩點距離、行駛時間估算（含尖峰/離峰/區域加成）、機場範圍判斷（桃園/松山多邊形）、行程時長估算 | 無 |
| `environment.js` | **環境參數**。所有排程用的參數集中管理：時速、緩衝秒數、電量上限、充電時間、尖峰/離峰時段定義等 | 無 |
| `reservation.js` | **預約工具函式**。`populateInternalReservationTime`（機場接機 +20 分鐘緩衝）、預約格式化、行程 URL 生成 | **有修改**（見下方） |
| `driver.js` | **駕駛班表處理**。`reduceDriverSchedulesWithLeaves`：從週排班表扣除請假時段，產出當日實際可上班班次 | 無 |
| `charging.js` | **充電分析**。判斷駕駛閒置時間是否足夠充電、計算充電後續航增加量、建立充電任務 | 無 |
| `schedule-utils.js` | **排程工具**。建立充電/預約任務物件、計算非行程移動距離、匯出 `analyzeChargingOpportunity` 等共用函式 | 無 |
| `vehicle-type-utils.js` | **車型相容判斷**。五人座司機不可接七人座訂單、駕駛/訂單分類（LARGE/STANDARD）| 無 |
| `logging.js` | **結構化日誌**。Bunyan logger 封裝、GCP Cloud Logging 整合、時間格式化工具 | 無 |
| `enum.js` | **列舉常數**。區域代碼（淡水/宜蘭/林口等）、距離加成類型、機場代碼（TPE/TSA）、行程分類 | 無 |
| `helper.js` | **通用工具**。CryptoJS 加解密、字串大小寫轉換、中文偵測 | 無 |
| `metrics.js` | **Prometheus 指標**。排程執行時間、預約數量等監控指標收集 | 無 |
| `algorithm-response-enhancer.js` | **回應格式增強**。為排程結果加入執行時間、駕駛統計等額外資訊 | 無 |
| `reservation-config-deps.js` | **預約設定依賴**。苗栗/台中區域邊界常數、位置限制檢查 | 無 |

### constants/（3 個）— 業務常數

| 檔案 | 做什麼 | 有本地修改？ |
|------|--------|-------------|
| `constants.js` | **通用常數**。`TAIPEI_TIMEZONE = "Asia/Taipei"`、其他全域設定 | 無 |
| `enterprise.js` | **企業優先度**。`HIGH_PRIORITY_ENTERPRISES`（優先排程的企業 ID）、`LOW_PRIORITY_ENTERPRISES`（延後排的企業 ID） | 無 |
| `drivers.js` | **司機分層**。`RELIEF_DRIVER_IDS`（支援司機）、`SECONDARY_DRIVER_IDS`（次要司機），排程時正職司機優先 | 無 |

---

## 本地修改紀錄

### reservation.js — `populateInternalReservationTime` 緩衝修正

**修改日期**：2026-04-03

**問題**：原版第 381 行 `reservationDay630am` 計算有 bug：
```javascript
// 原版（bug）— 「預約時間 + 6h30m」，不是「當天 06:30」
const reservationDay630am = reservationMoment.clone().add(6, "h").add(30, "m");
// → 22:40 的接機：reservationDay630am = 隔天 05:10
// → isAfter(隔天05:10) 永遠是 false → +20 分鐘 buffer 不會觸發
// → 結果：06:30 之後的機場接機全部沒有緩衝
```

**修正**：移除時段判斷，全時段一律 +20 分鐘：
```javascript
// 修正版 — 機場接機全時段加 20 分鐘（旅客通關 + 領行李緩衝）
reservation.internalReservationTime = reservation.reservationTime + 60 * 20;
```

**影響**：排程演算法判斷「司機來不來得及」時，機場接機的截止時間從 `reservationTime` 放寬為 `reservationTime + 20 min`。實測 04/04 排程從 32 筆分配提升至 34 筆。

---

## 同步更新指引

當 zemo-api 有排程相關更新時：

1. **確認影響範圍** — 只需關注上方 19 個檔案
2. **比對差異**：
   ```bash
   diff zemo-api/libs/proximity.js scheduler-web-demo/zemo-lib/libs/proximity.js
   ```
3. **複製更新** — 將有變動的檔案覆蓋到 `zemo-lib/` 對應位置
4. **保留本地修改** — `reservation.js` 的 buffer 修正不要被覆蓋
5. **測試** — 執行 `node scheduler-web-demo/debug-yeh-driver.js` 驗證排程結果

---

## npm 套件依賴

這些檔案使用的 npm 套件（皆已安裝在根目錄 `package.json`）：

| 套件 | 用途 |
|------|------|
| `lodash` | 陣列/物件操作工具 |
| `moment` / `moment-timezone` | 時間處理（台灣時區） |
| `@turf/helpers` / `@turf/points-within-polygon` | 地理多邊形判斷（機場範圍偵測） |
| `geo-distance` | 兩點直線距離計算 |
| `bunyan` / `@google-cloud/logging-bunyan` | 結構化日誌 + GCP 整合 |
| `prom-client` | Prometheus 監控指標 |
| `camelcase-keys-deep` | API 回應 snake_case → camelCase 轉換 |
| `crypto-js` / `change-case` | 加解密、字串格式轉換 |
| `dotenv` | 環境變數載入 |
