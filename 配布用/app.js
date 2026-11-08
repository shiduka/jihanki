/**
 * 自動販売機管理アプリ（配布用・セキュリティ強化版）
 * ロッカー型自動販売機の在庫・売上・設定管理ロジック
 */

// 定数定義（既存環境と干渉しないよう専用のストレージキーを使用）
const STORAGE_KEY = 'vending_machine_data_dist';
const DEFAULT_PRESETS = ['大玉トマト', '中玉トマト', 'ミニトマト', 'レタス', 'いちご', 'キュウリ'];
const TOTAL_ROWS = 6;
const TOTAL_COLS = 3;
const DEFAULT_PRICE_PRESETS = [100, 150, 200, 300, 400, 500];

// 状態管理オブジェクト
let state = {
    // 永続化対象データ
    data: {
        lockers: [],
        sales: [],
        presets: [...DEFAULT_PRESETS],
        pricePresets: [...DEFAULT_PRICE_PRESETS],
        machineCount: 2,
        machineNames: {}, // 例: { "1": "店舗前", "2": "駐車場" }
        cloudUrl: '',
        cloudToken: '',   // クラウド同期用の合言葉（任意）
        adminPinHash: '', // 管理画面ロック用の暗証番号ハッシュ（任意）
        autoSync: true,
        oneClickMode: true // 配布用の初期状態はオン
    },
    // UI状態（保存しない一時データ）
    currentMachine: 1,
    mode: 'seller', // 'buyer' | 'seller' | 'admin'
    selectedLockerId: null,
    tempPrice: 100,
    tempAmount: 0,
    selectedPresets: [],
    // コピーモード状態
    copyMode: false,
    copyProduct: null,
    copySourceLockerId: null,
    lastPurchase: null,
    isSyncing: false,
    lastLocalEditTime: 0,
    isDirty: false, // クラウドへの送信待ちフラグ
    adminTargetMonth: '' // 管理画面で表示する対象月(YYYY-MM)
};

// グラフインスタンス保持用
let productChartInst = null;
let timeChartInst = null;

// アプリ初期化
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    initLockers();
    renderApp();
    setupEventListeners();

    if (state.data.cloudUrl && isValidCloudUrl(state.data.cloudUrl)) {
        fetchFromCloud();
    }

    // 定期クラウド同期（15秒間隔）
    setInterval(() => {
        const isModalOpen = !document.getElementById('seller-modal').classList.contains('hidden') ||
            !document.getElementById('buyer-modal').classList.contains('hidden') ||
            !document.getElementById('pin-modal').classList.contains('hidden');

        // モーダル編集中、コピーモード中、または未送信データがある場合は上書き防止のため同期しない
        if (state.data.cloudUrl && isValidCloudUrl(state.data.cloudUrl) && state.data.autoSync && !state.copyMode && !isModalOpen && !state.isDirty) {
            fetchFromCloud(true);
        }
    }, 15000);
});

/**
 * 文字列のサニタイズ（スプレッドシート数式インジェクション対策および長さ制限）
 */
function sanitizeText(str, maxLength = 50) {
    if (typeof str !== 'string') return '';
    let cleaned = str.trim().slice(0, maxLength);
    // 先頭が「=」「+」「-」「@」で始まる場合、表計算ソフトでの数式実行を防ぐため全角に変換または除去
    if (/^[=+\-@]/.test(cleaned)) {
        cleaned = ' ' + cleaned;
    }
    return cleaned;
}

/**
 * Google Apps ScriptのWebアプリURLとして妥当か検証する（SSRF・不正通信防止）
 */
function isValidCloudUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' &&
            parsed.hostname === 'script.google.com' &&
            parsed.pathname.startsWith('/macros/s/') &&
            parsed.pathname.endsWith('/exec');
    } catch (e) {
        return false;
    }
}

/**
 * 暗証番号（PIN）の簡易ハッシュ化（平文保存の防止）
 */
async function hashPin(pin) {
    const text = `jihanki_pin_salt_${pin}`;
    if (window.crypto && window.crypto.subtle) {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(text);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            // ローカルファイル(file://)等でWeb Crypto APIが制限されている場合はフォールバックへ
        }
    }
    // フォールバックハッシュ計算
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash) + text.charCodeAt(i);
        hash = hash & hash;
    }
    return 'fb_' + Math.abs(hash).toString(16);
}

/**
 * 外部（JSONファイルまたはクラウド）から受け取ったデータの検証・無害化
 */
function sanitizeImportedData(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const clean = {};

    // 自販機台数の検証（1〜20台の範囲に制限）
    let mCount = parseInt(raw.machineCount, 10);
    if (isNaN(mCount) || mCount < 1) mCount = 2;
    if (mCount > 20) mCount = 20;
    clean.machineCount = mCount;

    // ロッカー配列の検証
    if (Array.isArray(raw.lockers)) {
        clean.lockers = raw.lockers.map(l => {
            const mId = Math.max(1, Math.min(20, parseInt(l.machineId, 10) || 1));
            const row = Math.max(1, Math.min(TOTAL_ROWS, parseInt(l.row, 10) || 1));
            const col = Math.max(1, Math.min(TOTAL_COLS, parseInt(l.col, 10) || 1));
            const coordNum = (typeof l.coordNum === 'string' && /^\d+-\d+$/.test(l.coordNum))
                ? l.coordNum
                : `${col}-${row}`;
            const rawProducts = typeof l.productName === 'string' ? l.productName : '';
            const safeProducts = rawProducts
                .split('\n')
                .map(p => sanitizeText(p, 30))
                .filter(p => p)
                .slice(0, 3)
                .join('\n');
            const price = Math.max(0, Math.min(100000, parseInt(l.price, 10) || 0));
            const isLocked = (l.isLocked === true || l.isLocked === 'true') && safeProducts.length > 0;

            return {
                id: `${mId}-${row}-${col}`,
                machineId: mId,
                machineNum: mId,
                row: row,
                col: col,
                coordNum: coordNum,
                isLocked: isLocked,
                productName: isLocked ? safeProducts : '',
                price: isLocked ? price : 0,
                hasBonus: isLocked ? (l.hasBonus === true || l.hasBonus === 'true') : false,
                insertedAmount: 0
            };
        });
    } else {
        clean.lockers = [];
    }

    // 売上データの検証
    if (Array.isArray(raw.sales)) {
        clean.sales = raw.sales.map(s => {
            const price = Math.max(0, Math.min(100000, parseInt(s.price, 10) || 0));
            const mId = Math.max(1, Math.min(20, parseInt(s.machineId, 10) || 1));
            const mNum = Math.max(1, Math.min(20, parseInt(s.machineNum || s.machineId, 10) || 1));
            const coordNum = (typeof s.coordNum === 'string' && /^\d+-\d+$/.test(s.coordNum)) ? s.coordNum : '';
            const safeName = (typeof s.productName === 'string' ? s.productName : '')
                .split('\n')
                .map(p => sanitizeText(p, 30))
                .filter(p => p)
                .slice(0, 3)
                .join('\n');
            const safeDate = (typeof s.date === 'string' && !isNaN(new Date(s.date).getTime()))
                ? s.date
                : getJSTDateTime();
            const safeId = (typeof s.id === 'number' || typeof s.id === 'string')
                ? String(s.id).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40)
                : String(Date.now() + Math.random());

            return {
                id: safeId || String(Date.now() + Math.random()),
                date: safeDate,
                productName: safeName || '商品',
                price: price,
                machineId: mId,
                machineNum: mNum,
                coordNum: coordNum,
                hasBonus: s.hasBonus === true || s.hasBonus === 'true'
            };
        });
    } else {
        clean.sales = [];
    }

    // 商品名プリセットの検証
    if (Array.isArray(raw.presets) && raw.presets.length > 0) {
        clean.presets = raw.presets
            .map(p => sanitizeText(String(p), 30))
            .filter(p => p)
            .slice(0, 50);
    }
    if (!clean.presets || clean.presets.length === 0) {
        clean.presets = [...DEFAULT_PRESETS];
    }

    // 金額プリセットの検証
    if (Array.isArray(raw.pricePresets) && raw.pricePresets.length > 0) {
        clean.pricePresets = raw.pricePresets
            .map(p => parseInt(p, 10))
            .filter(p => !isNaN(p) && p > 0 && p <= 100000)
            .slice(0, 30);
    }
    if (!clean.pricePresets || clean.pricePresets.length === 0) {
        clean.pricePresets = [...DEFAULT_PRICE_PRESETS];
    }

    // 自販機名称の検証
    clean.machineNames = {};
    if (raw.machineNames && typeof raw.machineNames === 'object') {
        Object.keys(raw.machineNames).forEach(k => {
            const mNum = parseInt(k, 10);
            if (!isNaN(mNum) && mNum >= 1 && mNum <= 20) {
                const name = sanitizeText(String(raw.machineNames[k] || ''), 20);
                if (name) clean.machineNames[mNum] = name;
            }
        });
    }

    // ワンクリック購入モード
    if (raw.oneClickMode !== undefined) {
        clean.oneClickMode = (raw.oneClickMode === true || raw.oneClickMode === 'true');
    }

    return clean;
}

/**
 * ローカルストレージからデータを読み込む
 */
function loadData() {
    const json = localStorage.getItem(STORAGE_KEY);
    if (json) {
        try {
            const parsed = JSON.parse(json);
            const sanitized = sanitizeImportedData(parsed);
            if (sanitized) {
                state.data = {
                    ...state.data,
                    ...sanitized,
                    cloudUrl: isValidCloudUrl(parsed.cloudUrl) ? parsed.cloudUrl : '',
                    cloudToken: typeof parsed.cloudToken === 'string' ? parsed.cloudToken.slice(0, 64) : '',
                    adminPinHash: typeof parsed.adminPinHash === 'string' ? parsed.adminPinHash : '',
                    autoSync: parsed.autoSync !== undefined ? Boolean(parsed.autoSync) : true
                };
                if (state.data.oneClickMode === undefined) {
                    state.data.oneClickMode = true;
                }
            }
        } catch (e) {
            console.error('データ読み込みエラー', e);
        }
    }

    // デフォルトONへの自動移行（過去の保存データでfalseになっている既存環境の更新）
    const migrationKey = `${STORAGE_KEY}_oneclick_init_v1`;
    if (!localStorage.getItem(migrationKey)) {
        state.data.oneClickMode = true;
        localStorage.setItem(migrationKey, 'true');
        saveData();
    }
}

/**
 * ローカルストレージへ保存し、クラウド設定があれば送信する
 */
function saveData() {
    state.lastLocalEditTime = Date.now();
    state.isDirty = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    if (state.data.cloudUrl && isValidCloudUrl(state.data.cloudUrl)) {
        pushToCloud();
    }
}

/**
 * ロッカーデータの初期化および整列
 */
function initLockers() {
    const isOrderCorrect = state.data.lockers.length > 0 &&
        state.data.lockers[0].col === 3 &&
        state.data.lockers[0].row === 1;

    if (state.data.lockers.length === 0 || !state.data.lockers[0].coordNum || !isOrderCorrect) {
        if (state.data.lockers.length > 0) {
            sortLockersCorrectly();
        } else {
            state.data.lockers = [];
            for (let m = 1; m <= state.data.machineCount; m++) {
                createLockersForMachine(m);
            }
        }
    } else {
        const existingMachineIds = new Set(state.data.lockers.map(l => l.machineId));
        for (let m = 1; m <= state.data.machineCount; m++) {
            if (!existingMachineIds.has(m)) createLockersForMachine(m);
        }
    }

    // 座標番号・自販機番号の補完
    state.data.lockers.forEach(l => {
        if (!l.coordNum) l.coordNum = `${l.col}-${l.row}`;
        if (!l.machineNum) l.machineNum = l.machineId;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}

/**
 * ロッカー配列を右上(1-1: col=3, row=1)から正しい順序に並び替える
 */
function sortLockersCorrectly() {
    state.data.lockers.sort((a, b) => {
        if (a.machineId !== b.machineId) return a.machineId - b.machineId;
        if (a.row !== b.row) return a.row - b.row;
        return b.col - a.col;
    });
}

/**
 * 指定した自販機番号のロッカー（18個）を生成する
 */
function createLockersForMachine(m) {
    for (let r = 1; r <= TOTAL_ROWS; r++) {
        for (let c = TOTAL_COLS; c >= 1; c--) {
            state.data.lockers.push({
                id: `${m}-${r}-${c}`,
                machineId: m,
                machineNum: m,
                row: r,
                col: c,
                coordNum: `${c}-${r}`,
                isLocked: false,
                productName: '',
                price: 0,
                hasBonus: false,
                insertedAmount: 0
            });
        }
    }
}

/**
 * 自販機の表示名を取得する
 */
function getMachineName(m) {
    return state.data.machineNames[m] || `自販機${m}`;
}

/**
 * アプリ全体の描画更新
 */
function renderApp() {
    renderHeader();
    renderMachineTabs();

    const vendingView = document.getElementById('vending-view');
    const adminView = document.getElementById('admin-view');
    const machineSwitch = document.getElementById('machine-switch');

    if (state.mode === 'admin') {
        vendingView.classList.add('hidden');
        machineSwitch.style.display = 'none';
        adminView.classList.remove('hidden');
        renderAdminSales();
        renderAdminPresets();
        renderAdminPricePresets();
        renderMachineSettings();
        renderDataSettings();
        renderAnalytics();
    } else {
        vendingView.classList.remove('hidden');
        machineSwitch.style.display = '';
        adminView.classList.add('hidden');
        renderLockers();
        renderBulkPurchaseArea();
        renderSalesSummary();
        renderCopyModeIndicator();
    }
}

/**
 * ヘッダーのモードボタン状態を更新する
 */
function renderHeader() {
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`mode-${state.mode}`);
    if (activeBtn) activeBtn.classList.add('active');
}

/**
 * 自販機切り替えタブを描画する
 */
function renderMachineTabs() {
    const container = document.getElementById('machine-switch');
    container.innerHTML = '';

    for (let m = 1; m <= state.data.machineCount; m++) {
        const btn = document.createElement('button');
        btn.className = `machine-tab ${m === state.currentMachine ? 'active' : ''}`;
        btn.dataset.machine = m;
        btn.textContent = getMachineName(m);
        btn.onclick = () => {
            state.currentMachine = m;
            renderApp();
        };
        container.appendChild(btn);
    }
}

/**
 * ロッカーグリッドを描画する（DOM APIによる安全な要素構築）
 */
function renderLockers() {
    const grid = document.getElementById('locker-grid');
    grid.innerHTML = '';

    const targetLockers = state.data.lockers.filter(l => l.machineId === state.currentMachine);

    targetLockers.forEach(locker => {
        const el = document.createElement('div');
        let classes = 'locker';
        if (locker.isLocked) classes += ' locked';
        if (state.copyMode && !locker.isLocked) classes += ' copy-target';
        if (state.copyMode && state.copySourceLockerId === locker.id) classes += ' copy-source';
        el.className = classes;
        el.dataset.id = locker.id;
        el.onclick = () => handleLockerClick(locker);

        const idSpan = document.createElement('span');
        idSpan.className = 'locker-id';
        idSpan.textContent = locker.coordNum;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'locker-content';

        if (locker.isLocked) {
            const products = String(locker.productName || '').split('\n').filter(p => p.trim());
            const productCount = products.length;
            let fontSizeClass = '';
            if (productCount >= 3) fontSizeClass = ' locker-product-sm';
            else if (productCount >= 2) fontSizeClass = ' locker-product-md';

            const priceNum = Number(locker.price) || 0;
            const priceColorClass = getPriceColorClass(priceNum);
            if (priceColorClass) el.classList.add(priceColorClass);

            const productDiv = document.createElement('div');
            productDiv.className = `locker-product${fontSizeClass}`;
            products.forEach((p, idx) => {
                if (idx > 0) productDiv.appendChild(document.createElement('br'));
                productDiv.appendChild(document.createTextNode(p));
            });

            const priceDiv = document.createElement('div');
            priceDiv.className = 'locker-price';
            priceDiv.textContent = `¥${priceNum}`;

            contentDiv.append(productDiv, priceDiv);

            if (locker.hasBonus === true || locker.hasBonus === 'true') {
                const bonusBadge = document.createElement('span');
                bonusBadge.className = 'bonus-badge';
                bonusBadge.textContent = '🎁';
                el.appendChild(bonusBadge);
            }
        } else {
            const statusSpan = document.createElement('span');
            statusSpan.className = 'locker-status';
            statusSpan.textContent = '空き';
            contentDiv.appendChild(statusSpan);
        }

        el.append(idSpan, contentDiv);
        grid.appendChild(el);
    });
}

/**
 * 一括購入・一括削除ボタンの表示制御
 */
function renderBulkPurchaseArea() {
    const area = document.getElementById('bulk-purchase-area');
    const btn = document.getElementById('bulk-purchase-btn');
    const clearAllArea = document.getElementById('bulk-clear-area');
    const hasProducts = state.data.lockers.some(l => l.machineId === state.currentMachine && l.isLocked);

    if (state.mode === 'buyer') {
        if (hasProducts) {
            area.classList.remove('hidden');
            btn.disabled = false;
        } else {
            area.classList.add('hidden');
        }
    } else {
        area.classList.add('hidden');
    }

    if (clearAllArea) {
        if (state.mode === 'seller' && hasProducts) {
            clearAllArea.classList.remove('hidden');
        } else {
            clearAllArea.classList.add('hidden');
        }
    }
}

/**
 * 販売者モード上部の前日・今日売上サマリーを描画する
 */
function renderSalesSummary() {
    const summary = document.getElementById('sales-summary');
    const yesterdayEl = document.getElementById('yesterday-sales');
    const todayEl = document.getElementById('today-sales');

    if (state.mode === 'seller') {
        summary.classList.remove('hidden');

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

        let todayTotal = 0;
        let yesterdayTotal = 0;

        state.data.sales.forEach(sale => {
            const saleDate = new Date(sale.date);
            const saleDateOnly = new Date(saleDate.getFullYear(), saleDate.getMonth(), saleDate.getDate());

            if (saleDateOnly.getTime() === today.getTime()) {
                todayTotal += Number(sale.price) || 0;
            } else if (saleDateOnly.getTime() === yesterday.getTime()) {
                yesterdayTotal += Number(sale.price) || 0;
            }
        });

        yesterdayEl.textContent = `¥${yesterdayTotal.toLocaleString()}`;
        todayEl.textContent = `¥${todayTotal.toLocaleString()}`;
    } else {
        summary.classList.add('hidden');
    }
}

/**
 * イベントリスナーの登録
 */
function setupEventListeners() {
    document.getElementById('mode-buyer').onclick = () => setMode('buyer');
    document.getElementById('mode-seller').onclick = () => setMode('seller');
    document.getElementById('mode-admin').onclick = () => requestAdminMode();

    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.onclick = () => closeModal();
    });

    window.onclick = (event) => {
        if (event.target.classList.contains('modal')) {
            closeModal();
        }
    };

    // 購入者モーダル
    document.getElementById('insert-coin-btn').onclick = () => {
        state.tempAmount += 100;
        updateBuyerModalUI();
    };
    document.getElementById('unlock-btn').onclick = processPurchase;

    // 販売者モーダル
    document.getElementById('register-btn').onclick = registerProduct;
    document.getElementById('admin-purchase-btn').onclick = processAdminPurchase;
    document.getElementById('clear-locker-btn').onclick = clearLocker;
    document.getElementById('copy-product-btn').onclick = startCopyMode;
    document.getElementById('cancel-copy-btn').onclick = cancelCopyMode;
    document.getElementById('add-product-btn').onclick = () => addProductInputRow('');

    document.getElementById('clear-product-input-btn').onclick = () => {
        state.selectedPresets = [];
        const container = document.getElementById('product-inputs-container');
        container.innerHTML = '';
        addProductInputRow('');
        renderPresetButtons();
    };

    document.getElementById('bulk-purchase-btn').onclick = processBulkPurchase;
    const bulkClearBtn = document.getElementById('bulk-clear-btn');
    if (bulkClearBtn) bulkClearBtn.onclick = processBulkClear;

    // 管理タブ内のサブタブ切り替え
    const tabs = document.querySelectorAll('#admin-view .tab-btn');
    tabs.forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('#admin-view .tab-btn').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('#admin-view .tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
            if (tab.dataset.tab === 'analytics') renderAnalytics();
        };
    });

    // プリセット設定
    document.getElementById('add-preset-btn').onclick = addPreset;
    const addPricePresetBtn = document.getElementById('add-price-preset-btn');
    if (addPricePresetBtn) addPricePresetBtn.onclick = addPricePreset;

    // 自販機追加・削除
    document.getElementById('add-machine-btn').onclick = addMachine;
    document.getElementById('remove-machine-btn').onclick = removeMachine;

    // データの入出力・初期化
    document.getElementById('download-data-btn').onclick = downloadData;
    document.getElementById('upload-data-btn').onclick = () => document.getElementById('upload-data-input').click();
    document.getElementById('upload-data-input').onchange = uploadData;
    document.getElementById('clear-all-sales-btn').onclick = clearAllSales;
    document.getElementById('factory-reset-btn').onclick = factoryReset;

    // 管理画面PIN設定・認証イベント
    document.getElementById('save-pin-btn').onclick = saveAdminPin;
    document.getElementById('clear-pin-btn').onclick = clearAdminPin;
    document.getElementById('pin-verify-btn').onclick = verifyAdminPin;
    document.getElementById('pin-verify-input').onkeydown = (e) => {
        if (e.key === 'Enter') verifyAdminPin();
    };

    // 月選択ピッカーの初期化とイベント
    const analyticsPicker = document.getElementById('analytics-month-picker');
    const salesPicker = document.getElementById('sales-month-picker');

    if (!state.adminTargetMonth) {
        const now = new Date();
        state.adminTargetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    const updateMonth = (e) => {
        state.adminTargetMonth = e.target.value;
        if (analyticsPicker) analyticsPicker.value = state.adminTargetMonth;
        if (salesPicker) salesPicker.value = state.adminTargetMonth;
        renderAdminSales();
        renderAnalytics();
    };

    if (analyticsPicker) {
        analyticsPicker.value = state.adminTargetMonth;
        analyticsPicker.onchange = updateMonth;
    }
    if (salesPicker) {
        salesPicker.value = state.adminTargetMonth;
        salesPicker.onchange = updateMonth;
    }

    // ワンクリック購入切り替え
    document.getElementById('one-click-toggle').onchange = (e) => {
        state.data.oneClickMode = e.target.checked;
        saveData();
    };

    // クラウドURL・合言葉の編集
    const displayArea = document.getElementById('cloud-url-display-area');
    const editArea = document.getElementById('cloud-url-edit-area');

    if (document.getElementById('edit-cloud-url-btn')) {
        document.getElementById('edit-cloud-url-btn').onclick = () => {
            displayArea.classList.add('hidden');
            editArea.classList.remove('hidden');
            document.getElementById('cloud-url-edit-input').value = state.data.cloudUrl || '';
            document.getElementById('cloud-token-edit-input').value = state.data.cloudToken || '';
        };
    }

    if (document.getElementById('cancel-cloud-url-btn')) {
        document.getElementById('cancel-cloud-url-btn').onclick = () => {
            editArea.classList.add('hidden');
            displayArea.classList.remove('hidden');
        };
    }

    if (document.getElementById('save-cloud-url-btn')) {
        document.getElementById('save-cloud-url-btn').onclick = () => {
            const url = document.getElementById('cloud-url-edit-input').value.trim();
            const token = document.getElementById('cloud-token-edit-input').value.trim();

            if (url && !isValidCloudUrl(url)) {
                alert('無効なURLです。\n「https://script.google.com/macros/s/.../exec」の形式のGoogle Apps Script WebアプリURLを入力してください。');
                return;
            }

            state.data.cloudUrl = url;
            state.data.cloudToken = token.slice(0, 64);
            saveData();
            editArea.classList.add('hidden');
            displayArea.classList.remove('hidden');
            renderMachineSettings();
            if (url) {
                alert('クラウド設定を保存しました。同期を開始します。');
                fetchFromCloud();
            } else {
                alert('クラウド同期を解除しました。');
            }
        };
    }

    document.getElementById('auto-sync-toggle').onchange = (e) => {
        state.data.autoSync = e.target.checked;
        saveData();
    };

    document.getElementById('manual-sync-btn').onclick = () => {
        if (!state.data.cloudUrl) return alert('クラウドURLが設定されていません');
        if (!isValidCloudUrl(state.data.cloudUrl)) return alert('設定されているクラウドURLの形式が正しくありません');
        fetchFromCloud();
    };
}

/**
 * 管理モードへの切り替え要求（暗証番号が設定されている場合は認証モーダルを表示）
 */
function requestAdminMode() {
    if (state.mode === 'admin') return;
    if (state.data.adminPinHash) {
        const pinInput = document.getElementById('pin-verify-input');
        pinInput.value = '';
        openModal('pin-modal');
        setTimeout(() => pinInput.focus(), 100);
    } else {
        setMode('admin');
    }
}

/**
 * 管理者PINコードの照合処理
 */
async function verifyAdminPin() {
    const pinInput = document.getElementById('pin-verify-input');
    const inputVal = pinInput.value.trim();
    if (!inputVal) return;

    const hashed = await hashPin(inputVal);
    if (hashed === state.data.adminPinHash) {
        pinInput.value = '';
        closeModal();
        setMode('admin');
    } else {
        alert('暗証番号が違います');
        pinInput.value = '';
        pinInput.focus();
    }
}

/**
 * 管理者PINコードの保存・変更処理
 */
async function saveAdminPin() {
    const input = document.getElementById('admin-pin-input');
    const pin = input.value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
        alert('暗証番号は4〜8桁の半角数字で入力してください');
        return;
    }
    state.data.adminPinHash = await hashPin(pin);
    input.value = '';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    renderDataSettings();
    alert('管理画面の暗証番号を設定しました');
}

/**
 * 管理者PINコードの解除処理
 */
function clearAdminPin() {
    if (!confirm('管理画面の暗証番号ロックを解除しますか？')) return;
    state.data.adminPinHash = '';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    renderDataSettings();
    alert('暗証番号ロックを解除しました');
}

/**
 * モード切替
 */
function setMode(mode) {
    state.mode = mode;
    state.copyMode = false;
    state.copyProduct = null;
    state.copySourceLockerId = null;
    renderApp();
}

/**
 * ロッカータップ時の処理
 */
function handleLockerClick(locker) {
    state.selectedLockerId = locker.id;

    if (state.copyMode) {
        if (!locker.isLocked) {
            pasteProduct(locker);
        } else {
            if (state.copyProduct &&
                locker.productName === state.copyProduct.productName &&
                locker.price === state.copyProduct.price &&
                locker.id !== state.copySourceLockerId) {

                updateLocker(locker.id, {
                    isLocked: false,
                    productName: '',
                    price: 0,
                    insertedAmount: 0
                });
                saveData();
                renderApp();
            }
        }
        return;
    }

    if (state.mode === 'seller') {
        openSellerModal(locker);
    } else if (state.mode === 'buyer') {
        if (locker.isLocked) {
            if (state.data.oneClickMode) {
                processQuickPurchase(locker);
            } else {
                openBuyerModal(locker);
            }
        }
    }
}

/**
 * 販売者用（商品登録・編集）モーダルを開く
 */
function openSellerModal(locker) {
    const adminPurchaseBtn = document.getElementById('admin-purchase-btn');
    const clearBtn = document.getElementById('clear-locker-btn');
    const registerBtn = document.getElementById('register-btn');
    const copyBtn = document.getElementById('copy-product-btn');
    const bonusToggle = document.getElementById('bonus-toggle');

    const inputContainer = document.getElementById('product-inputs-container');
    inputContainer.innerHTML = '';

    state.selectedPresets = [];
    state.tempPrice = state.data.pricePresets[0] || 100;
    let defaultBonus = false;
    let inputRowsAdded = 0;

    if (locker.isLocked) {
        const products = locker.productName.split('\n').filter(p => p.trim());
        products.forEach(p => {
            addProductInputRow(p);
            inputRowsAdded++;
        });
        if (inputRowsAdded === 0) addProductInputRow('');
        state.tempPrice = locker.price;
        adminPurchaseBtn.classList.remove('hidden');
        clearBtn.classList.remove('hidden');
        copyBtn.classList.remove('hidden');
        registerBtn.textContent = '更新';
        if (bonusToggle) bonusToggle.checked = locker.hasBonus || false;
    } else {
        if (state.data.lastRegistered) {
            const names = state.data.lastRegistered.names || [];
            names.forEach(n => {
                if (state.data.presets.includes(n)) {
                    state.selectedPresets.push(n);
                } else {
                    addProductInputRow(n);
                    inputRowsAdded++;
                }
            });
            state.tempPrice = state.data.lastRegistered.price || state.data.pricePresets[0] || 100;
            defaultBonus = state.data.lastRegistered.hasBonus || false;
        }

        if (inputRowsAdded === 0) addProductInputRow('');

        adminPurchaseBtn.classList.add('hidden');
        clearBtn.classList.add('hidden');
        copyBtn.classList.add('hidden');
        registerBtn.textContent = '登録して施錠';
        if (bonusToggle) bonusToggle.checked = defaultBonus;
    }

    renderPresetButtons();
    renderPriceButtons();
    updateAddProductBtnVisibility();
    updatePriceDisplay();
    updatePriceButtonSelection();
    openModal('seller-modal');
}

/**
 * 商品名直接入力欄の行を追加する
 */
function addProductInputRow(value) {
    const container = document.getElementById('product-inputs-container');
    const currentRows = container.querySelectorAll('.product-input-row');
    if (currentRows.length >= 3) return;

    const row = document.createElement('div');
    row.className = 'product-input-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'product-name-input';
    input.placeholder = '商品名を入力';
    input.maxLength = 30;
    input.value = value || '';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-input-btn';
    removeBtn.textContent = '✕';
    removeBtn.onclick = () => {
        const rows = container.querySelectorAll('.product-input-row');
        if (rows.length > 1) {
            row.remove();
            updateAddProductBtnVisibility();
        }
    };

    row.append(input, removeBtn);
    container.appendChild(row);
    updateAddProductBtnVisibility();
}

/**
 * 商品追加ボタンの表示制御（最大3行まで）
 */
function updateAddProductBtnVisibility() {
    const container = document.getElementById('product-inputs-container');
    const addBtn = document.getElementById('add-product-btn');
    if (!addBtn || !container) return;
    const currentRows = container.querySelectorAll('.product-input-row');
    addBtn.style.display = currentRows.length >= 3 ? 'none' : '';
}

/**
 * コピーモードインジケーターの表示更新
 */
function renderCopyModeIndicator() {
    const indicator = document.getElementById('copy-mode-indicator');
    const productInfo = document.getElementById('copy-product-info');

    if (state.copyMode && state.copyProduct) {
        indicator.classList.remove('hidden');
        productInfo.textContent = `${state.copyProduct.productName} ¥${state.copyProduct.price}`;
    } else {
        indicator.classList.add('hidden');
    }
}

/**
 * コピーモード開始
 */
function startCopyMode() {
    const locker = state.data.lockers.find(l => l.id === state.selectedLockerId);
    if (!locker || !locker.isLocked) return;

    state.copyMode = true;
    state.copySourceLockerId = locker.id;
    state.copyProduct = {
        productName: locker.productName,
        price: locker.price,
        hasBonus: locker.hasBonus || false
    };

    closeModal();
    renderApp();
}

/**
 * コピーモード終了
 */
function cancelCopyMode() {
    state.copyMode = false;
    state.copyProduct = null;
    state.copySourceLockerId = null;
    renderApp();
}

/**
 * コピー中の商品を空きロッカーへ貼り付ける
 */
function pasteProduct(locker) {
    if (!state.copyProduct) return;
    updateLocker(locker.id, {
        isLocked: true,
        productName: state.copyProduct.productName,
        price: state.copyProduct.price,
        hasBonus: state.copyProduct.hasBonus,
        insertedAmount: 0
    });
    saveData();
    renderApp();
}

/**
 * 商品登録モーダル内のプリセットボタン群を描画する
 */
function renderPresetButtons() {
    const container = document.getElementById('preset-buttons');
    container.innerHTML = '';
    if (!state.selectedPresets) state.selectedPresets = [];

    state.data.presets.forEach(p => {
        const btn = document.createElement('button');
        btn.textContent = p;
        btn.className = 'preset-btn';
        if (state.selectedPresets.includes(p)) btn.classList.add('selected');

        btn.onclick = () => {
            const idx = state.selectedPresets.indexOf(p);
            if (idx >= 0) {
                state.selectedPresets.splice(idx, 1);
                btn.classList.remove('selected');
            } else {
                const inputContainer = document.getElementById('product-inputs-container');
                const filledInputs = inputContainer ? [...inputContainer.querySelectorAll('.product-name-input')].filter(i => i.value.trim()).length : 0;
                if (state.selectedPresets.length + filledInputs >= 3) {
                    alert('商品は最大3つまでです');
                    return;
                }
                state.selectedPresets.push(p);
                btn.classList.add('selected');
            }
        };
        container.appendChild(btn);
    });
}

/**
 * 商品登録モーダル内の価格選択ボタン群を描画する
 */
function renderPriceButtons() {
    const container = document.getElementById('price-buttons');
    container.innerHTML = '';
    const priceOptions = state.data.pricePresets || DEFAULT_PRICE_PRESETS;
    priceOptions.forEach(price => {
        const btn = document.createElement('button');
        btn.textContent = `¥${price}`;
        btn.className = 'price-btn';
        btn.dataset.price = price;
        btn.onclick = () => {
            state.tempPrice = price;
            updatePriceDisplay();
            updatePriceButtonSelection();
        };
        container.appendChild(btn);
    });
}

/**
 * 価格ボタンの選択状態を更新する
 */
function updatePriceButtonSelection() {
    document.querySelectorAll('.price-btn').forEach(btn => {
        btn.classList.toggle('selected', parseInt(btn.dataset.price, 10) === state.tempPrice);
    });
}

/**
 * 選択中価格のテキスト表示を更新する
 */
function updatePriceDisplay() {
    document.getElementById('setting-price').textContent = `¥${state.tempPrice}`;
}

/**
 * ロッカーへの商品登録・更新処理
 */
function registerProduct() {
    const inputContainer = document.getElementById('product-inputs-container');
    const inputNames = inputContainer
        ? [...inputContainer.querySelectorAll('.product-name-input')].map(i => sanitizeText(i.value, 30)).filter(v => v)
        : [];
    const presetNames = state.selectedPresets ? state.selectedPresets.map(p => sanitizeText(p, 30)).filter(v => v) : [];
    const allNames = [...presetNames, ...inputNames];

    if (allNames.length === 0) {
        alert('商品名を入力またはプリセットを選択してください');
        return;
    }
    if (allNames.length > 3) {
        alert('商品は最大3つまでです');
        return;
    }
    if (state.tempPrice <= 0) {
        alert('価格を選択してください');
        return;
    }

    const combinedName = allNames.join('\n');
    const bonusToggle = document.getElementById('bonus-toggle');
    const hasBonus = bonusToggle ? bonusToggle.checked : false;

    state.data.lastRegistered = {
        names: allNames,
        price: state.tempPrice,
        hasBonus: hasBonus
    };

    updateLocker(state.selectedLockerId, {
        isLocked: true,
        productName: combinedName,
        price: state.tempPrice,
        hasBonus: hasBonus,
        insertedAmount: 0
    });

    saveData();
    closeModal();
    renderApp();
}

/**
 * ロッカーの取り下げ（売上計上なし）
 */
function clearLocker() {
    if (!confirm('本当に取り下げますか？（売上には計上されません）')) return;
    updateLocker(state.selectedLockerId, {
        isLocked: false,
        productName: '',
        price: 0,
        hasBonus: false,
        insertedAmount: 0
    });
    saveData();
    closeModal();
    renderApp();
}

/**
 * 管理者による硬貨不要購入処理
 */
function processAdminPurchase() {
    const locker = state.data.lockers.find(l => l.id === state.selectedLockerId);
    if (!locker) return;
    addSalesRecord(locker.productName, locker.price, locker.machineId, null, locker.machineNum, locker.coordNum, locker.hasBonus || false);
    updateLocker(state.selectedLockerId, {
        isLocked: false,
        productName: '',
        price: 0,
        insertedAmount: 0
    });
    saveData();
    closeModal();
    renderApp();
    alert('硬貨不要で購入処理しました（売上に計上されました）');
}

/**
 * 選択中の自販機の全商品を一括購入する処理
 */
function processBulkPurchase() {
    const machineLockers = state.data.lockers.filter(l => l.machineId === state.currentMachine && l.isLocked);
    if (machineLockers.length === 0) {
        alert('この自販機には商品がありません');
        return;
    }
    const totalAmount = machineLockers.reduce((sum, l) => sum + (Number(l.price) || 0), 0);
    const productCount = machineLockers.length;

    if (!confirm(`${getMachineName(state.currentMachine)}の商品を一括購入しますか？\n\n商品数: ${productCount}個\n合計金額: ¥${totalAmount}\n\n※すべての商品が売上に計上され、ロッカーは空になります。`)) {
        return;
    }

    machineLockers.forEach(locker => {
        addSalesRecord(locker.productName, locker.price, locker.machineId, null, locker.machineNum, locker.coordNum, locker.hasBonus || false);
        updateLocker(locker.id, {
            isLocked: false,
            productName: '',
            price: 0,
            insertedAmount: 0
        });
    });

    saveData();
    renderApp();
    alert(`一括購入が完了しました\n\n売上: ¥${totalAmount}`);
}

/**
 * 購入者用モーダルを開く
 */
function openBuyerModal(locker) {
    state.tempAmount = 0;
    document.getElementById('buyer-product-name').textContent = locker.productName;
    document.getElementById('buyer-product-price').textContent = `¥${locker.price}`;
    updateBuyerModalUI(locker);
    openModal('buyer-modal');
}

/**
 * 購入者モーダルの表示更新
 */
function updateBuyerModalUI(locker = null) {
    if (!locker) {
        locker = state.data.lockers.find(l => l.id === state.selectedLockerId);
    }
    if (!locker) return;
    document.getElementById('inserted-amount').textContent = state.tempAmount;

    const unlockBtn = document.getElementById('unlock-btn');
    if (state.tempAmount >= locker.price) {
        unlockBtn.disabled = false;
        unlockBtn.textContent = '解錠して取り出す';
    } else {
        unlockBtn.disabled = true;
        unlockBtn.textContent = `あと${locker.price - state.tempAmount}円不足`;
    }
}

/**
 * 購入確定・解錠処理
 */
function processPurchase() {
    const locker = state.data.lockers.find(l => l.id === state.selectedLockerId);
    if (!locker) return;
    addSalesRecord(locker.productName, locker.price, locker.machineId, null, locker.machineNum, locker.coordNum, locker.hasBonus || false);
    updateLocker(state.selectedLockerId, {
        isLocked: false,
        productName: '',
        price: 0,
        insertedAmount: 0
    });
    saveData();
    closeModal();
    renderApp();
    alert('ありがとうございます！商品をお取りください。');
}

/**
 * ワンクリック購入処理
 */
function processQuickPurchase(locker) {
    const saleId = String(Date.now()) + '_' + Math.random().toString(36).slice(2, 7);
    addSalesRecord(locker.productName, locker.price, locker.machineId, saleId, locker.machineNum, locker.coordNum, locker.hasBonus || false);
    updateLocker(locker.id, {
        isLocked: false,
        productName: '',
        price: 0,
        insertedAmount: 0
    });
    state.lastPurchase = {
        lockerId: locker.id,
        saleId: saleId,
        productName: locker.productName,
        price: locker.price,
        hasBonus: locker.hasBonus || false,
        machineId: locker.machineId
    };
    saveData();
    renderApp();
    showUndoNotification();
}

/**
 * 購入取り消し（Undo）トースト通知を表示する
 */
function showUndoNotification() {
    const existing = document.getElementById('undo-notification');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'undo-notification';
    el.className = 'undo-notification';

    const span = document.createElement('span');
    span.textContent = '購入しました';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '元に戻す';
    btn.onclick = undoPurchase;

    el.append(span, btn);
    document.body.appendChild(el);
    setTimeout(() => {
        if (el.parentNode) el.remove();
    }, 5000);
}

/**
 * 直前のワンクリック購入を取り消す
 */
function undoPurchase() {
    if (!state.lastPurchase) return;
    const lp = state.lastPurchase;
    state.data.sales = state.data.sales.filter(s => String(s.id) !== String(lp.saleId));
    updateLocker(lp.lockerId, {
        isLocked: true,
        productName: lp.productName,
        price: lp.price,
        hasBonus: lp.hasBonus || false,
        insertedAmount: 0
    });
    state.lastPurchase = null;
    const el = document.getElementById('undo-notification');
    if (el) el.remove();
    saveData();
    renderApp();
    alert('購入を取り消しました');
}

/**
 * クラウド（Google Apps Script）から最新データを取得する
 */
async function fetchFromCloud(silent = false) {
    if (!state.data.cloudUrl || !isValidCloudUrl(state.data.cloudUrl)) return;
    if (state.isSyncing) return;

    // 送信待ちのローカル変更がある場合は上書きを防ぐ（楽観的排他制御）
    if (state.isDirty) {
        return;
    }

    try {
        state.isSyncing = true;
        let fetchUrl = state.data.cloudUrl;
        if (state.data.cloudToken) {
            const separator = fetchUrl.includes('?') ? '&' : '?';
            fetchUrl = `${fetchUrl}${separator}token=${encodeURIComponent(state.data.cloudToken)}`;
        }

        const response = await fetch(fetchUrl, { cache: 'no-store' });
        const cloudData = await response.json();

        // 取得中にローカルで新たな操作が行われた場合は破棄
        if (state.isDirty) {
            state.isSyncing = false;
            return;
        }

        if (cloudData && cloudData.error === 'unauthorized') {
            if (!silent) alert('クラウド同期の「通信の合言葉」が一致しません。設定を確認してください。');
            return;
        }

        if (cloudData && cloudData.lockers) {
            if (cloudData.lastActiveTime) {
                const lastActive = Number(cloudData.lastActiveTime);
                const diffFromNow = Date.now() - lastActive;
                // クラウドの最終更新が1分以内かどうか
                const isRecentlyActive = Math.abs(diffFromNow) < 60000;
                // 自分が直近で操作したことによる更新かどうか（1分以内の自操作は除外）
                const isMyOwnAction = (Date.now() - state.lastLocalEditTime) < 65000;
                const isOtherUserActive = isRecentlyActive && !isMyOwnAction;

                const warningEl = document.getElementById('activity-warning');
                if (warningEl) {
                    warningEl.classList.toggle('hidden', !isOtherUserActive);
                }
            }

            const sanitized = sanitizeImportedData(cloudData);
            if (sanitized) {
                state.data.lockers = sanitized.lockers;
                sortLockersCorrectly();
                state.data.sales = sanitized.sales;
                state.data.presets = sanitized.presets;
                if (cloudData.pricePresets) state.data.pricePresets = sanitized.pricePresets;
                if (cloudData.machineNames) state.data.machineNames = sanitized.machineNames;
                if (cloudData.machineCount) state.data.machineCount = sanitized.machineCount;
                if (cloudData.oneClickMode !== undefined) state.data.oneClickMode = sanitized.oneClickMode;

                initLockers();
                localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
                renderApp();
            }
        }
    } catch (err) {
        console.error('クラウド取得エラー:', err);
        if (!silent) alert('クラウドからのデータ取得に失敗しました。URLや通信環境を確認してください。');
    } finally {
        state.isSyncing = false;
    }
}

/**
 * クラウド（Google Apps Script）へデータを送信する
 */
async function pushToCloud() {
    if (!state.data.cloudUrl || !isValidCloudUrl(state.data.cloudUrl)) return;
    state.isSyncing = true;
    const payload = {
        token: state.data.cloudToken || '',
        lockers: state.data.lockers,
        sales: state.data.sales,
        presets: state.data.presets,
        pricePresets: state.data.pricePresets,
        machineCount: state.data.machineCount,
        machineNames: state.data.machineNames,
        oneClickMode: state.data.oneClickMode
    };
    try {
        await fetch(state.data.cloudUrl, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        state.isDirty = false; // 送信成功
    } catch (err) {
        console.error('クラウド送信エラー:', err);
        // エラー時は isDirty を true のまま維持し、次回保存時に再送する
    } finally {
        state.isSyncing = false;
    }
}

/**
 * 価格に応じたロッカーの色分けクラスを返す
 */
function getPriceColorClass(price) {
    if (price <= 100) return 'price-tier-1';
    if (price <= 200) return 'price-tier-2';
    if (price <= 300) return 'price-tier-3';
    if (price <= 400) return 'price-tier-4';
    return 'price-tier-5';
}

/**
 * 現在の自販機の商品を一括削除（売上計上なし）
 */
function processBulkClear() {
    const machineLockers = state.data.lockers.filter(l => l.machineId === state.currentMachine && l.isLocked);
    if (machineLockers.length === 0) return alert('この自販機には商品がありません');
    if (!confirm(`${getMachineName(state.currentMachine)}の商品を一括削除しますか？\n\n※売上には計上されません。`)) return;

    machineLockers.forEach(locker => {
        updateLocker(locker.id, {
            isLocked: false,
            productName: '',
            price: 0,
            hasBonus: false,
            insertedAmount: 0
        });
    });
    saveData();
    renderApp();
}

/**
 * 指定IDのロッカー情報を更新する
 */
function updateLocker(id, updates) {
    const idx = state.data.lockers.findIndex(l => l.id === id);
    if (idx !== -1) {
        state.data.lockers[idx] = { ...state.data.lockers[idx], ...updates };
    }
}

/**
 * 日本標準時（JST）の日時文字列を取得する
 */
function getJSTDateTime() {
    const now = new Date();
    const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    return jstNow.toISOString().replace('T', ' ').replace(/\..+/, '');
}

/**
 * 売上記録を追加する
 */
function addSalesRecord(name, price, machineId, id = null, machineNum = null, coordNum = null, hasBonus = false) {
    const recordId = id || (String(Date.now()) + '_' + Math.random().toString(36).slice(2, 7));
    state.data.sales.push({
        id: recordId,
        date: getJSTDateTime(),
        productName: sanitizeText(name, 100),
        price: Number(price) || 0,
        machineId: Number(machineId) || 1,
        machineNum: Number(machineNum || machineId) || 1,
        coordNum: coordNum || '',
        hasBonus: Boolean(hasBonus)
    });
}

/**
 * モーダルを開く
 */
function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
}

/**
 * すべてのモーダルを閉じる
 */
function closeModal() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

/**
 * 管理画面の売上一覧テーブルを描画する（XSS防止のためDOM要素として構築）
 */
function renderAdminSales() {
    const tbody = document.getElementById('sales-table-body');
    const totalEl = document.getElementById('total-sales');

    tbody.innerHTML = '';
    let filtered = [...state.data.sales];

    if (state.adminTargetMonth) {
        const [targetYear, targetMonth] = state.adminTargetMonth.split('-').map(Number);
        filtered = filtered.filter(s => {
            const d = new Date(s.date);
            return d.getFullYear() === targetYear && d.getMonth() === (targetMonth - 1);
        });
    }

    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

    let sum = 0;
    filtered.forEach(sale => {
        const priceNum = Number(sale.price) || 0;
        sum += priceNum;

        const tr = document.createElement('tr');
        const d = new Date(sale.date);
        const dateStr = isNaN(d.getTime())
            ? ''
            : `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

        // 日時セル
        const tdDate = document.createElement('td');
        tdDate.textContent = dateStr;

        // 商品名・ロッカー位置セル
        const tdProduct = document.createElement('td');
        const bonusPrefix = sale.hasBonus ? '🎁 ' : '';
        tdProduct.appendChild(document.createTextNode(`${bonusPrefix}${sale.productName || ''} `));

        if (sale.coordNum) {
            const locSmall = document.createElement('small');
            locSmall.style.color = '#888';
            locSmall.textContent = `[${getMachineName(sale.machineNum || sale.machineId)} ${sale.coordNum}]`;
            tdProduct.appendChild(locSmall);
        }

        // 金額セル
        const tdPrice = document.createElement('td');
        tdPrice.textContent = `¥${priceNum}`;

        // 操作セル
        const tdAction = document.createElement('td');
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'delete-record-btn';
        delBtn.textContent = '削除';
        delBtn.onclick = () => deleteSale(sale.id);
        tdAction.appendChild(delBtn);

        tr.append(tdDate, tdProduct, tdPrice, tdAction);
        tbody.appendChild(tr);
    });

    totalEl.textContent = `合計: ¥${sum.toLocaleString()}`;
}

/**
 * 指定IDの売上レコードを削除する
 */
function deleteSale(id) {
    if (!confirm('この売上記録を削除しますか？')) return;
    state.data.sales = state.data.sales.filter(s => String(s.id) !== String(id));
    saveData();
    renderApp();
}

/**
 * すべての売上データを削除する
 */
function clearAllSales() {
    if (!confirm('すべての売上データを削除しますか？')) return;
    state.data.sales = [];
    saveData();
    renderApp();
    alert('売上データをすべて削除しました');
}

/**
 * 工場出荷状態にリセット（全データの消去・初期化）
 */
function factoryReset() {
    if (!confirm('【警告】この端末に保存されている在庫・売上・プリセット・クラウド接続設定・暗証番号をすべて消去し、初期状態に戻します。\n本当によろしいですか？')) return;
    if (!confirm('この操作は取り消せません。本当に初期化しますか？')) return;

    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(`${STORAGE_KEY}_oneclick_init_v1`);
    state.data = {
        lockers: [],
        sales: [],
        presets: [...DEFAULT_PRESETS],
        pricePresets: [...DEFAULT_PRICE_PRESETS],
        machineCount: 2,
        machineNames: {},
        cloudUrl: '',
        cloudToken: '',
        adminPinHash: '',
        autoSync: true,
        oneClickMode: true
    };
    state.currentMachine = 1;
    state.mode = 'seller';
    state.isDirty = false;
    initLockers();
    renderApp();
    alert('すべてのデータを初期状態にリセットしました');
}

/**
 * 管理画面の商品名プリセット一覧を描画する
 */
function renderAdminPresets() {
    const list = document.getElementById('edit-preset-list');
    list.innerHTML = '';
    state.data.presets.forEach((p, index) => {
        const div = document.createElement('div');
        div.className = 'preset-list-item';

        const span = document.createElement('span');
        span.textContent = p;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'remove-preset-btn';
        btn.textContent = '×';
        btn.onclick = () => removePreset(index);

        div.append(span, btn);
        list.appendChild(div);
    });
}

/**
 * 商品名プリセットを追加する
 */
function addPreset() {
    const input = document.getElementById('new-preset-name');
    const val = sanitizeText(input.value, 30);
    if (val) {
        if (state.data.presets.includes(val)) {
            alert('この商品名は既に登録されています');
            return;
        }
        state.data.presets.push(val);
        input.value = '';
        saveData();
        renderAdminPresets();
    }
}

/**
 * 商品名プリセットを削除する
 */
function removePreset(index) {
    if (!confirm('削除しますか？')) return;
    state.data.presets.splice(index, 1);
    saveData();
    renderAdminPresets();
}

/**
 * 管理画面の金額プリセット一覧を描画する
 */
function renderAdminPricePresets() {
    const list = document.getElementById('edit-price-preset-list');
    if (!list) return;
    list.innerHTML = '';
    const presets = state.data.pricePresets || DEFAULT_PRICE_PRESETS;
    presets.forEach((p, index) => {
        const div = document.createElement('div');
        div.className = 'preset-list-item';

        const span = document.createElement('span');
        span.textContent = `¥${Number(p) || 0}`;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'remove-preset-btn';
        btn.textContent = '×';
        btn.onclick = () => removePricePreset(index);

        div.append(span, btn);
        list.appendChild(div);
    });
}

/**
 * 金額プリセットを追加する
 */
function addPricePreset() {
    const input = document.getElementById('new-price-preset');
    const val = parseInt(input.value.trim(), 10);
    if (val && val > 0 && val <= 100000) {
        if (!state.data.pricePresets) state.data.pricePresets = [...DEFAULT_PRICE_PRESETS];
        if (state.data.pricePresets.includes(val)) return alert('この金額は既に登録されています');
        state.data.pricePresets.push(val);
        state.data.pricePresets.sort((a, b) => a - b);
        input.value = '';
        saveData();
        renderAdminPricePresets();
    } else {
        alert('1〜100000の間で正しい金額を入力してください');
    }
}

/**
 * 金額プリセットを削除する
 */
function removePricePreset(index) {
    if (!confirm('削除しますか？')) return;
    if (!state.data.pricePresets) state.data.pricePresets = [...DEFAULT_PRICE_PRESETS];
    state.data.pricePresets.splice(index, 1);
    saveData();
    renderAdminPricePresets();
}

/**
 * 自販機設定タブの描画更新
 */
function renderMachineSettings() {
    document.getElementById('machine-count').textContent = state.data.machineCount;
    document.getElementById('one-click-toggle').checked = state.data.oneClickMode;
    document.getElementById('auto-sync-toggle').checked = state.data.autoSync;
    document.getElementById('cloud-url-input').value = state.data.cloudUrl || '';

    // 各自販機の名称設定リストを安全に構築
    const list = document.getElementById('machine-names-list');
    if (list) {
        list.innerHTML = '';
        const titleP = document.createElement('p');
        titleP.textContent = '各自販機の名称設定:';
        list.appendChild(titleP);

        for (let m = 1; m <= state.data.machineCount; m++) {
            const div = document.createElement('div');
            div.className = 'machine-name-item';

            const labelSpan = document.createElement('span');
            labelSpan.textContent = `ID ${m}:`;

            const input = document.createElement('input');
            input.type = 'text';
            input.id = `machine-name-input-${m}`;
            input.maxLength = 20;
            input.value = getMachineName(m);
            input.placeholder = `自販機${m}`;

            const saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.className = 'action-btn primary';
            saveBtn.style.cssText = 'padding: 8px 12px; margin: 0; width: auto;';
            saveBtn.textContent = '保存';
            saveBtn.onclick = () => saveMachineName(m);

            div.append(labelSpan, input, saveBtn);
            list.appendChild(div);
        }
    }
}

/**
 * 自販機の名称を保存する
 */
function saveMachineName(m) {
    const input = document.getElementById(`machine-name-input-${m}`);
    if (input) {
        const val = sanitizeText(input.value, 20);
        if (val) {
            state.data.machineNames[m] = val;
        } else {
            delete state.data.machineNames[m];
        }
        saveData();
        renderMachineTabs();
        alert('保存しました');
    }
}

/**
 * データ・保護タブの表示状態を更新する
 */
function renderDataSettings() {
    const statusText = document.getElementById('pin-status-text');
    const clearPinBtn = document.getElementById('clear-pin-btn');
    if (statusText && clearPinBtn) {
        if (state.data.adminPinHash) {
            statusText.textContent = '設定済み（ロック有効）';
            statusText.style.color = 'var(--primary-dark)';
            clearPinBtn.classList.remove('hidden');
        } else {
            statusText.textContent = '未設定（ロックなし）';
            statusText.style.color = '#666';
            clearPinBtn.classList.add('hidden');
        }
    }
}

/**
 * 自販機を1台追加する
 */
function addMachine() {
    if (state.data.machineCount >= 20) {
        alert('自販機は最大20台までです');
        return;
    }
    state.data.machineCount++;
    const m = state.data.machineCount;
    createLockersForMachine(m);
    saveData();
    renderApp();
    alert(`自販機${m}を追加しました`);
}

/**
 * 最後の自販機を1台削除する
 */
function removeMachine() {
    if (state.data.machineCount <= 1) return alert('最低1台は必要です');
    const m = state.data.machineCount;
    const machineLockers = state.data.lockers.filter(l => l.machineId === m);
    const hasProducts = machineLockers.some(l => l.isLocked);

    if (hasProducts && !confirm(`${getMachineName(m)}には商品が入っています。削除すると商品データも消えますが、よろしいですか？`)) return;
    if (!hasProducts && !confirm(`${getMachineName(m)}を削除しますか？`)) return;

    state.data.lockers = state.data.lockers.filter(l => l.machineId !== m);
    delete state.data.machineNames[m];
    state.data.machineCount--;

    if (state.currentMachine > state.data.machineCount) {
        state.currentMachine = 1;
    }
    saveData();
    renderApp();
    alert(`自販機${m}を削除しました`);
}

/**
 * データをJSONファイルとしてダウンロードする（個人情報・認証情報は除外）
 */
function downloadData() {
    const exportPayload = {
        lockers: state.data.lockers,
        sales: state.data.sales,
        presets: state.data.presets,
        pricePresets: state.data.pricePresets,
        machineCount: state.data.machineCount,
        machineNames: state.data.machineNames,
        oneClickMode: state.data.oneClickMode
    };
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportPayload, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute('href', dataStr);
    downloadAnchorNode.setAttribute('download', 'vending_machine_data.json');
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

/**
 * JSONファイルからデータを取り込む（スキーマ検証・サニタイズを行い、既存の接続・認証設定は保持）
 */
function uploadData() {
    const input = document.getElementById('upload-data-input');
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const json = JSON.parse(e.target.result);
            if (json && Array.isArray(json.lockers)) {
                const sanitized = sanitizeImportedData(json);
                if (sanitized) {
                    // 現在のクラウド設定やPIN設定は維持しつつデータのみを復元
                    state.data = {
                        ...state.data,
                        ...sanitized
                    };
                    initLockers();
                    saveData();
                    renderApp();
                    alert('データを取り込みました');
                } else {
                    alert('データ形式が正しくありません');
                }
            } else {
                alert('データ形式が正しくありません');
            }
        } catch (err) {
            alert('ファイルの読み込みに失敗しました');
        }
        input.value = '';
    };
    reader.readAsText(file);
}

// ---------------------------------------------------------
// 分析チャート描画 (Chart.js)
// ---------------------------------------------------------
function renderAnalytics() {
    if (typeof Chart === 'undefined') return;

    let targetSales = [...state.data.sales];
    if (state.adminTargetMonth) {
        const [targetYear, targetMonth] = state.adminTargetMonth.split('-').map(Number);
        targetSales = targetSales.filter(s => {
            const d = new Date(s.date);
            return d.getFullYear() === targetYear && d.getMonth() === (targetMonth - 1);
        });
    }

    // 商品別集計
    const productCounts = {};
    targetSales.forEach(s => {
        const names = String(s.productName || '').split('\n').map(n => n.trim()).filter(n => n);
        names.forEach(n => {
            productCounts[n] = (productCounts[n] || 0) + 1;
        });
    });

    const pieLabels = Object.keys(productCounts);
    const pieData = Object.values(productCounts);
    const pieColors = ['#4CAF50', '#8BC34A', '#CDDC39', '#FFEB3B', '#FFC107', '#FF9800', '#FF5722', '#f44336'];

    if (productChartInst) productChartInst.destroy();
    const ctxPie = document.getElementById('productPieChart').getContext('2d');
    productChartInst = new Chart(ctxPie, {
        type: 'pie',
        data: {
            labels: pieLabels,
            datasets: [{
                data: pieData,
                backgroundColor: pieColors.slice(0, pieLabels.length),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right' }
            }
        }
    });

    // 時間帯別集計
    const timeCounts = new Array(24).fill(0);
    targetSales.forEach(s => {
        const d = new Date(s.date);
        if (!isNaN(d.getTime())) {
            timeCounts[d.getHours()]++;
        }
    });

    if (timeChartInst) timeChartInst.destroy();
    const ctxBar = document.getElementById('timeBarChart').getContext('2d');
    timeChartInst = new Chart(ctxBar, {
        type: 'bar',
        data: {
            labels: Array.from({ length: 24 }, (_, i) => `${i}時`),
            datasets: [{
                label: '売上回数',
                data: timeCounts,
                backgroundColor: '#64B5F6'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, ticks: { stepSize: 1 } }
            }
        }
    });
}

// ---------------------------------------------------------
// 画面の向き制御（スマホ横向き時のみ警告を表示）
// ---------------------------------------------------------
function initOrientationControl() {
    const warningEl = document.getElementById('orientation-warning');
    if (!warningEl) return;

    const checkOrientation = () => {
        const activeTag = document.activeElement ? document.activeElement.tagName : '';
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
            warningEl.classList.remove('visible');
            document.body.style.overflow = '';
            return;
        }

        let isLandscape = false;
        if (screen.orientation && screen.orientation.type) {
            isLandscape = screen.orientation.type.includes('landscape');
        } else if (typeof window.orientation !== 'undefined') {
            isLandscape = (Math.abs(window.orientation) === 90);
        } else {
            isLandscape = (window.innerWidth > window.innerHeight);
        }

        // スマホ(縦に細長い端末)を横にした時だけ警告し、タブレット等は許容する
        if (window.innerHeight > 500 || window.innerWidth > 900) {
            isLandscape = false;
        }

        if (isLandscape) {
            warningEl.classList.add('visible');
            document.body.style.overflow = 'hidden';
        } else {
            warningEl.classList.remove('visible');
            document.body.style.overflow = '';
        }
    };

    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);
    document.addEventListener('focusin', () => {
        warningEl.classList.remove('visible');
        document.body.style.overflow = '';
    });
    document.addEventListener('focusout', () => setTimeout(checkOrientation, 300));
    checkOrientation();
}

document.addEventListener('DOMContentLoaded', initOrientationControl);
