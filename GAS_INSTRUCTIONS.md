# スプレッドシート連携（クラウド同期）セットアップ手順

この手順を行うことで、複数端末（スマホ・タブレット・PC）で在庫や売上データをリアルタイムに共有できるようになります。
※各利用者がご自身のGoogleアカウントでスプレッドシートを作成するため、他人にデータが見られることはありません。

## 1. Googleスプレッドシートの準備
1. [Googleスプレッドシート](https://sheets.google.com/)を開き、新しいスプレッドシートを**空で作成**します。
2. ファイル名は分かりやすい名前（例：`自販機管理データ`）に変更しておきます。

## 2. Google Apps Script (GAS) の設定
1. スプレッドシートの上部メニューから **「拡張機能」→「Apps Script」** をクリックします。
2. 開いたエディタにある `function myFunction() { ... }` をすべて削除し、**以下のコードをすべてコピー＆ペースト**してください。
3. **【セキュリティ強化（任意）】** コード先頭の `const SECRET_TOKEN = "";` に好きな合言葉（例: `"my-secret-1234"`）を入力し、アプリ側の「通信の合言葉」にも同じ文字を設定すると、万が一URLが漏れても第三者からの不正アクセスを完全にブロックできます（空欄 `""` のままでも利用可能です）。

```javascript
/*
 * 自動販売機アプリ用クラウド同期プログラム (GAS) - v2.4 (セキュリティ・排他ロック強化版)
 */

// 通信の合言葉（任意：設定する場合はアプリ側の「通信の合言葉」と一致させてください）
const SECRET_TOKEN = "";

function doGet(e) {
  // 合言葉が設定されている場合は照合を行う
  const reqToken = (e && e.parameter && e.parameter.token) ? e.parameter.token : "";
  if (SECRET_TOKEN && reqToken !== SECRET_TOKEN) {
    return ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lockerSheet = getOrCreateSheet(ss, "lockers");
  const salesSheet = getOrCreateSheet(ss, "sales");
  const metaSheet = getOrCreateSheet(ss, "meta");

  const result = {
    lockers: getRowsAsObjects(lockerSheet),
    sales: getRowsAsObjects(salesSheet),
    presets: getMetaValue(metaSheet, "presets"),
    pricePresets: getMetaValue(metaSheet, "pricePresets"),
    machineCount: getMetaValue(metaSheet, "machineCount"),
    machineNames: getMetaValue(metaSheet, "machineNames"),
    oneClickMode: getMetaValue(metaSheet, "oneClickMode"),
    lastActiveTime: getMetaValue(metaSheet, "lastActiveTime")
  };

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  // 複数端末からの同時書き込みによるデータ破損を防ぐため排他ロックを取得
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const params = JSON.parse(e.postData.contents);

    // 合言葉が設定されている場合は照合を行う
    const reqToken = params.token || "";
    if (SECRET_TOKEN && reqToken !== SECRET_TOKEN) {
      return ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (params.lockers) updateSheetFromObjects(getOrCreateSheet(ss, "lockers"), params.lockers);
    if (params.sales) updateSheetFromObjects(getOrCreateSheet(ss, "sales"), params.sales);

    const metaSheet = getOrCreateSheet(ss, "meta");
    if (params.presets !== undefined) setMetaValue(metaSheet, "presets", params.presets);
    if (params.pricePresets !== undefined) setMetaValue(metaSheet, "pricePresets", params.pricePresets);
    if (params.machineCount !== undefined) setMetaValue(metaSheet, "machineCount", params.machineCount);
    if (params.machineNames !== undefined) setMetaValue(metaSheet, "machineNames", params.machineNames);
    if (params.oneClickMode !== undefined) setMetaValue(metaSheet, "oneClickMode", params.oneClickMode);

    setMetaValue(metaSheet, "lastActiveTime", Date.now());

    return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// --- ユーティリティ関数 ---

function getOrCreateSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) { sheet = ss.insertSheet(name); }
  return sheet;
}

function getRowsAsObjects(sheet) {
  const range = sheet.getDataRange();
  const values = range.getValues();
  const displayValues = range.getDisplayValues(); // 見た目通りの文字列を取得
  if (values.length < 2) return [];

  const headers = values[0];
  return values.slice(1).map((row, rowIndex) => {
    let obj = {};
    headers.forEach((h, i) => {
      let val = row[i];
      // coordNumやidが日付として誤認されている場合、表示文字列(1-1など)を採用する
      if (h === "coordNum" || h === "id") {
        val = displayValues[rowIndex + 1][i];
      }
      if (h === "isLocked" || h === "hasBonus") {
        val = (val === true || val === "true" || displayValues[rowIndex + 1][i] === "TRUE");
      }
      obj[h] = val;
    });
    return obj;
  });
}

function updateSheetFromObjects(sheet, objects) {
  sheet.clear();
  if (!objects || objects.length === 0) return;

  // 全データからヘッダー（列名）を収集
  const headerSet = {};
  objects.forEach(obj => {
    Object.keys(obj).forEach(key => { headerSet[key] = true; });
  });
  const headers = Object.keys(headerSet);

  sheet.appendRow(headers);
  const rows = objects.map(obj => headers.map(h => {
    let val = obj[h];
    // スプレッドシートの数式インジェクション対策（=,+,-,@で始まる文字列を無害化）
    if (typeof val === "string" && /^[=+\-@]/.test(val)) {
      val = " " + val;
    }
    return val;
  }));
  const range = sheet.getRange(2, 1, rows.length, headers.length);
  range.setNumberFormat("@"); // 文字列として強制指定
  range.setValues(rows);
}

function getMetaValue(sheet, key) {
  const data = sheet.getDataRange().getValues();
  if (data.length === 0 || data[0][0] === "") return null;
  const row = data.find(r => r[0] === key);
  if (!row) return null;
  try { return JSON.parse(row[1]); } catch (e) { return row[1]; }
}

function setMetaValue(sheet, key, value) {
  const data = sheet.getDataRange().getValues();
  const rowIndex = data.findIndex(r => r[0] === key);
  const valStr = JSON.stringify(value);
  if (rowIndex === -1) {
    sheet.appendRow([key, valStr]);
  } else {
    sheet.getRange(rowIndex + 1, 2).setValue(valStr);
  }
}
```

## 3. Webアプリとして公開
1. エディタ右上の **「デプロイ」→「新しいデプロイ」** をクリックします。
2. 種類の選択（歯車アイコン）で **「Webアプリ」** を選びます。
3. 設定を以下のようにします：
   - **説明**: 任意（例: 自販機同期）
   - **次のユーザーとして実行**: **「自分」**
   - **アクセスできるユーザー**: **「全員」**（※ブラウザから直接通信するために必要です）
4. **「デプロイ」** をクリックします。
5. 「承認が必要です」と出たら、ご自身のGoogleアカウントを選んで許可してください。
   - ※「このアプリは確認されていません」と出た場合は、「詳細」→「（プロジェクト名）に移動」をクリックして進めます。
6. デプロイ完了後、**「ウェブアプリのURL」**（`https://script.google.com/macros/s/.../exec`）が表示されますので、これをコピーしてください。

## 4. アプリでの設定
1. 自販機アプリを開きます。
2. 画面上部の **「管理」タブ → 「データ・保護」タブ** を開きます。
3. 「クラウド同期（Googleスプレッドシート）」の **「編集」** ボタンを押します。
4. コピーした **「ウェブアプリのURL」**（およびGAS側で設定した場合は **「通信の合言葉」**）を入力して **「保存」** を押します。

以上で、クラウド同期が開始されます！

## 5. うまくいかない場合（トラブルシューティング）
「データ取得に失敗しました」と表示される場合は、以下を順に確認してください。

### ① URLが正しいか
貼り付けたURLが `https://script.google.com/macros/s/` で始まり、最後が **`/exec`** で終わっていますか？
- **⭕ 正しい例**: `https://script.google.com/macros/s/XXXXX.../exec`
- **❌ 間違い**: スプレッドシート自体のURL、または `/dev` で終わるテスト用URLを貼っている。

### ② デプロイの設定が正しいか
新しいデプロイを作成する際、以下の2点を確認してください。
- **次のユーザーとして実行**: **「自分」**
- **アクセスできるユーザー**: **「全員」**

### ③ コードを変更した後は「新しいデプロイ」または「デプロイを管理」で新バージョンにする
GASのコード（`SECRET_TOKEN` など）を書き換えた場合は、保存（Ctrl+S）した後に **「デプロイ」→「デプロイを管理」→ 鉛筆アイコン → バージョンを「新バージョン」にして「デプロイ」** を押すと反映されます。
