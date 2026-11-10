# 小豬帳本

離線優先的多幣別記帳與資產總覽 PWA。純 HTML／CSS／JavaScript，不使用框架。

## P1～P3 功能

- 帳戶管理與開帳精靈
- 支出、收入、轉帳、投資買入／賣出
- 多幣別手動匯率與台幣淨資產換算
- IndexedDB 離線資料與待送清單
- n8n Sync／Write 雙向同步、去重、衝突與失敗處理
- 固定支出、持倉與手機／桌面響應式畫面
- PWA App Shell 快取
- App 內建記帳說明：信用卡、保險、投資、外幣與避免重複計算
- 收據照片以 Gemini Flash 辨識後回填表單，仍由使用者確認才儲存
- 信用卡消費對帳（修改原交易）與一鍵建立繳卡費轉帳
- 到期固定支出自動產生，使用固定同步編號防止重複
- 自動匯率、台股／加密貨幣報價、每日淨資產快照與趨勢圖

## 連線碼從哪裡來

連線碼不是向 Notion、GitHub 或第三方申請的 token，而是使用者自己替 App 與 n8n 設定的一組共用密碼：

1. 在 n8n 建立 `Header Auth` credential，建議命名為 `小豬帳本 App 連線碼`。
2. Header Name 固定填 `x-webhook-token`。
3. Value 自訂一組 24～32 位英數密碼。
4. Piggy Sync／Write／Receipt／Prices 的 Webhook 都選同一個 credential。
5. App「更多 → 設定 → 連線碼」填相同的 Value。

n8n 基於安全不會顯示已儲存的舊值；忘記時直接換新值即可。

## 報價來源

- TWD／THB／USD／JPY：ExchangeRate-API 開放匯率，每日資料。
- 台股：TWSE OpenAPI `STOCK_DAY_ALL`。
- 加密貨幣：CoinGecko Simple Price；公開額度不足時需 Demo API Key。
- 美股：已保留 Finnhub 接口，需設定 API Key。
- 泰國基金：已保留 Thai SEC 接口，需 Subscription Key 與基金 project id。

## 安全

程式碼不包含連線碼、Notion token 或任何報價 API 金鑰。連線碼只由使用者在設定頁輸入，並存在該裝置的 IndexedDB。

## 本機執行

```bash
python -m http.server 4173
```

開啟 `http://127.0.0.1:4173/`。沒有連線碼時仍可完整測試離線記帳與待送清單。
