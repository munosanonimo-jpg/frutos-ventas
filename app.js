/* Control offline de catálogo, jornadas y reportes. */
const STORAGE_KEY = 'frutosecos_db';
const EMPTY_DB = () => ({ schemaVersion: 1, products: [], dailySales: [], saleEntries: [] });
const CLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
const byId = (id) => document.getElementById(id);
const todayISO = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; };
const monthISO = () => todayISO().slice(0, 7);
const makeId = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : `producto-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Storage: el primer acceso crea una base local vacía.
const Storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { const fresh = EMPTY_DB(); this.save(fresh); return fresh; }
      const parsed = JSON.parse(raw);
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.products) || !Array.isArray(parsed.dailySales)) throw new Error('La base guardada no tiene la estructura requerida.');
      if (parsed.saleEntries === undefined) { parsed.saleEntries = []; this.save(parsed); }
      if (!Array.isArray(parsed.saleEntries)) throw new Error('La lista de ventas individuales no es válida.');
      return parsed;
      return EMPTY_DB();
    } catch (error) { console.error('No se pudo leer el almacenamiento local.', error); return EMPTY_DB(); }
  },
  save(value) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); return true; }
    catch (error) { console.error('No se pudo guardar el almacenamiento local.', error); showToast('No se pudieron guardar los datos'); return false; }
  }
};

let db = Storage.load();
let activeTab = 'catalog';
let toastTimer;
let pendingQuantities = new Map();
let editingSale = null;
let editingItemSnapshots = new Map();
let editingKind = null;

const Products = {
  active() { return db.products.filter((product) => product.active); },
  add(name, price) {
    if (this.active().some((product) => product.name.trim().toLocaleLowerCase('es-CL') === name.trim().toLocaleLowerCase('es-CL'))) throw new Error('Ya existe un producto activo con ese nombre.');
    db.products.push({ id: makeId(), name: name.trim(), price, packageGrams: 80, active: true, createdAt: new Date().toISOString() });
    return Storage.save(db);
  },
  edit(id, name, price) {
    if (this.active().some((product) => product.id !== id && product.name.trim().toLocaleLowerCase('es-CL') === name.trim().toLocaleLowerCase('es-CL'))) throw new Error('Ya existe un producto activo con ese nombre.');
    const product = db.products.find((entry) => entry.id === id && entry.active);
    if (!product) throw new Error('No encontramos ese producto activo.');
    product.name = name.trim(); product.price = price;
    return Storage.save(db);
  },
  deactivate(id) {
    const product = db.products.find((entry) => entry.id === id && entry.active);
    if (!product) return false;
    product.active = false;
    return Storage.save(db);
  }
};

// Sales: las jornadas antiguas y las ventas individuales mantienen historiales separados.
const Sales = {
  find(date) { return db.dailySales.find((sale) => sale.date === date); },
  entries(date) { return db.saleEntries.filter((sale) => sale.date === date).sort((a, b) => a.time.localeCompare(b.time) || a.createdAt.localeCompare(b.createdAt)); },
  currentItems() {
    const items = [];
    for (const product of Products.active()) {
      const quantity = pendingQuantities.get(product.id) || 0;
      if (!quantity) continue;
      const original = editingItemSnapshots.get(product.id);
      const unitPrice = original?.unitPrice ?? product.price;
      const productName = original?.productName ?? product.name;
      items.push({ productId: product.id, productName, unitPrice, quantity, subtotal: unitPrice * quantity });
    }
    for (const [productId, original] of editingItemSnapshots) {
      if (Products.active().some((product) => product.id === productId) || !original.quantity) continue;
      const quantity = pendingQuantities.get(productId) || 0;
      if (quantity) items.push({ ...original, quantity, subtotal: original.unitPrice * quantity });
    }
    return items;
  },
  fillQuantities(items) {
    pendingQuantities = new Map(Products.active().map((product) => [product.id, 0]));
    for (const item of items || []) pendingQuantities.set(item.productId, item.quantity);
    this.renderProducts(); this.renderTotals();
  },
  loadDraft(date) {
    if (editingSale) this.cancelEdit(false);
    this.fillQuantities([]); this.renderEntries(date);
  },
  calculate() {
    const items = this.currentItems();
    return { items, totalAmount: items.reduce((sum, item) => sum + item.subtotal, 0), totalPackages: items.reduce((sum, item) => sum + item.quantity, 0) };
  },
  saveEntry(date) {
    const totals = this.calculate(); const now = new Date(); const stamp = now.toISOString();
    const sale = { id: editingSale?.id || makeId(), date, time: editingSale ? byId('saleTime').value : `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, ...totals, createdAt: editingSale?.createdAt || stamp, updatedAt: stamp };
    if (editingSale && editingKind === 'entry') { const index = db.saleEntries.findIndex((entry) => entry.id === editingSale.id); if (index >= 0) db.saleEntries[index] = sale; }
    else if (editingSale && editingKind === 'daily') { const index = db.dailySales.findIndex((entry) => entry.id === editingSale.id); if (index >= 0) db.dailySales[index] = { ...sale, updatedAt: stamp }; }
    else db.saleEntries.push(sale);
    const wasEditing = Boolean(editingSale);
    if (!Storage.save(db)) return false;
    this.finishEdit(); this.fillQuantities([]); this.renderEntries(date); this.renderTotals();
    return wasEditing ? 'edited' : 'created';
  },
  removeEntry(id) { db.saleEntries = db.saleEntries.filter((sale) => sale.id !== id); const saved = Storage.save(db); if (saved) { this.renderEntries(byId('saleDate').value); Reports.render(byId('reportMonth').value); } return saved; },
  remove(date) { db.dailySales = db.dailySales.filter((sale) => sale.date !== date); const saved = Storage.save(db); if (saved) { this.renderEntries(date); Reports.render(byId('reportMonth').value); } return saved; },
  beginEdit(sale, kind) {
    editingSale = sale; editingKind = kind; editingItemSnapshots = new Map(sale.items.map((item) => [item.productId, item]));
    this.fillQuantities(sale.items); byId('saleTimeField').classList.toggle('hidden', kind === 'daily');
    byId('saleTime').value = sale.time || '12:00'; byId('saveSaleButton').textContent = 'Guardar cambios'; byId('saveSaleButton').disabled = false;
    byId('cancelEditButton').classList.remove('hidden'); byId('saleDateHint').textContent = 'Editando una venta guardada.'; this.renderEntries(byId('saleDate').value);
  },
  finishEdit() {
    editingSale = null; editingKind = null; editingItemSnapshots = new Map();
    byId('saleTimeField').classList.add('hidden'); byId('saveSaleButton').textContent = 'Registrar venta'; byId('cancelEditButton').classList.add('hidden');
  },
  cancelEdit() { this.finishEdit(); this.fillQuantities([]); this.renderEntries(byId('saleDate').value); byId('saleDateHint').textContent = 'Edición cancelada.'; },
  renderEntries(date) {
    const list = byId('saleEntriesList'); list.replaceChildren();
    const dayEntries = this.entries(date); const daily = this.find(date);
    const total = dayEntries.reduce((sum, sale) => sum + sale.totalAmount, 0) + (daily?.totalAmount || 0);
    byId('registeredDayTotal').textContent = CLP.format(total);
    for (const sale of [...dayEntries].sort((a, b) => b.time.localeCompare(a.time))) list.append(this.entryRow(sale, false));
    if (daily) list.append(this.entryRow(daily, true));
    byId('saleEntriesEmpty').classList.toggle('hidden', dayEntries.length > 0 || !daily);
  },
  entryRow(sale, daily) {
    const row = document.createElement('article'); row.className = 'sale-entry-row';
    const details = document.createElement('div'); details.className = 'sale-entry-details';
    const when = document.createElement('strong'); when.textContent = daily ? 'Jornada completa (sin hora)' : sale.time;
    const summary = document.createElement('span'); summary.textContent = sale.items.map((item) => `${item.quantity} × ${item.productName}`).join(', ');
    const amount = document.createElement('b'); amount.textContent = CLP.format(sale.totalAmount); details.append(when, summary, amount);
    const actions = document.createElement('div'); actions.className = 'sale-entry-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'small-action'; edit.textContent = 'Editar'; edit.addEventListener('click', () => this.beginEdit(sale, daily ? 'daily' : 'entry'));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'small-action delete'; remove.textContent = 'Eliminar'; remove.addEventListener('click', () => { if (!confirm(`¿Eliminar esta ${daily ? 'jornada' : 'venta'} del ${formatDate(sale.date)}? Esta acción no se puede deshacer.`)) return; if (daily ? this.remove(sale.date) : this.removeEntry(sale.id)) showToast('Registro eliminado'); });
    actions.append(edit, remove); row.append(details, actions); return row;
  },
  renderProducts() {
    const list = byId('salesList'); list.replaceChildren();
    const visibleProducts = [...Products.active()];
    for (const [productId, item] of editingItemSnapshots) if (!visibleProducts.some((product) => product.id === productId)) visibleProducts.push({ id: productId, name: item.productName, price: item.unitPrice, packageGrams: 80, active: false });
    for (const product of visibleProducts) {
      const card = document.createElement('article'); card.className = 'sales-product-card';
      const info = document.createElement('div'); info.className = 'product-info';
      const name = document.createElement('h3'); name.textContent = product.name;
      const original = editingItemSnapshots.get(product.id); const shownPrice = original?.unitPrice ?? product.price;
      const price = document.createElement('span'); price.className = 'product-price'; price.textContent = `${CLP.format(shownPrice)} · 80 g${product.active ? '' : ' · dado de baja'}`;
      const subtotal = document.createElement('p'); subtotal.className = 'muted item-subtotal'; subtotal.textContent = `Subtotal: ${CLP.format(shownPrice * (pendingQuantities.get(product.id) || 0))}`;
      info.append(name, price, subtotal);
      const controls = document.createElement('div'); controls.className = 'quantity-control';
      const minus = document.createElement('button'); minus.className = 'quantity-button'; minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', `Restar ${product.name}`);
      const input = document.createElement('input'); input.className = 'quantity-input'; input.type = 'number'; input.min = '0'; input.step = '1'; input.inputMode = 'numeric'; input.value = String(pendingQuantities.get(product.id) || 0); input.setAttribute('aria-label', `Cantidad de ${product.name}`);
      const plus = document.createElement('button'); plus.className = 'quantity-button'; plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', `Sumar ${product.name}`);
      if (!product.active && editingSale) { minus.disabled = true; plus.disabled = true; input.disabled = true; }
      const update = (value) => { const quantity = Number.isInteger(value) && value >= 0 ? value : 0; pendingQuantities.set(product.id, quantity); input.value = String(quantity); subtotal.textContent = `Subtotal: ${CLP.format(shownPrice * quantity)}`; this.renderTotals(); };
      minus.addEventListener('click', () => update((pendingQuantities.get(product.id) || 0) - 1)); plus.addEventListener('click', () => update((pendingQuantities.get(product.id) || 0) + 1));
      input.addEventListener('input', () => { if (input.value === '') { pendingQuantities.set(product.id, 0); subtotal.textContent = `Subtotal: ${CLP.format(0)}`; this.renderTotals(); return; } const value = Number(input.value); if (Number.isInteger(value) && value >= 0) update(value); });
      input.addEventListener('blur', () => { if (!input.value || !Number.isInteger(Number(input.value)) || Number(input.value) < 0) update(0); });
      controls.append(minus, input, plus); card.append(info, controls); list.append(card);
    }
    byId('salesEmpty').classList.toggle('hidden', Products.active().length > 0);
  },
  renderTotals() { const totals = this.calculate(); byId('saleTotal').textContent = CLP.format(totals.totalAmount); byId('packageTotal').textContent = String(totals.totalPackages); byId('saveSaleButton').disabled = totals.totalPackages === 0; }
};

// Reports: todos los valores se derivan de ambos tipos de registros.
const Reports = {
  render(month) {
    const daily = db.dailySales.filter((sale) => sale.date.startsWith(month));
    const entries = db.saleEntries.filter((sale) => sale.date.startsWith(month));
    const sales = [...daily, ...entries];
    const total = sales.reduce((sum, sale) => sum + sale.totalAmount, 0);
    const packages = sales.reduce((sum, sale) => sum + sale.totalPackages, 0);
    const dates = new Set(sales.map((sale) => sale.date));
    byId('monthTotal').textContent = CLP.format(total); byId('monthPackages').textContent = String(packages); byId('monthDays').textContent = String(dates.size); byId('monthAverage').textContent = CLP.format(dates.size ? Math.round(total / dates.size) : 0);
    const products = new Map();
    for (const sale of sales) for (const item of sale.items) {
      const row = products.get(item.productId) || { name: item.productName, packages: 0, income: 0 };
      row.packages += item.quantity; row.income += item.subtotal; products.set(item.productId, row);
    }
    const ordered = [...products.values()].sort((a, b) => b.income - a.income);
    byId('productReport').replaceChildren(); byId('productReportEmpty').classList.toggle('hidden', ordered.length > 0);
    if (ordered.length) {
      const table = document.createElement('table'); const head = document.createElement('thead'); const headerRow = document.createElement('tr');
      for (const label of ['Producto', 'Paquetes', 'Ingresos']) { const th = document.createElement('th'); th.textContent = label; headerRow.append(th); }
      head.append(headerRow); const body = document.createElement('tbody');
      for (const item of ordered) { const row = document.createElement('tr'); for (const value of [item.name, String(item.packages), CLP.format(item.income)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } body.append(row); }
      table.append(head, body); byId('productReport').append(table);
    }
    const perDay = new Map();
    for (const sale of sales) { const row = perDay.get(sale.date) || { date: sale.date, totalAmount: 0, totalPackages: 0 }; row.totalAmount += sale.totalAmount; row.totalPackages += sale.totalPackages; perDay.set(sale.date, row); }
    const dayList = byId('dayReport'); dayList.replaceChildren(); const sorted = [...perDay.values()].sort((a, b) => b.date.localeCompare(a.date));
    byId('dayReportEmpty').classList.toggle('hidden', sorted.length > 0);
    for (const sale of sorted) { const row = document.createElement('button'); row.type = 'button'; row.className = 'day-row'; row.dataset.date = sale.date; const date = document.createElement('time'); date.dateTime = sale.date; date.textContent = formatDate(sale.date); const count = document.createElement('span'); count.className = 'day-packages'; count.textContent = `${sale.totalPackages} paquetes`; const amount = document.createElement('strong'); amount.textContent = CLP.format(sale.totalAmount); const arrow = document.createElement('span'); arrow.className = 'day-arrow'; arrow.textContent = '›'; row.append(date, count, amount, arrow); dayList.append(row); }
  }
};

function formatDate(iso) { return new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`)); }
function showToast(message) { const toast = byId('toast'); toast.textContent = message; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600); }
function renderCatalog() {
  const list = byId('catalogList'); list.replaceChildren(); const active = Products.active(); byId('catalogPanel').classList.toggle('has-products', active.length > 0); byId('productCount').textContent = `${active.length} ${active.length === 1 ? 'activo' : 'activos'}`; byId('catalogEmpty').classList.toggle('hidden', active.length > 0);
  for (const product of active) {
    const card = document.createElement('article'); card.className = 'product-card'; const icon = document.createElement('span'); icon.className = 'product-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '🥜';
    const info = document.createElement('div'); info.className = 'product-info'; const name = document.createElement('h3'); name.textContent = product.name; const grams = document.createElement('p'); grams.textContent = `Paquete ${product.packageGrams} g`; info.append(name, grams);
    const price = document.createElement('strong'); price.className = 'product-price'; price.textContent = CLP.format(product.price);
    const actions = document.createElement('div'); actions.className = 'product-actions'; const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'small-action'; edit.textContent = 'Editar'; edit.addEventListener('click', () => openProductDialog(product)); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'small-action delete'; remove.textContent = 'Eliminar'; remove.addEventListener('click', () => { if (confirm(`¿Eliminar “${product.name}” del catálogo? El historial de ventas se conservará.`) && Products.deactivate(product.id)) { renderCatalog(); Sales.loadDraft(byId('saleDate').value); showToast('Producto eliminado del catálogo'); } });
    actions.append(edit, remove); card.append(icon, info, price, actions); list.append(card);
  }
}
function setTab(tab) {
  activeTab = tab; const panels = { catalog: 'catalogPanel', sales: 'salesPanel', summary: 'summaryPanel' };
  Object.entries(panels).forEach(([key, id]) => byId(id).classList.toggle('hidden', key !== tab));
  document.querySelectorAll('.nav-item').forEach((button) => { const selected = button.dataset.tab === tab; button.classList.toggle('active', selected); if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (tab === 'sales') Sales.loadDraft(byId('saleDate').value); if (tab === 'summary') Reports.render(byId('reportMonth').value);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function openProductDialog(product = null) { byId('productForm').reset(); byId('productFormError').textContent = ''; byId('productId').value = product?.id || ''; byId('dialogTitle').textContent = product ? 'Editar producto' : 'Nuevo producto'; byId('productName').value = product?.name || ''; byId('productPrice').value = product?.price || ''; byId('productDialog').showModal(); setTimeout(() => byId('productName').focus(), 40); }

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.goto)));
document.querySelectorAll('.catalog-add-button').forEach((button) => button.addEventListener('click', () => openProductDialog()));
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => byId('productDialog').close()));
byId('productForm').addEventListener('submit', (event) => {
  event.preventDefault(); const name = byId('productName').value.trim(); const price = Number(byId('productPrice').value); const id = byId('productId').value;
  if (!name) { byId('productFormError').textContent = 'Escribe el nombre del producto.'; return; }
  if (!Number.isInteger(price) || price <= 0) { byId('productFormError').textContent = 'El precio debe ser un número entero mayor que cero.'; return; }
  try { const saved = id ? Products.edit(id, name, price) : Products.add(name, price); if (saved) { byId('productDialog').close(); renderCatalog(); Sales.loadDraft(byId('saleDate').value); showToast(id ? 'Producto actualizado' : 'Producto agregado'); } }
  catch (error) { byId('productFormError').textContent = error.message; }
});
byId('saleDate').value = todayISO(); byId('reportMonth').value = monthISO(); byId('saleDate').addEventListener('change', () => { Sales.loadDraft(byId('saleDate').value); byId('saleDateHint').textContent = 'Registra cada venta por separado; la jornada antigua se conserva como registro histórico.'; });
byId('saveSaleButton').addEventListener('click', () => { const date = byId('saleDate').value; const wasEditing = Boolean(editingSale); const result = Sales.saveEntry(date); if (result) { byId('saleDateHint').textContent = wasEditing ? 'Cambios guardados.' : 'Venta registrada. Puedes ingresar la siguiente.'; Reports.render(byId('reportMonth').value); showToast(wasEditing ? 'Cambios guardados' : 'Venta registrada'); } });
byId('cancelEditButton').addEventListener('click', () => Sales.cancelEdit());
byId('reportMonth').addEventListener('change', () => Reports.render(byId('reportMonth').value));
byId('dayReport').addEventListener('click', (event) => { const row = event.target.closest('.day-row'); if (!row) return; byId('saleDate').value = row.dataset.date; byId('saleDate').dispatchEvent(new Event('change')); setTab('sales'); });
byId('exportButton').addEventListener('click', () => { const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `delicias_saludables_de_sharito_respaldo_${todayISO()}.json`; link.click(); URL.revokeObjectURL(url); document.querySelector('.more-menu').open = false; showToast('Respaldo descargado'); });
byId('importButton').addEventListener('click', () => { byId('importFile').click(); document.querySelector('.more-menu').open = false; });
byId('importFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (imported?.schemaVersion !== 1 || !Array.isArray(imported.products) || !Array.isArray(imported.dailySales)) throw new Error('El archivo no tiene una estructura válida.');
    const validProducts = imported.products.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Number.isInteger(p.price) && p.price > 0 && Number.isInteger(p.packageGrams) && typeof p.active === 'boolean' && typeof p.createdAt === 'string');
    const validSales = imported.dailySales.every((s) => s && typeof s.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && Array.isArray(s.items) && Number.isInteger(s.totalAmount) && Number.isInteger(s.totalPackages) && typeof s.updatedAt === 'string' && s.items.every((i) => typeof i.productId === 'string' && typeof i.productName === 'string' && Number.isInteger(i.unitPrice) && Number.isInteger(i.quantity) && i.quantity > 0 && Number.isInteger(i.subtotal)));
    const incomingEntries = imported.saleEntries === undefined ? [] : imported.saleEntries;
    const validEntries = Array.isArray(incomingEntries) && incomingEntries.every((s) => s && typeof s.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time) && Array.isArray(s.items) && Number.isInteger(s.totalAmount) && Number.isInteger(s.totalPackages) && typeof s.createdAt === 'string' && typeof s.updatedAt === 'string' && s.items.every((i) => typeof i.productId === 'string' && typeof i.productName === 'string' && Number.isInteger(i.unitPrice) && i.unitPrice >= 0 && Number.isInteger(i.quantity) && i.quantity > 0 && Number.isInteger(i.subtotal) && i.subtotal === i.unitPrice * i.quantity)) && incomingEntries.every((s) => s.totalPackages === s.items.reduce((sum, i) => sum + i.quantity, 0) && s.totalAmount === s.items.reduce((sum, i) => sum + i.subtotal, 0)) && new Set(incomingEntries.map((sale) => sale.id)).size === incomingEntries.length;
    if (!validProducts || !validSales || !validEntries || new Set(imported.dailySales.map((sale) => sale.date)).size !== imported.dailySales.length) throw new Error('El archivo contiene datos incompletos o fechas duplicadas.');
    if (!confirm('Importar este respaldo reemplazará todos los datos guardados en este dispositivo. ¿Continuar?')) return;
    db = { schemaVersion: 1, products: imported.products, dailySales: imported.dailySales, saleEntries: incomingEntries };
    editingSale = null; editingItemSnapshots = new Map();
    if (Storage.save(db)) { renderCatalog(); Sales.loadDraft(byId('saleDate').value); Reports.render(byId('reportMonth').value); showToast('Respaldo importado'); }
  } catch (error) { alert(`No se pudo importar el respaldo: ${error.message}`); }
});

renderCatalog(); Sales.loadDraft(byId('saleDate').value); byId('saleDateHint').textContent = 'Nueva jornada para esta fecha.';
if ('serviceWorker' in navigator && location.protocol !== 'file:') window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('No se pudo registrar el modo sin conexión.', error)));


