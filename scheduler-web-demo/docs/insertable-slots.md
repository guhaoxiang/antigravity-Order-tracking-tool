# Insertable Slots（假行程）說明

本文件整理 `scheduler-web-demo` 中「可再塞送機 / 可再塞接機」的 demo 邏輯，供工程師交接使用。

## 1. 功能邊界

- 此功能只影響 demo 顯示的 `insertableSlots`，不會回寫正式系統。
- 正式排程仍由 `zemo-api` 演算法產生；假行程只是在既有結果上做可行時窗分析。

## 2. 主要程式位置

- 假行程模組：`core/insertable-slots.js`
  - 產生 `insertableSlots`
  - 送機 / 接機掃描規則
  - 電量可行性與時間窗輸出
- 主排程：`core/scheduler-engine.js`
  - 呼叫 `computeInsertableSlots(...)`
  - 將結果掛到 `debugByDriver[key].insertableSlots`
- 前端顯示：`views/schedule.ejs`
  - 讀取 `insertableSlots`，分成 dropoff / pickup 區塊

## 3. reservationTime 語意

- 送機（dropoff）：
  - `reservationTime` = 出發/上車時間。
- 接機（pickup）：
  - `reservationTime` = 預約時間（不是乘客上車時間）。
  - 乘客上車時間 = `reservationTime + 50 min`（`pickupBufferSec`）。
  - 司機需在 `reservationTime + 40 min` 前可抵達機場（`arrivalDeadlineBufferSec`）。

## 4. 接機新增規則（本次）

- 若前一趟正式行程是接機（`AIRPORT_ARRIVAL`），則在塞入「假接機」時：
  - 新的 `reservationTime` 需滿足 `reservationTime >= 前一趟reservationTime + 30 min`。
- 此規則只作用於假行程判斷，不修改原始排程任務。

## 5. 輸出欄位（`insertableSlots`）

每個 slot 主要包含：

- `tripType`: `dropoff` / `pickup`
- `tripName`, `originLabel`, `destLabel`
- `gapKind`
- `windows[]`：
  - `startTime`, `endTime`
  - `reservationTimeStart`, `reservationTimeEnd`
  - `passengerPickupTimeStart`, `passengerPickupTimeEnd`
  - `driverArrivalDeadlineStart`, `driverArrivalDeadlineEnd`
  - `minBatteryMarginKmUntilNextCharge`

## 6. demo 資料來源檔案

- 排程資料取得（reservation、driver、shift）：
  - `core/zemo-client.js`
- API 端點與連線設定：
  - `config/zemo-api.json`

說明：`scheduler-web-demo` 主要是呼叫 API 取資料，不是使用本地固定 mock 檔。
