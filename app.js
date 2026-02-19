/**
 * 自動販売機管理アプリ
 * Logic for Warped Shuttle Vending Machine
 */

// 定数
const STORAGE_KEY = 'vending_machine_data';
const DEFAULT_PRESETS = ['大玉トマト', '中玉トマト', 'ミニトマト', 'レタス', 'いちご', 'キュウリ'];
const TOTAL_ROWS = 6;
const TOTAL_COLS = 3;
const DEFAULT_PRICE_PRESETS = [100, 150, 200, 300, 400, 500];

// 状態管理
let state = {
    // データ（保存対象）
    data: {
        lockers: [], // { id, machineId, row, col, isLocked, productName, price, insertedAmount, hasBonus }
        sales: [],   // { id, date, productName, price, machineId }
        presets: [...DEFAULT_PRESETS],
        pricePresets: [...DEFAULT_PRICE_PRESETS], // 金額プリセット
        machineCount: 2, // 自販機の台数
        cloudUrl: '',    // GAS WebアプリのURL
        autoSync: true   // 自動同期（ポーリング）の有効無効
    },
    // UI状態（保存しない）
    currentMachine: 1,
    mode: 'seller', // 'buyer' or 'seller' - デフォルトは販売者
    selectedLockerId: null,
    tempPrice: 100,
    tempAmount: 0, // 購入時の投入金額
    // コピーモード
    copyMode: false,
    copyProduct: null, // { productName, price }
    // ワンクリック購入
    oneClickMode: false,
    lastPurchase: null, // { lockerId, saleId } - Undo用
    isSyncing: false,       // 送信中フラグ
    lastLocalEditTime: 0    // 最終操作時刻
};

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    initLockers();
    renderApp();
    setupEventListeners();

    // クラウド設定があれば初回同期
    if (state.data.cloudUrl) {
        fetchFromCloud();
    }

    // 定期同期設定 (15秒ごとに短縮して検知精度アップ)
    setInterval(() => {
        // モーダルが表示されている（編集中）場合は同期しない
        const isModalOpen = !document.getElementById('edit-modal').classList.contains('hidden') ||
            !document.getElementById('buyer-modal').classList.contains('hidden') ||
            !document.getElementById('admin-modal').classList.contains('hidden');

        if (state.data.cloudUrl && state.data.autoSync && !state.copyMode && !isModalOpen) {
            fetchFromCloud(true); // サイレント更新
        }
    }, 15000);
});

function loadData() {
    const json = localStorage.getItem(STORAGE_KEY);
    if (json) {
        try {
            const parsed = JSON.parse(json);
            // データのマージ（新しいフィールドがある場合の対応）
            state.data = { ...state.data, ...parsed };
            // 古いデータ形式からのマイグレーション
            if (state.data.autoSync === undefined) state.data.autoSync = true;
            if (!state.data.presets) state.data.presets = [...DEFAULT_PRESETS];
            if (!state.data.machineCount) state.data.machineCount = 2;
            // 金額プリセットのマイグレーション
            if (!state.data.pricePresets) state.data.pricePresets = [...DEFAULT_PRICE_PRESETS];
        } catch (e) {
            console.error('データ読み込みエラー', e);
        }
    }
}

function saveData() {
    state.lastLocalEditTime = Date.now(); // 操作時刻を記録
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    // クラウド設定があれば送信
    if (state.data.cloudUrl) {
        pushToCloud();
    }
}

function initLockers() {
    // 列が [3, 2, 1] の順（右上が1-1）になっているかチェック
    const isOrderCorrect = state.data.lockers.length > 0 &&
        state.data.lockers[0].col === 3 &&
        state.data.lockers[0].row === 1;

    if (state.data.lockers.length === 0 || !state.data.lockers[0].coordNum || !isOrderCorrect) {
        // 並び順が古い、またはデータがない場合は並び替え・再生成を検討
        // 既存商品がある場合は、IDを維持したまま並び順(Array index)だけを変える
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
    saveDataLocally();
}

function sortLockersCorrectly() {
    // state.data.lockersを、各マシンごとに [3-r, 2-r, 1-r] の順になるよう並び替える
    state.data.lockers.sort((a, b) => {
        if (a.machineId !== b.machineId) return a.machineId - b.machineId;
        if (a.row !== b.row) return a.row - b.row;
        return b.col - a.col; // c=3, 2, 1 の順
    });
}

function createLockersForMachine(m) {
    // 【決定版】標準の左から右(LTR)の並び順を使用します。
    // 配列の順序を [3列目, 2列目, 1列目] とすることで、物理的に右端が 1番列 になります。
    for (let r = 1; r <= TOTAL_ROWS; r++) {
        for (let c = 3; c >= 1; c--) {
            state.data.lockers.push({
                id: `${m}-${r}-${c}`,
                machineId: m, machineNum: m,
                row: r, col: c,
                coordNum: `${c}-${r}`,
                isLocked: false, productName: '', price: 0, insertedAmount: 0
            });
        }
    }
}

// レンダリング
function renderApp() {
    renderHeader();
    renderMachineTabs();
    renderLockers();
    renderBulkPurchaseArea();
    renderSalesSummary();
    renderCopyModeIndicator();
    renderAdminSales();
    renderAdminPresets();
    renderAdminPricePresets();
    renderMachineSettings();
    renderDataSettings();
}

function renderHeader() {
    // モード切り替えボタン
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(state.mode === 'buyer' ? 'mode-buyer' : 'mode-seller').classList.add('active');
}

function renderMachineTabs() {
    const container = document.getElementById('machine-switch');
    container.innerHTML = '';

    for (let m = 1; m <= state.data.machineCount; m++) {
        const btn = document.createElement('button');
        btn.className = `machine-tab ${m === state.currentMachine ? 'active' : ''}`;
        btn.dataset.machine = m;
        btn.textContent = `自販機${m}`;
        btn.onclick = () => {
            state.currentMachine = m;
            renderApp();
        };
        container.appendChild(btn);
    }
}

function renderLockers() {
    const grid = document.getElementById('locker-grid');
    grid.innerHTML = '';

    const targetLockers = state.data.lockers.filter(l => l.machineId === state.currentMachine);

    targetLockers.forEach(locker => {
        const el = document.createElement('div');
        let classes = 'locker';
        if (locker.isLocked) classes += ' locked';
        if (state.copyMode && !locker.isLocked) classes += ' copy-target';
        el.className = classes;
        el.dataset.id = locker.id;
        el.onclick = () => handleLockerClick(locker);

        const idSpan = document.createElement('span');
        idSpan.className = 'locker-id';
        idSpan.textContent = locker.coordNum;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'locker-content';

        if (locker.isLocked) {
            // 複数商品対応: 改行区切りで商品名を分割
            const products = locker.productName.split('\n').filter(p => p.trim());
            const productCount = products.length;
            // 品数に応じてフォントサイズを変更
            let fontSizeClass = '';
            if (productCount >= 3) fontSizeClass = ' locker-product-sm';
            else if (productCount >= 2) fontSizeClass = ' locker-product-md';

            const productHtml = products.map(p => escapeHtml(p)).join('<br>');
            contentDiv.innerHTML = `
                <div class="locker-product${fontSizeClass}">${productHtml}</div>
                <div class="locker-price">¥${locker.price}</div>
            `;

            // おまけバッジ
            if (locker.hasBonus) {
                const bonusBadge = document.createElement('span');
                bonusBadge.className = 'bonus-badge';
                bonusBadge.textContent = '🎁';
                el.appendChild(bonusBadge);
            }
        } else {
            contentDiv.innerHTML = `<span class="locker-status">空き</span>`;
        }

        el.append(idSpan, contentDiv);
        grid.appendChild(el);
    });
}

function renderBulkPurchaseArea() {
    const area = document.getElementById('bulk-purchase-area');
    const btn = document.getElementById('bulk-purchase-btn');
    if (state.mode === 'seller') {
        const hasProducts = state.data.lockers.some(l => l.machineId === state.currentMachine && l.isLocked);
        if (hasProducts) {
            area.classList.remove('hidden');
            // コピーモード中は無効化
            btn.disabled = state.copyMode;
        } else {
            area.classList.add('hidden');
        }
    } else {
        area.classList.add('hidden');
    }
}

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
                todayTotal += sale.price;
            } else if (saleDateOnly.getTime() === yesterday.getTime()) {
                yesterdayTotal += sale.price;
            }
        });

        yesterdayEl.textContent = `¥${yesterdayTotal.toLocaleString()}`;
        todayEl.textContent = `¥${todayTotal.toLocaleString()}`;
    } else {
        summary.classList.add('hidden');
    }
}

// イベントハンドリング
function setupEventListeners() {
    // モード切替
    document.getElementById('mode-buyer').onclick = () => setMode('buyer');
    document.getElementById('mode-seller').onclick = () => setMode('seller');

    // メニューボタン
    document.getElementById('menu-btn').onclick = () => openModal('admin-modal');

    // モーダルを閉じる
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.onclick = () => closeModal();
    });

    window.onclick = (event) => {
        if (event.target.classList.contains('modal')) {
            closeModal();
        }
    };

    // --- 購入者モーダル ---
    document.getElementById('insert-coin-btn').onclick = () => {
        state.tempAmount += 100;
        updateBuyerModalUI();
    };
    document.getElementById('unlock-btn').onclick = processPurchase;

    // --- 販売者モーダル ---
    document.getElementById('register-btn').onclick = registerProduct;
    document.getElementById('admin-purchase-btn').onclick = processAdminPurchase;
    document.getElementById('clear-locker-btn').onclick = clearLocker;
    document.getElementById('copy-product-btn').onclick = startCopyMode;
    document.getElementById('cancel-copy-btn').onclick = cancelCopyMode;

    // --- 一括購入 ---
    document.getElementById('bulk-purchase-btn').onclick = processBulkPurchase;

    // --- 管理モーダル ---
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
        };
    });

    // プリセット追加
    document.getElementById('add-preset-btn').onclick = addPreset;
    // 金額プリセット追加
    const addPricePresetBtn = document.getElementById('add-price-preset-btn');
    if (addPricePresetBtn) addPricePresetBtn.onclick = addPricePreset;

    // 自販機追加・削除
    document.getElementById('add-machine-btn').onclick = addMachine;
    document.getElementById('remove-machine-btn').onclick = removeMachine;

    // データDL/UL
    document.getElementById('download-data-btn').onclick = downloadData;
    document.getElementById('upload-data-btn').onclick = () => document.getElementById('upload-data-input').click();
    document.getElementById('upload-data-input').onchange = uploadData;

    // 売上期間切り替え
    document.getElementById('sales-period').onchange = renderAdminSales;

    // ワンクリック購入切り替え
    document.getElementById('one-click-toggle').onchange = (e) => {
        state.oneClickMode = e.target.checked;
        saveData();
    };

    // 全売上削除
    document.getElementById('clear-all-sales-btn').onclick = clearAllSales;

    // クラウドURL編集ロック関連
    const displayArea = document.getElementById('cloud-url-display-area');
    const editArea = document.getElementById('cloud-url-edit-area');

    if (document.getElementById('edit-cloud-url-btn')) {
        document.getElementById('edit-cloud-url-btn').onclick = () => {
            displayArea.classList.add('hidden');
            editArea.classList.remove('hidden');
            document.getElementById('cloud-url-edit-input').value = state.data.cloudUrl || '';
        };
    }

    if (document.getElementById('save-cloud-url-btn')) {
        document.getElementById('save-cloud-url-btn').onclick = () => {
            const url = document.getElementById('cloud-url-edit-input').value.trim();
            state.data.cloudUrl = url;
            saveData();
            editArea.classList.add('hidden');
            displayArea.classList.remove('hidden');
            if (url) {
                alert('クラウドURLを保存しました。同期を開始します。');
                fetchFromCloud();
            }
        };
    }

    // 同期設定
    document.getElementById('auto-sync-toggle').onchange = (e) => {
        state.data.autoSync = e.target.checked;
        saveData();
    };

    // 手動同期
    document.getElementById('manual-sync-btn').onclick = () => {
        if (!state.data.cloudUrl) return alert('クラウドURLが設定されていません');
        fetchFromCloud();
    };
}

// アクションロジック

function setMode(mode) {
    state.mode = mode;
    renderApp();
}

function handleLockerClick(locker) {
    state.selectedLockerId = locker.id;

    // コピーモード中の場合
    if (state.copyMode) {
        if (!locker.isLocked) {
            // 空きロッカーにコピーを貼り付け
            pasteProduct(locker);
        } else {
            // コピーした（同じ内容の）商品をもう一度クリックで空きに戻す
            if (state.copyProduct &&
                locker.productName === state.copyProduct.productName &&
                locker.price === state.copyProduct.price) {

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
    } else {
        if (locker.isLocked) {
            if (state.oneClickMode) {
                processQuickPurchase(locker);
            } else {
                openBuyerModal(locker);
            }
        }
    }
}

// -- 販売者ロジック --

function openSellerModal(locker) {
    const adminPurchaseBtn = document.getElementById('admin-purchase-btn');
    const clearBtn = document.getElementById('clear-locker-btn');
    const registerBtn = document.getElementById('register-btn');
    const copyBtn = document.getElementById('copy-product-btn');
    const bonusToggle = document.getElementById('bonus-toggle');

    // プリセットボタン生成（複数選択対応）
    state.selectedPresets = [];
    renderPresetButtons();
    // 価格ボタン生成
    renderPriceButtons();

    // 複数入力欄を初期化
    const inputContainer = document.getElementById('product-inputs-container');
    inputContainer.innerHTML = '';

    if (locker.isLocked) {
        // 既に入ってる場合の編集・取り下げモード
        const products = locker.productName.split('\n').filter(p => p.trim());
        products.forEach(p => addProductInputRow(p));
        if (products.length === 0) addProductInputRow('');
        state.tempPrice = locker.price;
        adminPurchaseBtn.classList.remove('hidden');
        clearBtn.classList.remove('hidden');
        copyBtn.classList.remove('hidden');
        registerBtn.textContent = "更新";
        // おまけトグル
        if (bonusToggle) bonusToggle.checked = locker.hasBonus || false;
    } else {
        // 新規登録
        addProductInputRow('');
        state.tempPrice = state.data.pricePresets[0] || 100;
        adminPurchaseBtn.classList.add('hidden');
        clearBtn.classList.add('hidden');
        copyBtn.classList.add('hidden');
        registerBtn.textContent = "登録して施錠";
        if (bonusToggle) bonusToggle.checked = false;
    }

    updateAddProductBtnVisibility();
    updatePriceDisplay();
    updatePriceButtonSelection();
    openModal('seller-modal');
}

// 商品入力行を追加
function addProductInputRow(value) {
    const container = document.getElementById('product-inputs-container');
    const currentRows = container.querySelectorAll('.product-input-row');
    if (currentRows.length >= 3) return; // 最大3行

    const row = document.createElement('div');
    row.className = 'product-input-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'product-name-input';
    input.placeholder = '商品名を入力';
    input.value = value || '';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-input-btn';
    removeBtn.textContent = '✕';
    removeBtn.onclick = () => {
        // 最低1行は残す
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

function updateAddProductBtnVisibility() {
    const container = document.getElementById('product-inputs-container');
    const addBtn = document.getElementById('add-product-btn');
    if (!addBtn || !container) return;
    const currentRows = container.querySelectorAll('.product-input-row');
    addBtn.style.display = currentRows.length >= 3 ? 'none' : '';
}

// -- コピー機能 --

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

function startCopyMode() {
    const locker = state.data.lockers.find(l => l.id === state.selectedLockerId);
    if (!locker || !locker.isLocked) return;

    state.copyMode = true;
    state.copyProduct = {
        productName: locker.productName,
        price: locker.price,
        hasBonus: locker.hasBonus || false
    };

    closeModal();
    renderApp();
}

function cancelCopyMode() {
    state.copyMode = false;
    state.copyProduct = null;
    renderApp();
}

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
    // コピーモードは継続（連続で貼り付けできるように）
}

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
                // 選択解除
                state.selectedPresets.splice(idx, 1);
                btn.classList.remove('selected');
            } else {
                // 入力欄の合計と合わせて3つ以内かチェック
                const inputContainer = document.getElementById('product-inputs-container');
                const inputCount = inputContainer ? inputContainer.querySelectorAll('.product-input-row').length : 0;
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

function updatePriceButtonSelection() {
    document.querySelectorAll('.price-btn').forEach(btn => {
        btn.classList.toggle('selected', parseInt(btn.dataset.price) === state.tempPrice);
    });
}

function updatePriceDisplay() {
    document.getElementById('setting-price').textContent = `¥${state.tempPrice}`;
}

function registerProduct() {
    // 入力欄の商品名を収集
    const inputContainer = document.getElementById('product-inputs-container');
    const inputNames = inputContainer
        ? [...inputContainer.querySelectorAll('.product-name-input')].map(i => i.value.trim()).filter(v => v)
        : [];
    // プリセット選択の商品名を収集
    const presetNames = state.selectedPresets ? [...state.selectedPresets] : [];
    // 結合（プリセット優先、その後入力欄）
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

    // 改行区切りで結合
    const combinedName = allNames.join('\n');
    const bonusToggle = document.getElementById('bonus-toggle');
    const hasBonus = bonusToggle ? bonusToggle.checked : false;

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

function clearLocker() {
    if (!confirm('本当に取り下げますか？（売上には計上されません）')) return;

    updateLocker(state.selectedLockerId, {
        isLocked: false,
        productName: '',
        price: 0,
        insertedAmount: 0
    });
    saveData();
    closeModal();
    renderApp();
}

function processAdminPurchase() {
    const locker = state.data.lockers.find(l => l.id === state.selectedLockerId);
    if (!locker) return;

    addSalesRecord(locker.productName, locker.price, locker.machineId, null, null, null, locker.hasBonus || false);

    // ロッカーを空にする
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

function processBulkPurchase() {
    const machineLockers = state.data.lockers.filter(l => l.machineId === state.currentMachine && l.isLocked);

    if (machineLockers.length === 0) {
        alert('この自販機には商品がありません');
        return;
    }

    const totalAmount = machineLockers.reduce((sum, l) => sum + l.price, 0);
    const productCount = machineLockers.length;

    if (!confirm(`自販機${state.currentMachine}の商品を一括購入しますか？\n\n商品数: ${productCount}個\n合計金額: ¥${totalAmount}\n\n※すべての商品が売上に計上され、ロッカーは空になります。`)) {
        return;
    }

    // 各商品を売上に計上
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


// -- 購入者ロジック --

function openBuyerModal(locker) {
    state.tempAmount = 0;
    document.getElementById('buyer-product-name').textContent = locker.productName;
    document.getElementById('buyer-product-price').textContent = `¥${locker.price}`;
    updateBuyerModalUI(locker);
    openModal('buyer-modal');
}

function updateBuyerModalUI(locker = null) {
    if (!locker) {
        locker = state.data.lockers.find(l => l.id === state.selectedLockerId);
    }
    document.getElementById('inserted-amount').textContent = state.tempAmount;

    const unlockBtn = document.getElementById('unlock-btn');
    if (state.tempAmount >= locker.price) {
        unlockBtn.disabled = false;
        unlockBtn.textContent = "解錠して取り出す";
    } else {
        unlockBtn.disabled = true;
        unlockBtn.textContent = `あと${locker.price - state.tempAmount}円不足`;
    }
}

function processPurchase() {
    const locker = state.data.lockers.find(l => l.id === state.selectedLockerId);
    if (!locker) return;

    addSalesRecord(locker.productName, locker.price, locker.machineId, null, locker.machineNum, locker.coordNum, locker.hasBonus || false);

    // ロッカーを空にする
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

// -- ワンクリック購入 (Quick Purchase) --

function processQuickPurchase(locker) {
    const saleId = Date.now() + Math.random();
    addSalesRecord(locker.productName, locker.price, locker.machineId, saleId, locker.machineNum, locker.coordNum, locker.hasBonus || false);

    // ロッカーを空にする
    updateLocker(locker.id, {
        isLocked: false,
        productName: '',
        price: 0,
        insertedAmount: 0
    });

    // Undo用に記録
    state.lastPurchase = {
        lockerId: locker.id,
        saleId: saleId,
        productName: locker.productName,
        price: locker.price,
        machineId: locker.machineId
    };

    saveData();
    renderApp();
    showUndoNotification();
}

function showUndoNotification() {
    const existing = document.getElementById('undo-notification');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'undo-notification';
    el.className = 'undo-notification';
    el.innerHTML = `
        <span>購入しました</span>
        <button onclick="undoPurchase()">元に戻す</button>
    `;
    document.body.appendChild(el);

    // 5秒後に消す
    setTimeout(() => {
        if (el.parentNode) el.remove();
    }, 5000);
}

window.undoPurchase = function () {
    if (!state.lastPurchase) return;

    const lp = state.lastPurchase;
    // 売上記録を削除
    state.data.sales = state.data.sales.filter(s => s.id !== lp.saleId);

    // ロッカーを復元
    updateLocker(lp.lockerId, {
        isLocked: true,
        productName: lp.productName,
        price: lp.price,
        insertedAmount: 0
    });

    state.lastPurchase = null;
    const el = document.getElementById('undo-notification');
    if (el) el.remove();

    saveData();
    renderApp();
    alert('購入を取り消しました');
};


// -- クラウド通信ロジック --

async function fetchFromCloud(silent = false) {
    if (!state.data.cloudUrl) return;

    // 他の操作が行われている最中、または操作直後（5秒以内）は読み込まない
    if (state.isSyncing) return;
    if (Date.now() - state.lastLocalEditTime < 5000) return;

    if (!silent) console.log('Fetching from cloud...');

    try {
        state.isSyncing = true;
        const response = await fetch(state.data.cloudUrl, { cache: 'no-store' });
        const cloudData = await response.json();

        // 受信中にもしローカルで操作があったら、そのデータは破棄して中断（ローカル優先）
        if (Date.now() - state.lastLocalEditTime < 3000) {
            state.isSyncing = false;
            return;
        }

        if (cloudData && cloudData.lockers) {
            // 他ユーザーのアクティビティ確認 (1分以内)
            if (cloudData.lastActiveTime) {
                const diff = Date.now() - cloudData.lastActiveTime;
                state.otherUserActive = diff < 60000;
                document.getElementById('activity-warning').classList.toggle('hidden', !state.otherUserActive);
            }

            // 設定の同期
            if (cloudData.oneClickMode !== undefined) {
                state.oneClickMode = (cloudData.oneClickMode === true || cloudData.oneClickMode === "true");
            }

            // ローカルデータをクラウドのもので更新（日付化対策 & ソート強制）
            state.data.lockers = (cloudData.lockers || []).map(l => {
                if (!(l.coordNum && typeof l.coordNum === 'string' && l.coordNum.includes('-'))) {
                    if (l.row && l.col) l.coordNum = `${l.col}-${l.row}`;
                }
                l.machineId = parseInt(l.machineId);
                l.row = parseInt(l.row);
                l.col = parseInt(l.col);
                return l;
            });
            sortLockersCorrectly(); // ここで強制ソート

            state.data.sales = cloudData.sales || [];
            state.data.presets = cloudData.presets || state.data.presets;
            state.data.machineCount = parseInt(cloudData.machineCount) || state.data.machineCount;

            initLockers();

            saveDataLocally();
            renderApp();
            if (!silent) console.log('Cloud sync complete');
        }
    } catch (err) {
        console.error('Cloud fetch error:', err);
        if (!silent) alert('クラウドからのデータ取得に失敗しました。URLを確認してください。');
    } finally {
        state.isSyncing = false;
    }
}

async function pushToCloud() {
    if (!state.data.cloudUrl) return;

    state.isSyncing = true;
    const payload = {
        lockers: state.data.lockers,
        sales: state.data.sales,
        presets: state.data.presets,
        machineCount: state.data.machineCount,
        oneClickMode: state.oneClickMode
    };

    try {
        await fetch(state.data.cloudUrl, {
            method: 'POST',
            mode: 'no-cors', // GASへのPOSTはno-corsが必要な場合がある
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        console.log('Pushed to cloud');
    } catch (err) {
        console.error('Cloud push error:', err);
    } finally {
        state.isSyncing = false;
    }
}

function saveDataLocally() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}


// -- 共通・ヘルパー --

function updateLocker(id, Updates) {
    const idx = state.data.lockers.findIndex(l => l.id === id);
    if (idx !== -1) {
        state.data.lockers[idx] = { ...state.data.lockers[idx], ...Updates };
    }
}

// 日本時間 (JST) の日時文字列を取得
function getJSTDateTime() {
    const now = new Date();
    const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    // スプレッドシート側で文字列として認識させやすくするため、
    // または日付として誤認された際も秒まで確実に残るようにフォーマット
    return jstNow.toISOString().replace('T', ' ').replace(/\..+/, '');
}

function addSalesRecord(name, price, machineId, id = null, machineNum = null, coordNum = null, hasBonus = false) {
    state.data.sales.push({
        id: id || (Date.now() + Math.random()),
        date: getJSTDateTime(),
        productName: name,
        price: price,
        machineId: machineId,
        machineNum: machineNum,
        coordNum: coordNum,
        hasBonus: hasBonus
    });
}

function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
}

function closeModal() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m];
    });
}

// -- 管理機能（売上・プリセット・データ・自販機設定） --

function renderAdminSales() {
    const tbody = document.getElementById('sales-table-body');
    const totalEl = document.getElementById('total-sales');
    const period = document.getElementById('sales-period').value;

    tbody.innerHTML = '';

    let filtered = [...state.data.sales];
    const now = new Date();

    if (period === 'monthly') {
        filtered = filtered.filter(s => {
            const d = new Date(s.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
    } else {
        // daily (today)
        filtered = filtered.filter(s => {
            const d = new Date(s.date);
            return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
    }

    // 新しい順
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

    let sum = 0;
    filtered.forEach(sale => {
        sum += sale.price;
        const tr = document.createElement('tr');
        const d = new Date(sale.date);
        const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

        const locInfo = sale.coordNum ? `<small style="color:#888">[自販機${sale.machineNum || sale.machineId} ${sale.coordNum}]</small>` : '';
        const bonusIcon = sale.hasBonus ? '🎁 ' : '';
        tr.innerHTML = `
            <td>${dateStr}</td>
            <td>${bonusIcon}${escapeHtml(sale.productName)} ${locInfo}</td>
            <td>¥${sale.price}</td>
            <td><button class="delete-record-btn" onclick="deleteSale(${sale.id})">削除</button></td>
        `;
        tbody.appendChild(tr);
    });

    totalEl.textContent = `合計: ¥${sum}`;
}

// グローバルスコープに公開（HTMLのonclickから呼ぶため）
window.deleteSale = function (id) {
    if (!confirm('この売上記録を削除しますか？')) return;
    // クラウド経由でIDが文字列になっている場合があるため、文字列に変換して比較する
    state.data.sales = state.data.sales.filter(s => String(s.id) !== String(id));
    saveData();
    renderApp();
};

function clearAllSales() {
    if (!confirm('すべての売上データを削除しますか？\n（テストデータの消去などに使用してください）')) return;
    state.data.sales = [];
    saveData();
    renderApp();
    alert('売上データをすべて削除しました');
}

function renderAdminPresets() {
    const list = document.getElementById('edit-preset-list');
    list.innerHTML = '';

    state.data.presets.forEach((p, index) => {
        const div = document.createElement('div');
        div.className = 'preset-list-item';
        div.innerHTML = `
            <span>${escapeHtml(p)}</span>
            <button class="remove-preset-btn" onclick="removePreset(${index})">&times;</button>
        `;
        list.appendChild(div);
    });
}

function addPreset() {
    const input = document.getElementById('new-preset-name');
    const val = input.value.trim();
    if (val) {
        state.data.presets.push(val);
        input.value = '';
        saveData();
        renderAdminPresets();
    }
}

window.removePreset = function (index) {
    if (!confirm('削除しますか？')) return;
    state.data.presets.splice(index, 1);
    saveData();
    renderAdminPresets();
};

// -- 金額プリセット管理 --
function renderAdminPricePresets() {
    const list = document.getElementById('edit-price-preset-list');
    if (!list) return;
    list.innerHTML = '';

    const presets = state.data.pricePresets || DEFAULT_PRICE_PRESETS;
    presets.forEach((p, index) => {
        const div = document.createElement('div');
        div.className = 'preset-list-item';
        div.innerHTML = `
            <span>¥${p}</span>
            <button class="remove-preset-btn" onclick="removePricePreset(${index})">&times;</button>
        `;
        list.appendChild(div);
    });
}

function addPricePreset() {
    const input = document.getElementById('new-price-preset');
    const val = parseInt(input.value.trim());
    if (val && val > 0) {
        if (!state.data.pricePresets) state.data.pricePresets = [...DEFAULT_PRICE_PRESETS];
        if (state.data.pricePresets.includes(val)) {
            alert('この金額は既に登録されています');
            return;
        }
        state.data.pricePresets.push(val);
        state.data.pricePresets.sort((a, b) => a - b); // 昇順ソート
        input.value = '';
        saveData();
        renderAdminPricePresets();
    }
}

window.removePricePreset = function (index) {
    if (!confirm('削除しますか？')) return;
    if (!state.data.pricePresets) state.data.pricePresets = [...DEFAULT_PRICE_PRESETS];
    state.data.pricePresets.splice(index, 1);
    saveData();
    renderAdminPricePresets();
};

function renderMachineSettings() {
    document.getElementById('machine-count').textContent = state.data.machineCount;
    document.getElementById('one-click-toggle').checked = state.oneClickMode;
    document.getElementById('auto-sync-toggle').checked = state.data.autoSync;
    document.getElementById('cloud-url-input').value = state.data.cloudUrl || '';
}

function renderDataSettings() {
    // データ系のUI更新があればここ
}

function addMachine() {
    state.data.machineCount++;
    // 新しい自販機のロッカーを生成
    const m = state.data.machineCount;
    for (let r = 1; r <= TOTAL_ROWS; r++) {
        for (let c = 1; c <= TOTAL_COLS; c++) {
            state.data.lockers.push({
                id: `${m}-${r}-${c}`,
                machineId: m,
                row: r,
                col: c,
                isLocked: false,
                productName: '',
                price: 0,
                insertedAmount: 0
            });
        }
    }
    saveData();
    renderApp();
    alert(`自販機${m}を追加しました`);
}

function removeMachine() {
    if (state.data.machineCount <= 1) {
        alert('最低1台は必要です');
        return;
    }

    const m = state.data.machineCount;
    const machineLockers = state.data.lockers.filter(l => l.machineId === m);
    const hasProducts = machineLockers.some(l => l.isLocked);

    if (hasProducts) {
        if (!confirm(`自販機${m}には商品が入っています。削除すると商品データも消えますが、よろしいですか？`)) {
            return;
        }
    } else {
        if (!confirm(`自販機${m}を削除しますか？`)) {
            return;
        }
    }

    // ロッカーデータを削除
    state.data.lockers = state.data.lockers.filter(l => l.machineId !== m);
    state.data.machineCount--;

    // 削除した自販機を表示中だった場合は1に戻す
    if (state.currentMachine > state.data.machineCount) {
        state.currentMachine = 1;
    }

    saveData();
    renderApp();
    alert(`自販機${m}を削除しました`);
}


function downloadData() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.data));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "vending_machine_data.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

function uploadData() {
    const input = document.getElementById('upload-data-input');
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const json = JSON.parse(e.target.result);
            if (json && json.lockers) {
                state.data = json;
                // マイグレーション
                if (!state.data.machineCount) {
                    // 既存のロッカーから最大machineIdを取得
                    const maxMachine = Math.max(...state.data.lockers.map(l => l.machineId));
                    state.data.machineCount = maxMachine || 2;
                }
                saveData();
                renderApp();
                alert('データを取り込みました');
            } else {
                alert('データ形式が正しくありません');
            }
        } catch (err) {
            console.error(err);
            alert('ファイルの読み込みに失敗しました');
        }
        input.value = '';
    };
    reader.readAsText(file);
}

// ---------------------------------------------------------
// 画面の向き制御 (JS実装)
// ---------------------------------------------------------
function initOrientationControl() {
    const warningEl = document.getElementById('orientation-warning');
    if (!warningEl) return;

    const checkOrientation = () => {
        // 1. 入力中（キーボード表示中）は警告を出さない
        const activeTag = document.activeElement ? document.activeElement.tagName : '';
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
            warningEl.classList.remove('visible');
            document.body.style.overflow = '';
            return;
        }

        // 2. 向きの判定
        let isLandscape = false;

        // Modern API
        if (screen.orientation && screen.orientation.type) {
            isLandscape = screen.orientation.type.includes('landscape');
        }
        // iOS / Older WebKit
        else if (typeof window.orientation !== 'undefined') {
            isLandscape = (Math.abs(window.orientation) === 90);
        }
        // Fallback (サイズ比)
        else {
            isLandscape = (window.innerWidth > window.innerHeight);
        }

        // 3. PC（幅広かつ高さもある）の場合は除外したいが、
        // 今回の要件は「スマホで横にしたら警告」なので、
        // 画面幅がモバイルサイズ(900px以下)の場合のみ警告を出す
        if (window.innerWidth > 900) {
            isLandscape = false;
        }

        // 4. 表示切り替え
        if (isLandscape) {
            warningEl.classList.add('visible');
            document.body.style.overflow = 'hidden'; // スクロール防止
        } else {
            warningEl.classList.remove('visible');
            document.body.style.overflow = '';
        }
    };

    // イベントリスナー登録
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);

    // 入力フォーカスの変化でも再チェック（キーボード開閉直後の誤判定防止）
    document.addEventListener('focusin', () => {
        // フォーカス時は即座に警告を消す
        warningEl.classList.remove('visible');
        document.body.style.overflow = '';
    });

    document.addEventListener('focusout', () => {
        // フォーカスが外れたら少し待ってからチェック（キーボードが閉じる時間を考慮）
        setTimeout(checkOrientation, 300);
    });

    // 初期チェック
    checkOrientation();
}

// 起動時に設定
document.addEventListener('DOMContentLoaded', initOrientationControl);

