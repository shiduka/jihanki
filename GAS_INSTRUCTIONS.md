# スプレッドシート連携（クラウド同期）セットアップ手順

この手順を行うことで、複数端末（スマホやPC）でデータをリアルタイムに共有できるようになります。

## 1. Googleスプレッドシートの準備
1. [Googleスプレッドシート](https://sheets.google.com/)を開き、新しいスプレッドシートを**空で作成**します。
2. 作成したスプレッドシートのURL（ブラウザのアドレスバーの内容）をどこかにメモしておいてください。

## 2. Google Apps Script (GAS) の設定
1. スプレッドシートのメニューから **「拡張機能」→「Apps Script」** をクリックします。
2. 開いたエディタにある `function myFunction() { ... }` をすべて削除し、**以下のコードをすべてコピー＆ペースト**してください。

```javascript
/*
 * 自動販売機アプリ用クラウド同期プログラム (GAS) - v2 (Heartbeat対応版)
 */

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const lockerSheet = getOrCreateSheet(ss, "lockers");
  const salesSheet = getOrCreateSheet(ss, "sales");
  const metaSheet = getOrCreateSheet(ss, "meta");
  
  const result = {
    lockers: getRowsAsObjects(lockerSheet),
    sales: getRowsAsObjects(salesSheet),
    presets: getMetaValue(metaSheet, "presets"),
    machineCount: getMetaValue(metaSheet, "machineCount"),
    oneClickMode: getMetaValue(metaSheet, "oneClickMode"),
    lastActiveTime: getMetaValue(metaSheet, "lastActiveTime") // 全体の最終操作
  };
  
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const params = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  if (params.lockers) updateSheetFromObjects(getOrCreateSheet(ss, "lockers"), params.lockers);
  if (params.sales) updateSheetFromObjects(getOrCreateSheet(ss, "sales"), params.sales);
  
  const metaSheet = getOrCreateSheet(ss, "meta");
  if (params.presets !== undefined) setMetaValue(metaSheet, "presets", params.presets);
  if (params.machineCount !== undefined) setMetaValue(metaSheet, "machineCount", params.machineCount);
  if (params.oneClickMode !== undefined) setMetaValue(metaSheet, "oneClickMode", params.oneClickMode);
  
  // 最終操作時刻を記録
  setMetaValue(metaSheet, "lastActiveTime", Date.now());
  
  return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// --- 以下、ユーティリティ関数 ---

function getOrCreateSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function getRowsAsObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    let obj = {};
    headers.forEach((h, i) => {
      let val = row[i];
      if (h === 'isLocked') val = (val === true || val === "true");
      obj[h] = val;
    });
    return obj;
  });
}

function updateSheetFromObjects(sheet, objects) {
  sheet.clear();
  if (!objects || objects.length === 0) return;
  const headers = Object.keys(objects[0]);
  sheet.appendRow(headers);
  const rows = objects.map(obj => headers.map(h => obj[h]));
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
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
   - **実行専用ユーザー**: **「自分」**
   - **アクセスできるユーザー**: **「全員」**（← これが重要です）
4. **「デプロイ」** をクリックします。
5. 「承認が必要です」と出たら、あなたのGoogleアカウントを選んで許可してください。
   - ※「このアプリは確認されていません」と出た場合は、「詳細」→「（プロジェクト名）に移動」をクリックして進めます。
6. デプロイ完了後、**「ウェブアプリのURL」** が表示されますので、これをコピーしてください。

## 4. アプリでの設定
1. 自販機アプリ（GitHub上のもの、またはお手元のファイル）を開きます。
2. 管理メニュー（⚙️）→「データ」または「自販機設定」タブに新しく追加される **「クラウド同期設定」** を探します。
3. 先ほどコピーした **「ウェブアプリのURL」** を貼り付けて「保存」します。

以上で、クラウド同期が開始されます！

## 5. うまくいかない場合（トラブルシューティング）
「データ取得に失敗しました」と表示される場合は、以下を順に確認してください。

### ① URLが正しいか
貼り付けたURLの最後が **`/exec`** で終わっていますか？
- **⭕ 正しい例**: `https://script.google.com/macros/s/XXXXX.../exec`
- **❌ 間違い**: スプレッドシート自身のURL、またはGASエディタの画面のURLを貼っている。

### ② デプロイの設定が正しいか
新しいデプロイを作成し直す際、以下の2点を確認してください。
- **次のユーザーとして実行**: **「自分」**
- **アクセスできるユーザー**: **「全員」**（Googleアカウントを持たない人も含めて、誰でも実行できる設定にする必要があります）

### ③ デプロイの完了を確認
デプロイ後、そのURLをブラウザの新しいタブで直接開いてみてください。
うまく設定できていれば、画面に `{"lockers": [], "sales": [], ...}` のような英数字から始まる文字が表示されます。何も表示されない、またはエラーが出る場合は、デプロイ手順を見直してください。
