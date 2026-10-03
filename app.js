/**
 * 自動販売機管理アプリ
 * Logic for Vending Machine
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
        lockers: [], 
        sales: [],   
        presets: [...DEFAULT_PRESETS],
        pricePresets: [...DEFAULT_PRICE_PRESETS],
        machineCount: 2,
        machineNames: {}, // { "1": "店舗前", "2": "駐車場" }
        cloudUrl: '',
        autoSync: true,
        oneClickMode: false
    },
    // UI状態（保存しない）
    currentMachine: 1,
    mode: 'seller', // 'buyer', 'seller', 'admin'
    selectedLockerId: null,
    tempPrice: 100,
    tempAmount: 0, 
    // コピーモード
    copyMode: false,
    copyProduct: null,
    copySourceLockerId: null,
    lastPurchase: null,
    isSyncing: false,
    lastLocalEditTime: 0,
    isDirty: false // クラウドへの送信待ちフラグ
};

// グラフインスタンス保持用
let productChartInst = null;
let timeChartInst = null;

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    initLockers();
    renderApp();
    setupEventListeners();

    if (state.data.cloudUrl) {
        fetchFromCloud();
    }

    // 定期同期設定
    setInterval(() => {
        const isModalOpen = !document.getElementById('seller-modal').classList.contains('hidden') ||
            !document.getElementById('buyer-modal').classList.contains('hidden');

        // 編集中やコピー中、送信待ちデータがある場合は同期しない
        if (state.data.cloudUrl && state.data.autoSync && !state.copyMode && !isModalOpen && !state.isDirty) {
            fetchFromCloud(true);
        }
    }, 15000);
});

function loadData() {
    const json = localStorage.getItem(STORAGE_KEY);
    if (json) {
        try {
            const parsed = JSON.parse(json);
            state.data = { ...state.data, ...parsed };
            if (state.data.autoSync === undefined) state.data.autoSync = true;
            if (!state.data.presets) state.data.presets = [...DEFAULT_PRESETS];
            if (!state.data.machineCount) state.data.machineCount = 2;
            if (!state.data.pricePresets) state.data.pricePresets = [...DEFAULT_PRICE_PRESETS];
            if (state.data.oneClickMode === undefined) state.data.oneClickMode = false;
            if (!state.data.machineNames) state.data.machineNames = {};
        } catch (e) {
            console.error('データ読み込みエラー', e);
        }
    }
}

function saveData() {
    state.lastLocalEditTime = Date.now();
    state.isDirty = true; // 送信待ち状態にする
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    if (state.data.cloudUrl) {
        pushToCloud();
    }
}

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
    // バグ修正: undefined な coordNum を持つロッカーの救済
    state.data.lockers.forEach(l => {
        if (!l.coordNum) l.coordNum = `${l.col}-${l.row}`;
        if (!l.machineNum) l.machineNum = l.machineId;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}

function sortLockersCorrectly() {
    state.data.lockers.sort((a, b) => {
        if (a.machineId !== b.machineId) return a.machineId - b.machineId;
        if (a.row !== b.row) return a.row - b.row;
        return b.col - a.col;
    });
}

function createLockersForMachine(m) {
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

function getMachineName(m) {
    return state.data.machineNames[m] || `自販機${m}`;
}

// レンダリング
function renderApp() {
    renderHeader();
    renderMachineTabs();

    const vendingView = document.getElementById('vending-view');
    const adminView = document.getElementById('admin-view');

    if (state.mode === 'admin') {
        vendingView.classList.add('hidden');
        adminView.classList.remove('hidden');
        renderAdminSales();
        renderAdminPresets();
        renderAdminPricePresets();
        renderMachineSettings();
        renderDataSettings();
        renderAnalytics();
    } else {
        vendingView.classList.remove('hidden');
        adminView.classList.add('hidden');
        renderLockers();
        renderBulkPurchaseArea();
        renderSalesSummary();
        renderCopyModeIndicator();
    }
}

function renderHeader() {
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`mode-${state.mode}`).classList.add('active');
}

function renderMachineTabs() {
    const container = document.getElementById('machine-switch');
    container.innerHTML = '';
    
    // 管理モードの時はタブを非表示にする等の制御も可能だが、
    // 今回は管理モードでもタブを出しておく（自販機ごとの設定切り替え等に使う可能性を考慮）
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
            const products = locker.productName.split('\n').filter(p => p.trim());
            const productCount = products.length;
            let fontSizeClass = '';
            if (productCount >= 3) fontSizeClass = ' locker-product-sm';
            else if (productCount >= 2) fontSizeClass = ' locker-product-md';

            const priceColorClass = getPriceColorClass(locker.price);
            if (priceColorClass) el.classList.add(priceColorClass);

            const productHtml = products.map(p => escapeHtml(p)).join('<br>');
            contentDiv.innerHTML = `
                <div class="locker-product${fontSizeClass}">${productHtml}</div>
                <div class="locker-price">¥${locker.price}</div>
            `;

            if (locker.hasBonus === true || locker.hasBonus === 'true') {
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

// イベントハンドリング
function setupEventListeners() {
    document.getElementById('mode-buyer').onclick = () => setMode('buyer');
    document.getElementById('mode-seller').onclick = () => setMode('seller');
    document.getElementById('mode-admin').onclick = () => setMode('admin');

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

    // --- 管理タブ (Admin View 内) ---
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

    document.getElementById('add-preset-btn').onclick = addPreset;
    const addPricePresetBtn = document.getElementById('add-price-preset-btn');
    if (addPricePresetBtn) addPricePresetBtn.onclick = addPricePreset;

    document.getElementById('add-machine-btn').onclick = addMachine;
    document.getElementById('remove-machine-btn').onclick = removeMachine;

    document.getElementById('download-data-btn').onclick = downloadData;
    document.getElementById('upload-data-btn').onclick = () => document.getElementById('upload-data-input').click();
    document.getElementById('upload-data-input').onchange = uploadData;

    document.getElementById('sales-period').onchange = renderAdminSales;

    document.getElementById('one-click-toggle').onchange = (e) => {
        state.data.oneClickMode = e.target.checked;
        saveData();
    };

    document.getElementById('clear-all-sales-btn').onclick = clearAllSales;

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

    document.getElementById('auto-sync-toggle').onchange = (e) => {
        state.data.autoSync = e.target.checked;
        saveData();
    };

    document.getElementById('manual-sync-btn').onclick = () => {
        if (!state.data.cloudUrl) return alert('クラウドURLが設定されていません');
        fetchFromCloud();
    };
}

// アクションロジック
function setMode(mode) {
    state.mode = mode;
    state.copyMode = false;
    state.copyProduct = null;
    state.copySourceLockerId = null;
    renderApp();
}

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
        registerBtn.textContent = "更新";
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
        registerBtn.textContent = "登録して施錠";
        if (bonusToggle) bonusToggle.checked = defaultBonus;
    }

    renderPresetButtons();
    renderPriceButtons();
    updateAddProductBtnVisibility();
    updatePriceDisplay();
    updatePriceButtonSelection();
    openModal('seller-modal');
}

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

function updateAddProductBtnVisibility() {
    const container = document.getElementById('product-inputs-container');
    const addBtn = document.getElementById('add-product-btn');
    if (!addBtn || !container) return;
    const currentRows = container.querySelectorAll('.product-input-row');
    addBtn.style.display = currentRows.length >= 3 ? 'none' : '';
}

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
    state.copySourceLockerId = locker.id;
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
    state.copySourceLockerId = null;
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
    const inputContainer = document.getElementById('product-inputs-container');
    const inputNames = inputContainer
        ? [...inputContainer.querySelectorAll('.product-name-input')].map(i => i.value.trim()).filter(v => v)
        : [];
    const presetNames = state.selectedPresets ? [...state.selectedPresets] : [];
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

function processQuickPurchase(locker) {
    const saleId = Date.now() + Math.random();
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
    setTimeout(() => {
        if (el.parentNode) el.remove();
    }, 5000);
}

window.undoPurchase = function () {
    if (!state.lastPurchase) return;
    const lp = state.lastPurchase;
    state.data.sales = state.data.sales.filter(s => s.id !== lp.saleId);
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

async function fetchFromCloud(silent = false) {
    if (!state.data.cloudUrl) return;
    if (state.isSyncing) return;
    
    // 送信待ちのデータがある場合は上書きを防ぐ（楽観的排他制御）
    if (state.isDirty) {
        if (!silent) console.log('Pending local changes exist. Skipping fetch.');
        return; 
    }

    if (!silent) console.log('Fetching from cloud...');
    try {
        state.isSyncing = true;
        const response = await fetch(state.data.cloudUrl, { cache: 'no-store' });
        const cloudData = await response.json();

        // 取得中にローカルで新たな操作が行われた場合は破棄
        if (state.isDirty) {
            state.isSyncing = false;
            return;
        }

        if (cloudData && cloudData.lockers) {
            if (cloudData.lastActiveTime) {
                const diff = Date.now() - cloudData.lastActiveTime;
                document.getElementById('activity-warning').classList.toggle('hidden', diff < 60000);
            }
            if (cloudData.oneClickMode !== undefined) {
                state.data.oneClickMode = (cloudData.oneClickMode === true || cloudData.oneClickMode === "true");
            }
            state.data.lockers = (cloudData.lockers || []).map(l => {
                if (!(l.coordNum && typeof l.coordNum === 'string' && l.coordNum.includes('-'))) {
                    if (l.row && l.col) l.coordNum = `${l.col}-${l.row}`;
                }
                l.machineId = parseInt(l.machineId);
                l.row = parseInt(l.row);
                l.col = parseInt(l.col);
                return l;
            });
            sortLockersCorrectly();

            state.data.sales = cloudData.sales || [];
            state.data.presets = cloudData.presets || state.data.presets;
            state.data.machineCount = parseInt(cloudData.machineCount) || state.data.machineCount;

            initLockers();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
            renderApp();
            if (!silent) console.log('Cloud sync complete');
        }
    } catch (err) {
        console.error('Cloud fetch error:', err);
        if (!silent) alert('クラウドからのデータ取得に失敗しました。');
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
        oneClickMode: state.data.oneClickMode
    };
    try {
        await fetch(state.data.cloudUrl, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log('Pushed to cloud');
        state.isDirty = false; // 送信成功
    } catch (err) {
        console.error('Cloud push error:', err);
        // エラー時は isDirty を true のままにし、次回同期で再送する
    } finally {
        state.isSyncing = false;
    }
}

function getPriceColorClass(price) {
    if (price <= 100) return 'price-tier-1';
    if (price <= 200) return 'price-tier-2';
    if (price <= 300) return 'price-tier-3';
    if (price <= 400) return 'price-tier-4';
    return 'price-tier-5';
}

function processBulkClear() {
    const machineLockers = state.data.lockers.filter(l => l.machineId === state.currentMachine && l.isLocked);
    if (machineLockers.length === 0) return alert('この自販機には商品がありません');
    if (!confirm(`自販機${state.currentMachine}の商品を一括削除しますか？\n\n※売上には計上されません。`)) return;

    machineLockers.forEach(locker => {
        updateLocker(locker.id, {
            isLocked: false, productName: '', price: 0, hasBonus: false, insertedAmount: 0
        });
    });
    saveData();
    renderApp();
}

function updateLocker(id, Updates) {
    const idx = state.data.lockers.findIndex(l => l.id === id);
    if (idx !== -1) {
        state.data.lockers[idx] = { ...state.data.lockers[idx], ...Updates };
    }
}

function getJSTDateTime() {
    const now = new Date();
    const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
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
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
}

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
        filtered = filtered.filter(s => {
            const d = new Date(s.date);
            return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
    }

    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

    let sum = 0;
    filtered.forEach(sale => {
        sum += sale.price;
        const tr = document.createElement('tr');
        const d = new Date(sale.date);
        const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

        const locInfo = sale.coordNum ? `<small style="color:#888">[${getMachineName(sale.machineNum || sale.machineId)} ${sale.coordNum}]</small>` : '';
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

window.deleteSale = function (id) {
    if (!confirm('この売上記録を削除しますか？')) return;
    state.data.sales = state.data.sales.filter(s => String(s.id) !== String(id));
    saveData();
    renderApp();
};

function clearAllSales() {
    if (!confirm('すべての売上データを削除しますか？')) return;
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
        if (state.data.pricePresets.includes(val)) return alert('この金額は既に登録されています');
        state.data.pricePresets.push(val);
        state.data.pricePresets.sort((a, b) => a - b);
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
    document.getElementById('one-click-toggle').checked = state.data.oneClickMode;
    document.getElementById('auto-sync-toggle').checked = state.data.autoSync;
    document.getElementById('cloud-url-input').value = state.data.cloudUrl || '';

    // 名称設定リスト
    const list = document.getElementById('machine-names-list');
    if (list) {
        list.innerHTML = '<p>各自販機の名称設定:</p>';
        for (let m = 1; m <= state.data.machineCount; m++) {
            const div = document.createElement('div');
            div.className = 'machine-name-item';
            div.innerHTML = `
                <span>ID ${m}:</span>
                <input type="text" id="machine-name-input-${m}" value="${escapeHtml(getMachineName(m))}" placeholder="自販機${m}">
                <button class="action-btn primary" style="padding: 8px 12px; margin: 0; width: auto;" onclick="saveMachineName(${m})">保存</button>
            `;
            list.appendChild(div);
        }
    }
}

window.saveMachineName = function(m) {
    const input = document.getElementById(`machine-name-input-${m}`);
    if (input) {
        const val = input.value.trim();
        if (val) {
            state.data.machineNames[m] = val;
        } else {
            delete state.data.machineNames[m];
        }
        saveData();
        renderMachineTabs();
        alert('保存しました');
    }
};

function renderDataSettings() {}

function addMachine() {
    state.data.machineCount++;
    const m = state.data.machineCount;
    createLockersForMachine(m);
    saveData();
    renderApp();
    alert(`自販機${m}を追加しました`);
}

function removeMachine() {
    if (state.data.machineCount <= 1) return alert('最低1台は必要です');
    const m = state.data.machineCount;
    const machineLockers = state.data.lockers.filter(l => l.machineId === m);
    const hasProducts = machineLockers.some(l => l.isLocked);

    if (hasProducts && !confirm(`自販機${m}には商品が入っています。削除すると商品データも消えますが、よろしいですか？`)) return;
    if (!hasProducts && !confirm(`自販機${m}を削除しますか？`)) return;

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
                if (!state.data.machineCount) {
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
            alert('ファイルの読み込みに失敗しました');
        }
        input.value = '';
    };
    reader.readAsText(file);
}

// ---------------------------------------------------------
// 分析チャート (Chart.js)
// ---------------------------------------------------------
function renderAnalytics() {
    if (typeof Chart === 'undefined') return;

    const now = new Date();
    // 今月の売上に絞る
    const currentMonthSales = state.data.sales.filter(s => {
        const d = new Date(s.date);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });

    // --- 商品別集計 ---
    const productCounts = {};
    currentMonthSales.forEach(s => {
        const names = s.productName.split('\n').map(n=>n.trim()).filter(n=>n);
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

    // --- 時間帯別集計 ---
    const timeCounts = new Array(24).fill(0);
    currentMonthSales.forEach(s => {
        const d = new Date(s.date);
        timeCounts[d.getHours()]++;
    });

    if (timeChartInst) timeChartInst.destroy();
    const ctxBar = document.getElementById('timeBarChart').getContext('2d');
    timeChartInst = new Chart(ctxBar, {
        type: 'bar',
        data: {
            labels: Array.from({length: 24}, (_, i) => `${i}時`),
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
// 画面の向き制御 (緩和)
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

        // スマホ(縦に細長い端末)を横にした時だけ警告する。
        // iPad等のタブレット（幅が広い、または高さが十分ある）は許容する。
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
